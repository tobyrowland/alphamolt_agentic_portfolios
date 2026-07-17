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
from dataclasses import dataclass, field
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
# Shared constants
# ---------------------------------------------------------------------------


# US exchange codes — imported by llm_picker for its US-only snapshot filter.
US_EXCHANGES = {"NYSE", "NASDAQ", "AMEX", "NYSEARCA", "BATS", "ARCA"}


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
    the dependency only matters for runs that actually curate — other
    heartbeats stay independent.

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
# The buyer half of the pipeline. A mechanical equal-weight buyer
# — equal-weight, diff vs book, sells-before-buys, dry-run plan, idempotent —
# but the candidate set is the portfolio's watchlist (all rows, source
# 'agent' AND 'user') rather than the dual-positive screen. Each buy passes a
# thesis kwarg so an investment thesis is recorded.


WATCHLIST_BUYER_DEFAULTS = {
    "cash_reserve_pct": 0.02,  # keep 2% cash to absorb rounding / price drift
    "min_trade_usd": 500.0,    # ignore rebalance deltas below this notional
}


def _portfolio_screen_candidates(ctx: RebalanceContext) -> dict[str, str | None]:
    """The buyer's candidate set: the top N of the portfolio's screen.

    The configurable screener is the funnel's selection stage (screener brief
    v2 §3) — the curator/watchlist is removed. Delegates to
    ``screen.portfolio_screen_candidates`` so the mechanical and LLM buyers
    share one selection path.
    """
    import screen as _screen

    return _screen.portfolio_screen_candidates(ctx.db, ctx.portfolio_id)


def _format_watchlist_sell_note(ticker: str) -> str:
    return f"Sold {ticker} — no longer in the portfolio's screen top N."


def _format_watchlist_buy_note(ticker: str, rationale: str | None) -> str:
    if rationale:
        return f"Bought {ticker} — watchlist pick: {rationale}"
    return f"Bought {ticker} — equal-weight watchlist pick."


