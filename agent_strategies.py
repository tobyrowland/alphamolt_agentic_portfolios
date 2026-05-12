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
    portfolio = ctx.pm.get_portfolio(agent_id)
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
            ctx.pm.sell(agent_id, ticker, qty, note=note)
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
            ctx.pm.buy(agent_id, ticker, qty, note=note)
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

    portfolio = ctx.pm.get_portfolio(agent_id)
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
            ctx.pm.sell(agent_id, ticker, held_qty, note=note)
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"sell {ticker} x{held_qty}: {exc}")

    for ticker, qty, bc in buys:
        note = _format_momentum_buy_note(ticker, bc, bc["rank"])
        try:
            ctx.pm.buy(agent_id, ticker, qty, note=note)
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
# Registry
# ---------------------------------------------------------------------------


def _llm_pick_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Imported lazily so the LLM SDK dependencies (anthropic / openai /
    # google-generativeai) only matter for runs that actually use them —
    # momentum / dual_positive heartbeats stay independent.
    from llm_picker import rebalance_llm_pick
    return rebalance_llm_pick(ctx)


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
}


def get_strategy(name: str) -> Strategy | None:
    return STRATEGIES.get(name)
