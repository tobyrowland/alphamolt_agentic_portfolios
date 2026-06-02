"""Strategy registry for agent heartbeats.

Each strategy is a callable that takes a rebalance context and executes
trades via ``PortfolioManager``. New strategies register themselves in the
``STRATEGIES`` dict at the bottom of the module. Agents opt in by setting
``agents.strategy`` to the key.

Strategy contract:

    def rebalance(ctx: RebalanceContext) -> RebalanceResult: ...

A strategy should be **idempotent modulo price drift**: running it twice
back-to-back on an unchanged universe should be a no-op (no trades). This
keeps the heartbeat safe to retry and makes the journal useful.

Current strategies:
    dual_positive  — equal-weight the top N tickers where `bear` and `bull`
                     are both ✅, deduped by company, favouring US listings.
                     This is the rebalance version of build_portfolio.py.
    momentum       — low-churn momentum rebalance.
    llm_pick       — two-stage LLM-driven portfolio picker (llm_picker.py).
    trading_agents — TauricResearch/TradingAgents multi-agent framework.
    watchlist_curator — mandate-aware LLM curator for human portfolios; writes
                     a shortlist into portfolio_watchlist (source='agent').
    watchlist_buyer — mechanical buyer that equal-weights a portfolio's
                     watchlist and trades it, recording a thesis per buy.

Strategy phases (``STRATEGY_PHASES`` / ``strategy_phase``): a strategy is
either a ``'curate'`` strategy (it produces inputs other strategies consume —
today only ``watchlist_curator``) or a ``'trade'`` strategy (the default — it
places trades). The portfolio heartbeat runs all curate-phase members before
any trade-phase member so the curator's fresh shortlist is visible to the
buyer in the same heartbeat.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any, Callable

from db import SupabaseDB
from portfolio import PortfolioError, PortfolioManager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Strategy API
# ---------------------------------------------------------------------------


@dataclass
class RebalanceContext:
    """Inputs handed to every strategy."""

    db: SupabaseDB
    pm: PortfolioManager
    agent: dict
    dry_run: bool = False
    # Optional overrides (agents.config JSONB could feed these later).
    params: dict = field(default_factory=dict)
    # Set when the strategy operates a shared-pot human portfolio
    # (migration 025). None for legacy 1:1 agent portfolios — in which
    # case the facade below routes to the agent-keyed account.
    portfolio_id: str | None = None
    members: list[dict] | None = None
    mandate: str | None = None
    # Live execution (migration 036 + Alpaca). When mode == 'live' AND an
    # executor is wired (by agent_heartbeat, gated on a master env switch),
    # ctx.buy/sell place the REAL order first and record the ACTUAL fill,
    # instead of the paper RPC at companies.price. 'paper' (default) is the
    # unchanged simulated path. `executor` is an AlpacaExecutionBackend (typed
    # Any to avoid importing the broker layer into the paper path).
    mode: str = "paper"
    executor: Any = None

    # --- account-model-agnostic trading facade -------------------------
    # Strategies call ctx.buy / ctx.sell / ctx.get_book without caring
    # whether they operate an agent's own account or a shared human
    # portfolio. ``ctx.agent["id"]`` is always the executing agent.

    def buy(
        self,
        ticker: str,
        quantity: float,
        note: str = "",
        *,
        thesis: dict | None = None,
    ) -> dict:
        if self._is_live():
            return self._live_trade("buy", ticker, quantity, note, thesis)
        if self.portfolio_id:
            # Atomic RPC: holding-upsert + cash-decrement + trade-journal in
            # one Postgres transaction. The non-atomic `buy_portfolio` path
            # leaves partial state on failure (holding written, cash debited,
            # trade row never landed) — historically also seen tripping a
            # spurious ON CONFLICT error from PostgREST on the agent_trades
            # insert that has no easy reproduction.
            return self.pm.buy_portfolio_atomic(
                self.portfolio_id, self.agent["id"], ticker, quantity,
                note=note, thesis=thesis,
            )
        return self.pm.buy(
            self.agent["id"], ticker, quantity, note=note, thesis=thesis,
        )

    def sell(self, ticker: str, quantity: float, note: str = "") -> dict:
        if self._is_live():
            return self._live_trade("sell", ticker, quantity, note, None)
        if self.portfolio_id:
            return self.pm.sell_portfolio_atomic(
                self.portfolio_id, self.agent["id"], ticker, quantity,
                note=note,
            )
        return self.pm.sell(self.agent["id"], ticker, quantity, note=note)

    def _is_live(self) -> bool:
        """Route through the broker only for a live, executor-wired portfolio."""
        return bool(
            self.portfolio_id
            and self.mode == "live"
            and self.executor is not None
        )

    def _live_trade(
        self,
        side: str,
        ticker: str,
        quantity: float,
        note: str,
        thesis: dict | None,
    ) -> dict:
        """Place a REAL Alpaca order, then record the actual fill in the DB.

        Records the *filled* quantity at the *fill* price so the book matches
        the broker. If nothing filled (order rejected, or queued because the
        market is closed) it writes nothing — `sync_to_db` reconciles any
        queued fill on its next run. Hard-refuses during a dry run: a real
        order must never be a side effect of a plan-only pass.
        """
        if self.dry_run:
            raise RuntimeError(
                "refusing to place a live Alpaca order during a dry run"
            )
        # Intended price = the paper book's price for this ticker; the executor
        # caps the fill within its price band around it.
        try:
            ref_price = self.pm.get_price(ticker)
        except Exception:  # noqa: BLE001 — no price -> fall back to market order
            ref_price = None
        res = self.executor.execute_and_wait(
            ticker, side, quantity, allow_live=True, ref_price=ref_price,
        )
        if res.filled_qty <= 0:
            logger.warning(
                "LIVE %s %s x%s did not fill (%s) — DB unchanged; sync_to_db "
                "will reconcile any queued fill.",
                side, ticker, quantity, res.status,
            )
            return {
                "status": f"alpaca_{res.status}",
                "filled_qty": 0,
                "order_id": res.order_id,
            }
        live_note = f"{note} [alpaca {res.order_id}]".strip()
        if side == "buy":
            return self.pm.buy_portfolio_atomic(
                self.portfolio_id, self.agent["id"], ticker, res.filled_qty,
                note=live_note, thesis=thesis, price_override=res.avg_price,
            )
        return self.pm.sell_portfolio_atomic(
            self.portfolio_id, self.agent["id"], ticker, res.filled_qty,
            note=live_note, price_override=res.avg_price,
        )

    def get_book(self) -> dict:
        if self.portfolio_id:
            return self.pm.get_portfolio_book(self.portfolio_id)
        return self.pm.get_portfolio(self.agent["id"])


@dataclass
class RebalanceResult:
    """Structured return value for the orchestrator."""

    buys: int = 0
    sells: int = 0
    notes: dict = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def trades(self) -> int:
        return self.buys + self.sells


Strategy = Callable[[RebalanceContext], RebalanceResult]


# ---------------------------------------------------------------------------
# Shared helpers (mirrors build_portfolio.py — kept inline to avoid coupling
# the strategy to the legacy script's argparse/logging plumbing)
# ---------------------------------------------------------------------------


US_EXCHANGES = {"NYSE", "NASDAQ", "AMEX", "NYSEARCA", "BATS", "ARCA"}

_CORPORATE_SUFFIXES = re.compile(
    r"\b("
    r"inc|incorporated|corp|corporation|ltd|limited|llc|plc|"
    r"sa|s\.a\.|se|s\.e\.|nv|n\.v\.|ag|a\.g\.|"
    r"co|company|group|holdings|holding|enterprises|"
    r"international|intl|technologies|technology|tech|"
    r"systems|solutions|therapeutics|pharmaceuticals|pharma|"
    r"biosciences|biopharma|medical|healthcare|"
    r"class\s*[a-z]|cl\s*[a-z]|adr"
    r")\b",
    re.IGNORECASE,
)

FUZZY_THRESHOLD = 0.80


def _normalise_company(name: str) -> str:
    s = (name or "").strip().upper()
    s = _CORPORATE_SUFFIXES.sub("", s)
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _names_match(a: str, b: str) -> bool:
    na, nb = _normalise_company(a), _normalise_company(b)
    if na and na == nb:
        return True
    if na and nb:
        shorter, longer = sorted([na, nb], key=len)
        if longer.startswith(shorter) and len(shorter) >= 3:
            return True
    return SequenceMatcher(None, na, nb).ratio() >= FUZZY_THRESHOLD


def _is_us(exchange: Any) -> bool:
    return str(exchange or "").strip().upper() in US_EXCHANGES


def _pick_best(group: list[dict]) -> dict:
    if len(group) == 1:
        return group[0]
    us = [c for c in group if _is_us(c.get("exchange"))]
    pool = us or group
    return max(
        pool,
        key=lambda c: SupabaseDB.safe_float(c.get("composite_score")) or 0.0,
    )


def _dedupe_by_company(rows: list[dict]) -> list[dict]:
    out: list[dict] = []
    used = [False] * len(rows)
    for i, row in enumerate(rows):
        if used[i]:
            continue
        group = [row]
        used[i] = True
        for j in range(i + 1, len(rows)):
            if used[j]:
                continue
            if _names_match(row.get("company_name", ""), rows[j].get("company_name", "")):
                group.append(rows[j])
                used[j] = True
        out.append(_pick_best(group))
    return out


# ---------------------------------------------------------------------------
# Trade-note formatters
# ---------------------------------------------------------------------------
#
# Each live trade gets a short rationale string written to
# ``agent_trades.note``. These are plain English, ~10–20 words, derived
# from the same data the strategy already looked at — no LLM calls. The
# UI can render them verbatim so users can see *why* each trade happened.


def _fmt_pct(x: float | None) -> str:
    """Format a fraction like 0.321 as '+32%'. Returns '?' if None."""
    if x is None:
        return "?"
    return f"{x * 100:+.0f}%"


def _fmt_rating(x: float | None) -> str:
    if x is None:
        return "?"
    return f"{x:.1f}"


def _format_momentum_sell_note(
    ticker: str,
    meta: dict,
    reasons: list[str],
    params: dict,
) -> str:
    """Human-readable rationale for a momentum-strategy sell."""
    rating = meta.get("rating")
    perf = meta.get("perf_52w_vs_spy")
    floor = float(params["momentum_floor"])
    ceiling = float(params["rating_ceiling"])

    parts: list[str] = []
    for r in reasons:
        if r.startswith("rating>"):
            parts.append(f"rating {_fmt_rating(rating)} breached {ceiling:.1f} ceiling")
        elif r == "bear_flipped_red":
            parts.append("bear flipped ❌")
        elif r.startswith("becalmed_below_"):
            parts.append(
                f"dropped from eligible set, momentum {_fmt_pct(perf)} below {floor * 100:.0f}% floor"
            )
    if not parts:
        parts.append("rebalance exit")
    return f"Sold {ticker} — {'; '.join(parts)}."


def _format_momentum_buy_note(ticker: str, meta: dict, rank: int) -> str:
    """Human-readable rationale for a momentum-strategy buy."""
    perf = meta.get("perf_52w_vs_spy")
    rating = meta.get("rating")
    return (
        f"Bought {ticker} — {_fmt_pct(perf)} vs SPY, rating {_fmt_rating(rating)}, "
        f"dual ✅ (#{rank} momentum)."
    )


def _format_dual_positive_sell_note(ticker: str, reason: str) -> str:
    """Human-readable rationale for a dual_positive-strategy sell."""
    if reason == "dropped_from_top_n":
        return f"Sold {ticker} — no longer in top-N dual-positive set."
    if reason == "trim_overweight":
        return f"Sold {ticker} — trimming overweight position to target weight."
    return f"Sold {ticker} — rebalance."


def _format_dual_positive_buy_note(
    ticker: str,
    composite_score: float | None,
    rank: int,
) -> str:
    """Human-readable rationale for a dual_positive-strategy buy."""
    score_part = (
        f"composite score {composite_score:.2f}"
        if composite_score is not None
        else "composite score unknown"
    )
    return f"Bought {ticker} — dual ✅, {score_part} (#{rank} in universe)."


# ---------------------------------------------------------------------------
# Strategy: dual_positive
# ---------------------------------------------------------------------------


DUAL_POSITIVE_DEFAULTS = {
    "max_positions": 20,       # top-N deduped dual-positive tickers
    "cash_reserve_pct": 0.02,  # keep 2% cash to absorb rounding / price drift
    "min_trade_usd": 500.0,    # ignore rebalance deltas below this notional
}


def _target_tickers(db: SupabaseDB, params: dict) -> list[dict]:
    """Return the top-N dual-positive companies, deduped, score-sorted."""
    all_companies = db.get_all_companies()
    dual_positive = [
        c for c in all_companies
        if "✅" in str(c.get("bear_eval") or "")
        and "✅" in str(c.get("bull_eval") or "")
        and c.get("ticker")
    ]
    dual_positive = _dedupe_by_company(dual_positive)
    dual_positive.sort(
        key=lambda c: SupabaseDB.safe_float(c.get("composite_score")) or 0.0,
        reverse=True,
    )
    n = int(params.get("max_positions", DUAL_POSITIVE_DEFAULTS["max_positions"]))
    return dual_positive[:n]


def rebalance_dual_positive(ctx: RebalanceContext) -> RebalanceResult:
    """Equal-weight the top-N dual-positive tickers.

    Algorithm:
        1. Fetch target set (dual ✅, deduped, score-sorted, top-N).
        2. Price every target; drop tickers with no usable price.
        3. Compute total portfolio value (cash + MTM) and per-target
           allocation = total * (1 - cash_reserve) / len(targets).
        4. For each current holding not in the target set → sell in full.
        5. For each target, compute desired qty = alloc / price. Sell excess
           first (to free cash), then buy shortfalls. Trades smaller than
           ``min_trade_usd`` are skipped as noise.
    """
    result = RebalanceResult()
    params = {**DUAL_POSITIVE_DEFAULTS, **(ctx.params or {})}
    agent_id = ctx.agent["id"]
    handle = ctx.agent.get("handle", agent_id[:8])

    targets = _target_tickers(ctx.db, params)
    if not targets:
        result.notes["reason"] = "no dual-positive tickers found"
        return result

    # Price every candidate; skip unpriced ones rather than aborting.
    # Keep each candidate's rank (1-based, by composite_score desc) and
    # composite_score alongside so the live branch can format notes.
    priced: list[tuple[str, float]] = []
    target_meta: dict[str, dict] = {}
    unpriced: list[str] = []
    for rank_idx, c in enumerate(targets, start=1):
        t = c["ticker"]
        try:
            price = ctx.pm.get_price(t)
        except PortfolioError:
            unpriced.append(t)
            continue
        priced.append((t, price))
        target_meta[t] = {
            "composite_score": SupabaseDB.safe_float(c.get("composite_score")),
            "rank": rank_idx,
        }
    if unpriced:
        result.notes["unpriced"] = unpriced
    if not priced:
        result.notes["reason"] = "no priced targets"
        return result

    target_tickers = {t for t, _ in priced}
    price_map = dict(priced)

    # Snapshot: compute current total value.
    portfolio = ctx.get_book()
    total_value = portfolio["total_value_usd"]
    if total_value <= 0:
        result.errors.append(f"total_value_usd <= 0 for agent {handle}")
        return result

    cash_reserve = float(params["cash_reserve_pct"])
    investable = total_value * (1.0 - cash_reserve)
    per_target_usd = investable / len(priced)
    min_trade = float(params["min_trade_usd"])

    # Desired quantity per target. Floor to integer shares (no fractional
    # lots for v1). Tickers priced above per_target_usd get qty=0 and will
    # simply not be bought — the reserve absorbs the leftover.
    desired_qty: dict[str, int] = {
        t: int(math.floor(per_target_usd / p)) for t, p in priced
    }

    current_qty: dict[str, float] = {
        h["ticker"]: float(h["quantity"]) for h in portfolio["holdings"]
    }

    # --- Phase 1: sell positions no longer in target set, and trim overshoots.
    # Sells before buys so cash is available for rotations.
    sells: list[tuple[str, float, str]] = []
    buys: list[tuple[str, int]] = []

    for ticker, held in current_qty.items():
        want = desired_qty.get(ticker, 0) if ticker in target_tickers else 0
        delta = held - want  # positive → need to sell
        if delta <= 0:
            continue
        # Price may be missing for a stale holding; PortfolioManager will raise.
        # Use the company's current price if we have it, else let sell() try.
        px = price_map.get(ticker)
        if px is None:
            try:
                px = ctx.pm.get_price(ticker)
            except PortfolioError:
                result.notes.setdefault("unpriced_holdings", []).append(ticker)
                continue
        if delta * px < min_trade and ticker in target_tickers:
            # Noise trim within an existing position — skip.
            continue
        reason = "dropped_from_top_n" if ticker not in target_tickers else "trim_overweight"
        sells.append((ticker, delta, reason))

    for ticker, price in priced:
        held = current_qty.get(ticker, 0.0)
        want = desired_qty[ticker]
        delta = want - held
        if delta <= 0:
            continue
        if delta * price < min_trade:
            continue
        buys.append((ticker, int(delta)))

    # --- Execute
    if ctx.dry_run:
        result.notes["dry_run_plan"] = {
            "sells": [
                {"ticker": t, "qty": q, "reason": r} for (t, q, r) in sells
            ],
            "buys": [
                {
                    "ticker": t,
                    "qty": q,
                    "composite_score": target_meta.get(t, {}).get("composite_score"),
                    "rank": target_meta.get(t, {}).get("rank"),
                }
                for (t, q) in buys
            ],
            "targets": len(priced),
            "per_target_usd": round(per_target_usd, 2),
            "total_value_usd": total_value,
        }
        logger.info(
            "[dry-run] %s: %d sells, %d buys, target=%d, total=$%.2f",
            handle, len(sells), len(buys), len(priced), total_value,
        )
        return result

    for ticker, qty, reason in sells:
        note = _format_dual_positive_sell_note(ticker, reason)
        try:
            ctx.sell(ticker, qty, note=note)
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"sell {ticker} x{qty}: {exc}")

    for ticker, qty in buys:
        meta = target_meta.get(ticker, {})
        note = _format_dual_positive_buy_note(
            ticker,
            meta.get("composite_score"),
            meta.get("rank") or 0,
        )
        try:
            ctx.buy(ticker, qty, note=note)
            result.buys += 1
        except PortfolioError as exc:
            # Insufficient cash is the most likely failure mode (prices drift
            # between the plan and execution). Log and continue — partial
            # rebalance is better than aborting.
            result.errors.append(f"buy {ticker} x{qty}: {exc}")

    result.notes["targets"] = len(priced)
    result.notes["per_target_usd"] = round(per_target_usd, 2)
    result.notes["total_value_usd"] = total_value
    return result


# ---------------------------------------------------------------------------
# Strategy: momentum
# ---------------------------------------------------------------------------


MOMENTUM_DEFAULTS = {
    "min_positions": 15,       # soft floor — ramp aggressively while below
    "max_sells_per_heartbeat": 2,
    "max_buys_per_heartbeat": 2,
    "cash_reserve_pct": 0.02,
    "min_trade_usd": 500.0,
    # Eligible-universe band for perf_52w_vs_spy.
    "momentum_floor": -0.15,
    "momentum_ceiling": 0.40,
    # Extra gate on new entries: must be at least this strong vs SPY.
    "momentum_min_for_entry": 0.0,
    # Exit guard: rating strictly greater than this triggers a sell.
    "rating_ceiling": 1.6,
}


def _eligible_momentum(db: SupabaseDB, params: dict) -> list[dict]:
    """Return the momentum-ranked eligible set.

    A ticker is eligible if all hold:
        - bear_eval contains ✅ and bull_eval contains ✅
        - rating is not null and <= rating_ceiling
        - exchange ∈ US_EXCHANGES (v1 prices are USD-flat; skip foreign dups)
        - perf_52w_vs_spy is not null and ∈ [momentum_floor, momentum_ceiling]

    Deduped by company (US-listing preferred anyway), sorted by
    perf_52w_vs_spy descending.
    """
    floor = float(params["momentum_floor"])
    ceiling = float(params["momentum_ceiling"])
    rating_ceiling = float(params["rating_ceiling"])

    eligible: list[dict] = []
    for c in db.get_all_companies():
        if not c.get("ticker"):
            continue
        if "✅" not in str(c.get("bear_eval") or ""):
            continue
        if "✅" not in str(c.get("bull_eval") or ""):
            continue
        if not _is_us(c.get("exchange")):
            continue
        rating = SupabaseDB.safe_float(c.get("rating"))
        if rating is None or rating > rating_ceiling:
            continue
        perf = SupabaseDB.safe_float(c.get("perf_52w_vs_spy"))
        if perf is None or perf < floor or perf > ceiling:
            continue
        eligible.append(c)

    eligible = _dedupe_by_company(eligible)
    eligible.sort(
        key=lambda c: SupabaseDB.safe_float(c.get("perf_52w_vs_spy")) or 0.0,
        reverse=True,
    )
    return eligible


def rebalance_momentum(ctx: RebalanceContext) -> RebalanceResult:
    """Low-churn momentum rebalance.

    Phase 1 — sell only the becalmed. A current holding is sold in full iff
    any of:
        (a) it's no longer in the eligible universe AND its
            perf_52w_vs_spy is < momentum_floor (becalmed drift),
        (b) its rating has risen above rating_ceiling,
        (c) its bear_eval has flipped to ❌.
    Missing perf data (NULL) does NOT trigger a sell — the holding is
    preserved until the scoring pipeline repopulates it.

    Sells are capped at max_sells_per_heartbeat; if more qualify, the two
    with the lowest perf_52w_vs_spy go first and the rest land in
    notes["deferred_sells"] for visibility.

    Phase 2 — redeploy freed cash into top momentum names. No upper bound
    on holdings: by default the agent buys ``max_buys_per_heartbeat`` new
    names per run. While ``len(holdings_after_sells) < min_positions`` the
    cap is lifted to ``min_positions - holdings_after_sells`` so the agent
    ramps to the floor quickly — the eligibility filter still applies, so
    if the universe is too thin the agent stays short of the floor (no
    forced buys of low-quality names). Entries must have
    perf_52w_vs_spy >= momentum_min_for_entry. Freed cash is equal-weighted
    across the new buys with a cash_reserve_pct buffer.

    Idempotence: at or above the floor on an unchanged universe, a second
    run produces 0/0.
    """
    result = RebalanceResult()
    params = {**MOMENTUM_DEFAULTS, **(ctx.params or {})}
    agent_id = ctx.agent["id"]
    handle = ctx.agent.get("handle", agent_id[:8])

    eligible = _eligible_momentum(ctx.db, params)
    eligible_by_ticker = {c["ticker"]: c for c in eligible}

    portfolio = ctx.get_book()
    holdings = portfolio["holdings"]
    total_value = portfolio["total_value_usd"]
    if total_value <= 0:
        result.errors.append(f"total_value_usd <= 0 for agent {handle}")
        return result

    rating_ceiling = float(params["rating_ceiling"])
    momentum_floor = float(params["momentum_floor"])

    # --- Phase 1: classify current holdings.
    momentum_snapshot: list[dict] = []
    sell_candidates: list[tuple[str, float, str]] = []  # (ticker, perf, reason)
    # Per-holding metadata for note formatting and snapshot reuse.
    holding_meta: dict[str, dict] = {}

    for h in holdings:
        ticker = h["ticker"]
        company = ctx.db.get_company(ticker)
        perf = (
            SupabaseDB.safe_float(company.get("perf_52w_vs_spy"))
            if company else None
        )
        rating = (
            SupabaseDB.safe_float(company.get("rating"))
            if company else None
        )
        bear_flipped = (
            company is not None
            and "❌" in str(company.get("bear_eval") or "")
        )
        momentum_snapshot.append(
            {"ticker": ticker, "perf_52w_vs_spy": perf, "rating": rating}
        )

        reasons: list[str] = []
        if rating is not None and rating > rating_ceiling:
            reasons.append(f"rating>{rating_ceiling}")
        if bear_flipped:
            reasons.append("bear_flipped_red")
        if (
            ticker not in eligible_by_ticker
            and perf is not None
            and perf < momentum_floor
        ):
            reasons.append(f"becalmed_below_{momentum_floor}")

        holding_meta[ticker] = {
            "perf_52w_vs_spy": perf,
            "rating": rating,
            "bear_red": bear_flipped,
            "reasons": reasons,
        }

        if reasons:
            # Missing perf sorts last; we never want to sell a NULL-perf
            # position unless rating/bear forced it, and even then we want
            # forced sells to rank above purely-becalmed ones.
            sell_candidates.append(
                (ticker, perf if perf is not None else float("inf"), ";".join(reasons))
            )

    # Cap at max_sells_per_heartbeat, prioritising the lowest perf.
    max_sells = int(params["max_sells_per_heartbeat"])
    sell_candidates.sort(key=lambda s: s[1])
    planned_sells = sell_candidates[:max_sells]
    deferred_sells = [
        {"ticker": t, "perf_52w_vs_spy": p if p != float("inf") else None, "reason": r}
        for (t, p, r) in sell_candidates[max_sells:]
    ]

    # --- Phase 2: buys. Compute available slots BEFORE executing sells
    # (we know exactly what will be sold). No upper bound on positions:
    # default cap is ``max_buys_per_heartbeat``, lifted to fill to the
    # floor quickly when below it.
    held_tickers = {h["ticker"] for h in holdings}
    tickers_after_sells = held_tickers - {t for (t, _, _) in planned_sells}
    holdings_after_sells = len(tickers_after_sells)
    min_positions = int(params["min_positions"])
    base_max_buys = int(params["max_buys_per_heartbeat"])
    if holdings_after_sells < min_positions:
        max_buys = max(base_max_buys, min_positions - holdings_after_sells)
    else:
        max_buys = base_max_buys

    momentum_min_for_entry = float(params["momentum_min_for_entry"])
    min_trade = float(params["min_trade_usd"])
    cash_reserve = float(params["cash_reserve_pct"])

    # Candidate buys: top of eligible, not already held, above entry floor.
    # Price them; skip unpriced. Carry per-candidate metadata for the note
    # formatter and the dry-run plan.
    buy_candidates: list[dict] = []
    unpriced: list[str] = []
    for rank_idx, c in enumerate(eligible, start=1):
        if len(buy_candidates) >= max_buys:
            break
        t = c["ticker"]
        if t in tickers_after_sells:
            continue
        perf = SupabaseDB.safe_float(c.get("perf_52w_vs_spy"))
        if perf is None or perf < momentum_min_for_entry:
            continue
        try:
            price = ctx.pm.get_price(t)
        except PortfolioError:
            unpriced.append(t)
            continue
        buy_candidates.append(
            {
                "ticker": t,
                "price": price,
                "perf_52w_vs_spy": perf,
                "rating": SupabaseDB.safe_float(c.get("rating")),
                "rank": rank_idx,
            }
        )
    if unpriced:
        result.notes["unpriced"] = unpriced

    # Estimate free cash post-sell. We don't have exact fill prices yet, so
    # use current market price for the planned sells.
    cash = float(portfolio["cash_usd"])
    sell_proceeds_estimate = 0.0
    for sell_ticker, _perf, _reason in planned_sells:
        held_qty = next(
            (float(h["quantity"]) for h in holdings if h["ticker"] == sell_ticker),
            0.0,
        )
        try:
            px = ctx.pm.get_price(sell_ticker)
            sell_proceeds_estimate += held_qty * px
        except PortfolioError:
            # Unpriceable holding — sell will fail too. Leave it out of
            # the cash estimate and let the live branch record the error.
            pass
    free_cash = cash + sell_proceeds_estimate
    investable = free_cash * (1.0 - cash_reserve)

    per_target_usd = (
        investable / len(buy_candidates) if buy_candidates else 0.0
    )

    # buys: list of (ticker, qty, buy_candidate_dict) so the live branch
    # can format a data-rich note without re-looking-up the company.
    buys: list[tuple[str, int, dict]] = []
    for bc in buy_candidates:
        price = bc["price"]
        qty = int(math.floor(per_target_usd / price)) if price > 0 else 0
        if qty <= 0:
            continue
        if qty * price < min_trade:
            continue
        buys.append((bc["ticker"], qty, bc))

    # --- Dry-run: serialise the plan and return.
    if ctx.dry_run:
        result.notes["dry_run_plan"] = {
            "sells": [
                {"ticker": t, "perf_52w_vs_spy": (p if p != float("inf") else None), "reason": r}
                for (t, p, r) in planned_sells
            ],
            "buys": [
                {
                    "ticker": t,
                    "qty": q,
                    "perf_52w_vs_spy": bc.get("perf_52w_vs_spy"),
                    "rating": bc.get("rating"),
                    "rank": bc.get("rank"),
                }
                for (t, q, bc) in buys
            ],
            "per_target_usd": round(per_target_usd, 2),
            "total_value_usd": total_value,
            "free_cash_post_sell_estimate": round(free_cash, 2),
            "min_positions": min_positions,
            "holdings_after_sells": holdings_after_sells,
            "max_buys_this_run": max_buys,
        }
        if deferred_sells:
            result.notes["deferred_sells"] = deferred_sells
        result.notes["momentum_snapshot"] = momentum_snapshot
        result.notes["eligible_snapshot"] = [
            {
                "ticker": c["ticker"],
                "perf_52w_vs_spy": SupabaseDB.safe_float(c.get("perf_52w_vs_spy")),
                "rating": SupabaseDB.safe_float(c.get("rating")),
            }
            # Show enough of the ranked universe to debug "why didn't it
            # buy X?" without dumping the whole table.
            for c in eligible[: max(min_positions * 2, 30)]
        ]
        logger.info(
            "[dry-run] %s: %d sells, %d buys, eligible=%d, total=$%.2f",
            handle, len(planned_sells), len(buys), len(eligible), total_value,
        )
        return result

    # --- Live: execute sells first, then buys.
    for ticker, _perf, reason in planned_sells:
        held_qty = next(
            (float(h["quantity"]) for h in holdings if h["ticker"] == ticker),
            0.0,
        )
        if held_qty <= 0:
            continue
        meta = holding_meta.get(ticker, {})
        note = _format_momentum_sell_note(
            ticker, meta, meta.get("reasons", []), params,
        )
        try:
            ctx.sell(ticker, held_qty, note=note)
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"sell {ticker} x{held_qty}: {exc}")

    for ticker, qty, bc in buys:
        note = _format_momentum_buy_note(ticker, bc, bc["rank"])
        try:
            ctx.buy(ticker, qty, note=note)
            result.buys += 1
        except PortfolioError as exc:
            # Most likely: price drift between plan and fill left us short
            # of cash for the last buy. Partial fill is acceptable.
            result.errors.append(f"buy {ticker} x{qty}: {exc}")

    result.notes["eligible_count"] = len(eligible)
    result.notes["per_target_usd"] = round(per_target_usd, 2)
    result.notes["total_value_usd"] = total_value
    if deferred_sells:
        result.notes["deferred_sells"] = deferred_sells
    return result


# ---------------------------------------------------------------------------
# Strategy: watchlist_curator
# ---------------------------------------------------------------------------
#
# The curator half of the two-agent pipeline for human-owned portfolios.
# It screens the daily compact universe snapshot against the portfolio's
# free-text mandate via an LLM, then writes the result into
# portfolio_watchlist as the portfolio's source='agent' rows. The buyer
# strategy (watchlist_buyer) trades from that list later in the same
# heartbeat — the heartbeat runs curate-phase strategies before trade-phase
# ones (see STRATEGY_PHASES below).


WATCHLIST_CURATOR_DEFAULTS = {
    "watchlist_size": 20,        # target shortlist length (~15-25)
    # 65536 = Gemini 2.5 Flash's hard output ceiling. Set this high because
    # 2.5 Flash's "thinking" tokens count toward max_output_tokens — a small
    # budget (e.g. 16384) leaves ~600 tokens of actual output after thinking,
    # which truncates a 40-name JSON array mid-stream. Other providers
    # ignore tokens they don't need; only the actual output is billed.
    "max_tokens": 65536,
    "temperature": 0.2,
}


WATCHLIST_CURATOR_SYSTEM_PROMPT = """\
You are an equity research analyst curating a watchlist for a $1M paper-money portfolio.