def rebalance_watchlist_buyer(ctx: RebalanceContext) -> RebalanceResult:
    """Equal-weight the portfolio's watchlist and trade towards it.

    Candidate set is every ``portfolio_watchlist`` row for the portfolio —
    both the owner's manual ``source='user'`` picks and the curator's
    ``source='agent'`` picks. Algorithm (equal-weight, diff vs book):

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

    # Candidate set is the top N of the portfolio's screen (the screener IS
    # the selection now — curator/watchlist removed, brief v2 §3).
    rationale_for = _portfolio_screen_candidates(ctx)
    watchlist_tickers = list(rationale_for.keys())

    if not watchlist_tickers:
        result.notes["reason"] = "portfolio has no screen configured or screen is empty"
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
# Strategy: ma_sniper (the "200-week average sniper")
# ---------------------------------------------------------------------------
#
# Charlie Munger's patience discipline: wait, fully prepared, for a QUALITY
# business to trade down to its long-run trend, then strike. Quality is the
# portfolio's screen top-N (quality-weighted — same candidate set every buyer
# uses); the trend is the 200-week (~3.85y) moving average. The conviction core
# lives in ma_sniper.py and is the primary path on the swarm (the heartbeat
# sources per-name conviction from it). This standalone rebalance is the
# non-swarm fallback so the strategy also works on a 1:1 / non-buyer portfolio
# and so get_strategy('ma_sniper') resolves.
#
# Patient accumulator: it only ever BUYS — deploying available cash into names
# at/below their 200-week average, deepest discount first — and never force-
# sells to fund a buy. Most runs buy nothing (no quality name is on sale);
# selling is the reviewer's job.


MA_SNIPER_DEFAULTS = {
    "band_pct": 5.0,            # proximity band to the 200w MA (percent)
    "target_position_pct": 5.0,  # size per strike (percent of total value)
    "cash_reserve_pct": 0.02,   # keep 2% cash for rounding / drift
    "min_trade_usd": 500.0,     # ignore sub-noise notionals
    "max_positions": 25,        # stop accumulating past this many holdings
}


def _format_ma_sniper_buy_note(ticker: str, detail: dict, rationale: str | None) -> str:
    disc = detail.get("discount_pct", 0.0)
    where = f"{abs(disc):.1f}% below" if disc < 0 else f"{disc:.1f}% above"
    base = f"Bought {ticker} — at 200-week average ({where} long-run trend)"
    return f"{base}; {rationale}." if rationale else f"{base}."


def rebalance_ma_sniper(ctx: RebalanceContext) -> RebalanceResult:
    """Patient accumulator: buy quality screen names at/below their 200w MA.

    Algorithm:
        1. Candidate set = the portfolio's screen top-N (quality-weighted).
        2. Drop names already held or on the 90-day re-buy cooldown; price the
           rest.
        3. Compute each candidate's 200-week MA (ma_sniper) and keep only those
           trading within ``band_pct`` of / below it — deepest discount first.
        4. Deploy available cash into them at ``target_position_pct`` each,
           keeping a cash reserve and capping total holdings at ``max_positions``.
           Never sells. Records a thesis (with the discount) per buy.

    Idempotent modulo price drift: a second run buys nothing when no quality
    name is on sale (the common case) or everything is already at target.
    """
    result = RebalanceResult()
    params = {**MA_SNIPER_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    if not ctx.portfolio_id:
        result.notes["reason"] = "ma_sniper only runs on a human portfolio"
        return result

    import ma_sniper as _ma_sniper

    cand_map = _portfolio_screen_candidates(ctx)
    candidates = list(cand_map.keys())
    if not candidates:
        result.notes["reason"] = "portfolio has no screen configured or screen is empty"
        return result

    book = ctx.get_book()
    total_value = float(book["total_value_usd"])
    if total_value <= 0:
        result.errors.append(f"total_value_usd <= 0 for {handle}")
        return result
    cash = float(book["cash_usd"])
    held = {h["ticker"] for h in book["holdings"]}

    recently_sold = ctx.db.get_recently_sold_tickers(ctx.portfolio_id, days=90)

    # Price only the names we could actually buy (not held, off cooldown).
    prices: dict[str, float] = {}
    unpriced: list[str] = []
    for t in candidates:
        if t in held or t in recently_sold:
            continue
        try:
            prices[t] = ctx.pm.get_price(t)
        except PortfolioError:
            unpriced.append(t)
    if unpriced:
        result.notes["unpriced"] = unpriced

    band = float(params["band_pct"]) / 100.0
    details: dict[str, dict] = {}
    convs = _ma_sniper.sniper_convictions(
        ctx.db, list(prices.keys()), prices, band=band, details=details,
    )
    if not convs:
        result.notes["reason"] = "no quality screen name at/below its 200-week average"
        return result

    # Deepest discount (highest conviction) first; screen rank breaks ties.
    qualifying = sorted(convs, key=lambda t: (-convs[t], candidates.index(t)))

    max_positions = int(params["max_positions"])
    slots = max(0, max_positions - len(held))
    target_usd = total_value * float(params["target_position_pct"]) / 100.0
    reserve = total_value * float(params["cash_reserve_pct"])
    min_trade = float(params["min_trade_usd"])

    buys: list[tuple[str, int]] = []
    spendable = cash - reserve
    for t in qualifying:
        if len(buys) >= slots:
            break
        price = prices[t]
        budget = min(target_usd, spendable)
        qty = int(math.floor(budget / price)) if price > 0 else 0
        if qty < 1 or qty * price < min_trade:
            continue
        buys.append((t, qty))
        spendable -= qty * price

    if ctx.dry_run:
        result.notes["dry_run_plan"] = {
            "buys": [
                {
                    "ticker": t,
                    "qty": q,
                    "conviction": convs[t],
                    **details.get(t, {}),
                }
                for (t, q) in buys
            ],
            "qualifying": [
                {"ticker": t, "conviction": convs[t], **details.get(t, {})}
                for t in qualifying
            ],
            "slots": slots,
            "target_usd": round(target_usd, 2),
            "total_value_usd": total_value,
        }
        logger.info(
            "[dry-run] %s: %d sniper buy(s), %d name(s) at/below 200w MA, total=$%.2f",
            handle, len(buys), len(qualifying), total_value,
        )
        return result

    for t, qty in buys:
        rationale = cand_map.get(t)
        note = _format_ma_sniper_buy_note(t, details.get(t, {}), rationale)
        # Thesis records the discount-to-trend so the audit trail captures the
        # fat pitch, not just the screen rank.
        d = details.get(t, {})
        thesis = {
            "thesis_text": note,
            "extend_signals": [],
            # If price recovers well above the 200w MA the entry logic no longer
            # holds — a natural break signal for the reviewer to weigh.
            "break_signals": (
                [{"metric": "price", "op": ">", "value": round(d["ma_200w"] * 1.5, 4)}]
                if d.get("ma_200w")
                else []
            ),
        }
        try:
            ctx.buy(t, qty, note=note, thesis=thesis)
            result.buys += 1
        except PortfolioError as exc:
            result.errors.append(f"buy {t} x{qty}: {exc}")

    result.notes["targets"] = len(buys)
    result.notes["qualifying"] = len(qualifying)
    result.notes["total_value_usd"] = total_value
    return result


# ---------------------------------------------------------------------------
# Strategy: profit_taker (one-time gain banker)
# ---------------------------------------------------------------------------
#
# A sell-side trimmer: when a holding has grown by `gain_pct` versus its cost
# basis, sell `sell_pct` of the position to bank the gain — and never touch
# that equity again. Unlike the LLM reviewer this is purely mechanical (no
# brief, no LLM) and it TRIMS rather than fully exits (unless sell_pct = 100).
#
# "Once per equity, ever" is enforced durably via the trade journal: the sell
# is attributed to this agent, so on every later run the names it has already
# trimmed are read back from agent_trades (db.get_agent_sold_tickers) and
# skipped — permanently, even if the position keeps climbing or is later
# re-bought. That makes the strategy idempotent across runs by construction.


PROFIT_TAKER_DEFAULTS = {
    "gain_pct": 25.0,        # trigger: position up at least this % vs avg cost
    "sell_pct": 50.0,        # trim this % of the position when triggered
    "min_trade_usd": 100.0,  # ignore sub-noise trims
}


def _format_profit_taker_note(ticker: str, gain_pct: float, sell_pct: float) -> str:
    scope = "exiting" if sell_pct >= 100 else f"trimming {sell_pct:.0f}%"
    return (
        f"Sold {ticker} — up {gain_pct:.0f}% vs cost, banking the gain "
        f"({scope}, one-time)."
    )


def rebalance_profit_taker(ctx: RebalanceContext) -> RebalanceResult:
    """Bank a one-time profit on any holding past its gain threshold.

    For each current holding (priced at the book's market price):
        1. Skip names this agent has already trimmed — ever (the journal-backed
           once-per-equity rule).
        2. gain% = price / avg_cost − 1. If gain% ≥ ``gain_pct``, sell
           floor(qty × ``sell_pct``/100) shares (a full exit when sell_pct=100).
        3. Trims below ``min_trade_usd`` notional are skipped as noise.

    Only ever sells; never buys. Idempotent across runs — once a name is trimmed
    it is recorded in the trade journal and never reconsidered.
    """
    result = RebalanceResult()
    params = {**PROFIT_TAKER_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    if not ctx.portfolio_id:
        result.notes["reason"] = "profit_taker only runs on a human portfolio"
        return result

    gain_threshold = float(params["gain_pct"])
    sell_fraction = float(params["sell_pct"]) / 100.0
    min_trade = float(params["min_trade_usd"])

    book = ctx.get_book()
    holdings = book.get("holdings") or []
    if not holdings:
        result.notes["reason"] = "no holdings"
        return result

    already = ctx.db.get_agent_sold_tickers(ctx.portfolio_id, ctx.agent["id"])

    plan: list[tuple[str, int, float]] = []  # (ticker, qty_to_sell, gain_pct)
    skipped_already: list[str] = []
    for h in holdings:
        ticker = h["ticker"]
        qty = float(h.get("quantity") or 0)
        avg_cost = SupabaseDB.safe_float(h.get("avg_cost_usd"))
        price = SupabaseDB.safe_float(h.get("price_usd"))
        if qty <= 0 or not avg_cost or avg_cost <= 0 or not price:
            continue
        if ticker in already:
            skipped_already.append(ticker)
            continue
        gain = (price / avg_cost - 1.0) * 100.0
        if gain < gain_threshold:
            continue
        qty_to_sell = int(math.floor(qty * sell_fraction))
        if qty_to_sell < 1:
            continue  # position too small to trim a whole share — wait
        if qty_to_sell * price < min_trade:
            continue
        plan.append((ticker, qty_to_sell, gain))

    if skipped_already:
        result.notes["skipped_already_trimmed"] = skipped_already

    if not plan:
        result.notes.setdefault("reason", "no holding above its gain threshold")
        return result

    if ctx.dry_run:
        result.notes["dry_run_plan"] = {
            "sells": [
                {
                    "ticker": t,
                    "qty": q,
                    "gain_pct": round(g, 1),
                    "sell_pct": params["sell_pct"],
                }
                for (t, q, g) in plan
            ],
            "gain_threshold_pct": gain_threshold,
        }
        logger.info(
            "[dry-run] %s: %d profit-take trim(s) (≥%.0f%% gain)",
            handle, len(plan), gain_threshold,
        )
        return result

    for ticker, qty, gain in plan:
        note = _format_profit_taker_note(ticker, gain, float(params["sell_pct"]))
        try:
            ctx.sell(ticker, qty, note=note)
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"sell {ticker} x{qty}: {exc}")

    result.notes["trims"] = result.sells
    return result


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def _llm_watchlist_buyer_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Lazy-imported so the ThreadPoolExecutor + LLM SDKs only load when
    # the strategy actually runs.
    from llm_watchlist_buyer import rebalance_llm_watchlist_buyer
    return rebalance_llm_watchlist_buyer(ctx)


def _portfolio_reviewer_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Lazy import — same reasoning as `_llm_watchlist_buyer_lazy`. The
    # reviewer pulls in the LLM SDK + theses helpers only when run.
    from portfolio_reviewer import rebalance_portfolio_reviewer
    return rebalance_portfolio_reviewer(ctx)


def _pelosi_mirror_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Lazy import — keeps requests/pypdf out of unrelated heartbeats.
    from pelosi_mirror import rebalance_pelosi_mirror
    return rebalance_pelosi_mirror(ctx)


def _sector_rebalancer_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Lazy import — the trim core pulls in `screen` only when it runs.
    from sector_rebalancer import rebalance_sector_rebalancer
    return rebalance_sector_rebalancer(ctx)


def _double_down_lazy(ctx: RebalanceContext) -> RebalanceResult:
    # Lazy import — the conviction-add core pulls in the LLM buyer's thinking
    # core + SDKs only when it runs.
    from double_down import rebalance_double_down
    return rebalance_double_down(ctx)


# NOTE: `watchlist_curator` is intentionally NOT registered. The configurable
# screener is the funnel's selection stage now (screener brief v2 §3) — a
# portfolio's candidate set is the top N of its `screen_config`, read directly
# by the buyers via `screen.run_screen`. The curator no longer runs; its
# function body is retained below only as a reference until the watchlist UI is
# fully removed in a follow-up cleanup.
STRATEGIES: dict[str, Strategy] = {
    "watchlist_buyer": rebalance_watchlist_buyer,
    "llm_watchlist_buyer": _llm_watchlist_buyer_lazy,
    "ma_sniper": rebalance_ma_sniper,
    "profit_taker": rebalance_profit_taker,
    "portfolio_reviewer": _portfolio_reviewer_lazy,
    "pelosi_mirror": _pelosi_mirror_lazy,
    "sector_rebalancer": _sector_rebalancer_lazy,
    "double_down": _double_down_lazy,
}


# ---------------------------------------------------------------------------
# Self-sourced buyers — buyers that bring their OWN candidate feed
# ---------------------------------------------------------------------------
#
# Most buyers draft from the screen's top-N via the swarm snake-draft. A
# self-sourced buyer ignores the screen entirely: its candidates come from an
# external feed (e.g. `pelosi_mirror` mirrors a politician's disclosed trades).
# Such a buyer can't be drafted over screen candidates, so the swarm runs its
# full strategy standalone against the shared book instead of including it in
# the draft (agent_heartbeat._run_portfolio_swarm). It still trades the shared
# pot and is journaled like any other member.

SELF_SOURCED_BUYER_STRATEGIES: set[str] = {"pelosi_mirror", "double_down"}


def is_self_sourced_buyer(strategy_name: str | None) -> bool:
    return (strategy_name or "") in SELF_SOURCED_BUYER_STRATEGIES


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

# With the curator removed, no strategy is currently 'curate' phase. The
# phase machinery stays (cheap, and a future curate-phase strategy may return).
STRATEGY_PHASES: dict[str, str] = {
    "llm_watchlist_buyer": "trade",
    "portfolio_reviewer": "trade",
    "pelosi_mirror": "trade",
    "sector_rebalancer": "trade",
    "double_down": "trade",
}


def strategy_phase(name: str | None) -> str:
    """Return the phase ('curate' | 'trade') for a strategy name.

    Anything not explicitly listed in ``STRATEGY_PHASES`` — including
    ``None`` and unknown names — defaults to ``'trade'``.
    """
    return STRATEGY_PHASES.get(name or "", DEFAULT_STRATEGY_PHASE)


def get_strategy(name: str) -> Strategy | None:
    return STRATEGIES.get(name)