You will be given:
1. A universe of screened companies with their current fundamentals.
2. The portfolio's investment mandate (the human owner's brief).

Your task: pick the tickers that best fit the mandate — a focused shortlist a buyer agent will then equal-weight and trade. Be selective and mandate-driven; this is a shortlist, not the whole universe.

Output strict JSON only. No prose, no markdown fences."""


WATCHLIST_CURATOR_USER_TEMPLATE = """\
{mandate_block}UNIVERSE (compact tier, snapshot {snapshot_date}):
{universe_json}

CURRENT PORTFOLIO:
{portfolio_json}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "shortlist": [
    {{"ticker": "XXX", "rationale": "<10-20 word reason this fits the mandate>"}}
  ]
}}

Pick {shortlist_max} tickers (fewer is fine if you can't justify {shortlist_max}).
Only tickers from the universe above are valid. Output JSON only."""


def rebalance_watchlist_curator(ctx: RebalanceContext) -> RebalanceResult:
    """Mandate-aware LLM curator — writes portfolio_watchlist source='agent' rows.

    Lazy-imports the llm_picker machinery (and through it the LLM SDKs) so
    the dependency only matters for runs that actually curate — momentum /
    dual_positive heartbeats stay independent.

    Defensive by contract: a missing snapshot, an LLM/provider error, or a
    parse failure are all captured into ``result.errors`` / ``result.notes``
    — the function never raises, so the heartbeat cannot crash on it.
    """
    result = RebalanceResult()
    params = {**WATCHLIST_CURATOR_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    # Only meaningful for a shared human portfolio — there is no watchlist
    # to curate for a legacy 1:1 agent account.
    if not ctx.portfolio_id:
        result.notes["reason"] = "watchlist_curator only runs on a human portfolio"
        return result

    # Reuse llm_picker's snapshot loader + provider/model + LLM-call code.
    try:
        from llm_picker import (
            _filter_snapshot_us_only,
            _load_latest_snapshot,
            _mandate_block,
            _us_listed_tickers,
            pick_shortlist_via_llm,
        )
        from llm_providers import LLMProviderError, PROVIDERS
    except ImportError as exc:  # pragma: no cover — defensive
        result.errors.append(f"watchlist_curator import failed: {exc}")
        return result

    provider = params.get("provider")
    model = params.get("model")
    if not provider or provider not in PROVIDERS:
        result.errors.append(
            f"agents.config.provider missing or invalid (got {provider!r}). "
            f"Expected one of: {', '.join(PROVIDERS)}"
        )
        return result
    if not model:
        result.errors.append("agents.config.model missing")
        return result

    # Load the compact universe snapshot, filtered to US-listed tickers
    # (same currency caveat the llm_pick strategy guards against).
    snap_row = _load_latest_snapshot(ctx.db, "compact")
    if not snap_row:
        result.errors.append(
            "no compact universe snapshot. Build one via build_universe_snapshot.py."
        )
        return result
    us_tickers = _us_listed_tickers(ctx.db)
    snapshot_json = _filter_snapshot_us_only(snap_row["json"], us_tickers)
    snapshot_date = snap_row["snapshot_date"]
    universe_tickers = {
        str(t.get("ticker") or "").upper()
        for t in (snapshot_json.get("tickers") or [])
        if t.get("ticker")
    }
    if not universe_tickers:
        result.errors.append("compact snapshot has no US-listed tickers")
        return result

    portfolio = ctx.get_book()
    portfolio_summary = {
        "cash_usd": round(float(portfolio["cash_usd"]), 2),
        "total_value_usd": round(float(portfolio["total_value_usd"]), 2),
        "holdings": [
            {"ticker": h["ticker"], "quantity": float(h["quantity"])}
            for h in portfolio["holdings"]
        ],
    }

    watchlist_size = int(params["watchlist_size"])
    notes: dict[str, Any] = {
        "snapshot_date": snapshot_date,
        "provider": provider,
        "model": model,
        "watchlist_size": watchlist_size,
        "has_mandate": bool(ctx.mandate),
    }

    # Call the LLM via the same reusable shortlist helper llm_pick stage 1
    # uses — validates each ticker against the universe, dedupes, caps.
    try:
        raw_text, shortlist, dropped, usage, retry_text = pick_shortlist_via_llm(
            provider=provider,
            model=model,
            snapshot=snapshot_json,
            snapshot_date=snapshot_date,
            portfolio=portfolio_summary,
            universe_tickers=universe_tickers,
            system_prompt=WATCHLIST_CURATOR_SYSTEM_PROMPT,
            user_template=WATCHLIST_CURATOR_USER_TEMPLATE,
            shortlist_max=watchlist_size,
            max_tokens=int(params["max_tokens"]),
            temperature=float(params["temperature"]),
            mandate_block=_mandate_block(ctx.mandate),
        )
    except LLMProviderError as exc:
        result.errors.append(f"curator LLM call failed: {exc}")
        notes["llm_error"] = str(exc)
        result.notes = notes
        return result
    except Exception as exc:  # noqa: BLE001 — never crash the heartbeat
        result.errors.append(f"curator unexpected error: {exc}")
        notes["error"] = str(exc)
        result.notes = notes
        return result

    notes["shortlist"] = shortlist
    notes["shortlist_count"] = len(shortlist)
    notes["dropped_invalid_tickers"] = dropped
    notes["raw_response"] = raw_text[:8000]
    notes["raw_response_retry"] = retry_text[:8000] if retry_text else None
    notes["input_tokens"] = usage[0]
    notes["output_tokens"] = usage[1]

    if not shortlist:
        result.errors.append("curator LLM returned an empty shortlist")
        result.notes = notes
        return result

    # Defence-in-depth: pick_shortlist_via_llm already filters to the
    # snapshot's universe, but re-confirm each ticker exists in companies
    # (the snapshot could lag a freshly-delisted name).
    valid_tickers = ctx.db.get_all_tickers()
    items = [
        {"ticker": p["ticker"], "rationale": p.get("rationale") or ""}
        for p in shortlist
        if p["ticker"] in valid_tickers
    ]
    missing = [p["ticker"] for p in shortlist if p["ticker"] not in valid_tickers]
    if missing:
        notes["dropped_not_in_companies"] = missing
    if not items:
        result.errors.append("curator shortlist had no tickers in `companies`")
        result.notes = notes
        return result

    if ctx.dry_run:
        notes["dry_run_plan"] = {
            "would_write": items,
            "count": len(items),
        }
        logger.info(
            "[dry-run] %s: curated %d watchlist tickers (%s)",
            handle, len(items), provider,
        )
        result.notes = notes
        return result

    # Replace the portfolio's agent-sourced watchlist rows. The owner's
    # manual source='user' rows are never touched.
    try:
        ctx.db.replace_agent_watchlist(ctx.portfolio_id, ctx.agent["id"], items)
    except Exception as exc:  # noqa: BLE001 — never crash the heartbeat
        result.errors.append(f"watchlist write failed: {exc}")
        result.notes = notes
        return result

    notes["watchlist_written"] = len(items)
    logger.info("%s: wrote %d watchlist tickers", handle, len(items))
    result.notes = notes
    return result


# ---------------------------------------------------------------------------
# Strategy: watchlist_buyer
# ---------------------------------------------------------------------------
#
# The buyer half of the pipeline. Closely modelled on rebalance_dual_positive
# — equal-weight, diff vs book, sells-before-buys, dry-run plan, idempotent —
# but the candidate set is the portfolio's watchlist (all rows, source
# 'agent' AND 'user') rather than the dual-positive screen. Each buy passes a
# thesis kwarg so an investment thesis is recorded.


WATCHLIST_BUYER_DEFAULTS = {
    "cash_reserve_pct": 0.02,  # keep 2% cash to absorb rounding / price drift
    "min_trade_usd": 500.0,    # ignore rebalance deltas below this notional
}


def _format_watchlist_sell_note(ticker: str) -> str:
    return f"Sold {ticker} — no longer on the portfolio watchlist."


def _format_watchlist_buy_note(ticker: str, rationale: str | None) -> str:
    if rationale:
        return f"Bought {ticker} — watchlist pick: {rationale}"
    return f"Bought {ticker} — equal-weight watchlist pick."


def rebalance_watchlist_buyer(ctx: RebalanceContext) -> RebalanceResult:
    """Equal-weight the portfolio's watchlist and trade towards it.

    Candidate set is every ``portfolio_watchlist`` row for the portfolio —
    both the owner's manual ``source='user'`` picks and the curator's
    ``source='agent'`` picks. Algorithm mirrors ``rebalance_dual_positive``:

        1. Read the watchlist; price every ticker, drop the unpriced.
        2. Equal-weight: per-target = total * (1 - cash_reserve) / N.
        3. Sell holdings no longer on the watchlist (and trim overweights).
        4. Buy watchlist tickers up to their target qty.

    Sells run before buys so cash is freed for rotations. Trades below
    ``min_trade_usd`` are skipped as noise, which keeps a back-to-back rerun
    on an unchanged watchlist a no-op modulo price drift. Each buy passes a
    ``thesis`` kwarg so an ``investment_theses`` row is recorded — using the
    watchlist row's ``rationale`` as the thesis text when present.
    """
    result = RebalanceResult()
    params = {**WATCHLIST_BUYER_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    if not ctx.portfolio_id:
        result.notes["reason"] = "watchlist_buyer only runs on a human portfolio"
        return result

    watchlist = ctx.db.get_portfolio_watchlist(ctx.portfolio_id)
    # Dedupe by ticker (a ticker could in principle appear once per source);
    # the (portfolio_id, ticker) PK makes that impossible today, but keep the
    # buyer robust. Prefer a row that carries a rationale.
    rationale_for: dict[str, str | None] = {}
    for row in watchlist:
        ticker = str(row.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        rationale = (row.get("rationale") or "").strip() or None
        if ticker not in rationale_for or (
            rationale and not rationale_for.get(ticker)
        ):
            rationale_for[ticker] = rationale
    watchlist_tickers = list(rationale_for.keys())

    if not watchlist_tickers:
        result.notes["reason"] = "portfolio watchlist is empty"
        return result

    # 90-day re-buy cooldown — drop tickers the portfolio sold recently.
    # Mirrors the LLM buyer's behaviour. Stops the buyer from churning
    # back into a name the owner or reviewer just exited.
    recently_sold = ctx.db.get_recently_sold_tickers(ctx.portfolio_id, days=90)
    if recently_sold:
        skipped = [t for t in watchlist_tickers if t in recently_sold]
        if skipped:
            result.notes["skipped_recent_sell_cooldown"] = skipped
        watchlist_tickers = [
            t for t in watchlist_tickers if t not in recently_sold
        ]
        if not watchlist_tickers:
            result.notes["reason"] = (
                "watchlist all on 90-day cooldown after recent sells"
            )
            return result

    # Price every candidate; skip unpriced ones rather than aborting.
    priced: list[tuple[str, float]] = []
    unpriced: list[str] = []
    for ticker in watchlist_tickers:
        try:
            price = ctx.pm.get_price(ticker)
        except PortfolioError:
            unpriced.append(ticker)
            continue
        priced.append((ticker, price))
    if unpriced:
        result.notes["unpriced"] = unpriced
    if not priced:
        result.notes["reason"] = "no priced watchlist tickers"
        return result

    target_tickers = {t for t, _ in priced}
    price_map = dict(priced)

    portfolio = ctx.get_book()
    total_value = portfolio["total_value_usd"]
    if total_value <= 0:
        result.errors.append(f"total_value_usd <= 0 for {handle}")
        return result

    cash_reserve = float(params["cash_reserve_pct"])
    investable = total_value * (1.0 - cash_reserve)
    per_target_usd = investable / len(priced)
    min_trade = float(params["min_trade_usd"])

    desired_qty: dict[str, int] = {
        t: int(math.floor(per_target_usd / p)) for t, p in priced
    }
    current_qty: dict[str, float] = {
        h["ticker"]: float(h["quantity"]) for h in portfolio["holdings"]
    }

    # --- Phase 1: sell positions no longer on the watchlist, trim overshoots.
    sells: list[tuple[str, float, bool]] = []  # (ticker, qty, off_watchlist)
    buys: list[tuple[str, int]] = []

    for ticker, held in current_qty.items():
        want = desired_qty.get(ticker, 0) if ticker in target_tickers else 0
        delta = held - want  # positive → need to sell
        if delta <= 0:
            continue
        px = price_map.get(ticker)
        if px is None:
            try:
                px = ctx.pm.get_price(ticker)
            except PortfolioError:
                result.notes.setdefault("unpriced_holdings", []).append(ticker)
                continue
        # Skip noise trims within a still-targeted position; an off-watchlist
        # exit always sells in full regardless of notional.
        if ticker in target_tickers and delta * px < min_trade:
            continue
        sells.append((ticker, delta, ticker not in target_tickers))

    for ticker, price in priced:
        held = current_qty.get(ticker, 0.0)
        delta = desired_qty[ticker] - held
        if delta <= 0:
            continue
        if delta * price < min_trade:
            continue
        buys.append((ticker, int(delta)))

    # --- Dry-run: serialise the plan and return.
    if ctx.dry_run:
        result.notes["dry_run_plan"] = {
            "sells": [
                {"ticker": t, "qty": q, "off_watchlist": off}
                for (t, q, off) in sells
            ],
            "buys": [
                {"ticker": t, "qty": q, "rationale": rationale_for.get(t)}
                for (t, q) in buys
            ],
            "targets": len(priced),
            "per_target_usd": round(per_target_usd, 2),
            "total_value_usd": total_value,
        }
        logger.info(
            "[dry-run] %s: %d sells, %d buys, watchlist=%d, total=$%.2f",
            handle, len(sells), len(buys), len(priced), total_value,
        )
        return result

    # --- Live: execute sells first, then buys.
    for ticker, qty, _off in sells:
        try:
            ctx.sell(ticker, qty, note=_format_watchlist_sell_note(ticker))
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"sell {ticker} x{qty}: {exc}")

    for ticker, qty in buys:
        rationale = rationale_for.get(ticker)
        note = _format_watchlist_buy_note(ticker, rationale)
        # Pass a thesis so an investment_theses row is recorded on the buy.
        # The watchlist rationale becomes the thesis text when present;
        # otherwise the buy is snapshot-only (source='auto').
        thesis = {"thesis_text": rationale} if rationale else None
        try:
            ctx.buy(ticker, qty, note=note, thesis=thesis)
            result.buys += 1
        except PortfolioError as exc:
            # Cash drift between plan and execution is the usual failure
            # mode — a partial rebalance beats aborting.
            result.errors.append(f"buy {ticker} x{qty}: {exc}")

    result.notes["targets"] = len(priced)
    result.notes["per_target_usd"] = round(per_target_usd, 2)
    result.notes["total_value_usd"] = total_value
    return result


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def _llm_pick_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Imported lazily so the LLM SDK dependencies (anthropic / openai /
    # google-generativeai) only matter for runs that actually use them —
    # momentum / dual_positive heartbeats stay independent.
    from llm_picker import rebalance_llm_pick
    return rebalance_llm_pick(ctx)


def _llm_watchlist_buyer_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Lazy-imported so the ThreadPoolExecutor + LLM SDKs only load when
    # the strategy actually runs (mirrors `_llm_pick_lazy`).
    from llm_watchlist_buyer import rebalance_llm_watchlist_buyer
    return rebalance_llm_watchlist_buyer(ctx)


def _portfolio_reviewer_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Lazy import — same reasoning as `_llm_watchlist_buyer_lazy`. The
    # reviewer pulls in the LLM SDK + theses helpers only when run.
    from portfolio_reviewer import rebalance_portfolio_reviewer
    return rebalance_portfolio_reviewer(ctx)


def _trading_agents_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Lazy-imported so the upstream TauricResearch/TradingAgents
    # framework (and its heavy LangChain dependency tree) doesn't load
    # for unrelated heartbeats.
    from trading_agents_strategy import rebalance_trading_agents
    return rebalance_trading_agents(ctx)


STRATEGIES: dict[str, Strategy] = {
    "dual_positive": rebalance_dual_positive,
    "momentum": rebalance_momentum,
    "llm_pick": _llm_pick_lazy,
    "trading_agents": _trading_agents_lazy,
    "watchlist_curator": rebalance_watchlist_curator,
    "watchlist_buyer": rebalance_watchlist_buyer,
    "llm_watchlist_buyer": _llm_watchlist_buyer_lazy,
    "portfolio_reviewer": _portfolio_reviewer_lazy,
}


# ---------------------------------------------------------------------------
# Strategy phases — curate-before-trade ordering
# ---------------------------------------------------------------------------
#
# A strategy is either a 'curate' strategy (it produces inputs other
# strategies consume — today only watchlist_curator, which refreshes the
# portfolio_watchlist) or a 'trade' strategy (the default — it places
# trades). agent_heartbeat._run_portfolio runs all curate-phase members of
# a portfolio before any trade-phase member, so the curator's fresh
# shortlist is visible to the watchlist_buyer in the same heartbeat.

DEFAULT_STRATEGY_PHASE = "trade"

STRATEGY_PHASES: dict[str, str] = {
    "watchlist_curator": "curate",
    "llm_watchlist_buyer": "trade",
    "portfolio_reviewer": "trade",
}


def strategy_phase(name: str | None) -> str:
    """Return the phase ('curate' | 'trade') for a strategy name.

    Anything not explicitly listed in ``STRATEGY_PHASES`` — including
    ``None`` and unknown names — defaults to ``'trade'``.
    """
    return STRATEGY_PHASES.get(name or "", DEFAULT_STRATEGY_PHASE)


def get_strategy(name: str) -> Strategy | None:
    return STRATEGIES.get(name)
