"""Double-Down strategy core.

A conviction-add buyer for human portfolios. It does NOT rank the screen like
the other buyers — it brings its OWN candidate feed: the portfolio's *current
holdings*. Each heartbeat it re-evaluates the names the portfolio already owns
and adds to the ones that still look really good, sizing each winner up toward a
concentration ceiling. It never opens a new position and it never sells — it
only presses the portfolio's existing bets when the conviction is there.

Why a self-sourced buyer (not the screen). The other buyers draft from the
screen's top-N to find NEW names. The double-down agent's whole job is the
opposite: lean into what you already hold. So its candidate set is the book, and
it runs standalone in the swarm before the snake draft (see
``agent_strategies.SELF_SOURCED_BUYER_STRATEGIES``) — its adds settle, and the
draft sees the resulting cash.

The "does this still look really good?" judgement reuses the buyer's shared
thinking core (``llm_watchlist_buyer.evaluate_candidates``): the SAME per-name
LLM evaluation, prompt, research-card + fact inputs and thesis discipline the
standalone / swarm buyers use — so a double-down verdict is grounded in exactly
the same reasoning, just pointed at held names with an "add to the winner"
framing. Only ``verdict="BUY"`` at/above the conviction gate (default 5/5)
triggers an add.

Sizing + idempotence. A qualifying name is topped up by one ``add_position_pct``
step, capped so the position never exceeds ``max_position_pct`` of the
portfolio. Once a name is at the ceiling there is nothing to add, so the
strategy is idempotent modulo price drift: a second run on an unchanged book
buys nothing. The concentration ceiling is what stops a runaway "keep adding to
the winner forever" loop.

The decision core (:func:`plan_double_down`) is pure — evaluations + book +
prices in, a plan out — so it is unit-tested without a DB or an LLM
(``tests/test_double_down.py``). The :func:`rebalance_double_down` wrapper does
the IO (fact load, news, LLM eval) and trades through the standard
``ctx.buy`` facade, so it works on a paper book or a live Alpaca account exactly
like every other strategy. Never raises — failures land in ``result.errors`` so
the heartbeat can't crash on it.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from portfolio import PortfolioError

if TYPE_CHECKING:  # avoid a runtime import cycle with agent_strategies
    from agent_strategies import RebalanceContext, RebalanceResult

logger = logging.getLogger(__name__)


DOUBLE_DOWN_DEFAULTS = {
    # --- brain (fixed on the agent, not an owner knob). Kept in DEFAULTS so the
    # strategy is self-contained: the self-sourced swarm path passes only the
    # membership config (the param_schema knobs), so provider/model must resolve
    # here rather than depending on agents.config reaching the strategy.
    "provider": "anthropic",
    "model": "claude-opus-4-8",
    # --- conviction + sizing (owner-tunable via param_schema) --------------
    "min_conviction": 5,          # hard gate — only add to names that look really good
    "max_position_pct": 8.0,      # ceiling: never let a doubled-down name exceed this weight
    "add_position_pct": 4.0,      # size of each top-up step (toward the ceiling)
    # --- guards -----------------------------------------------------------
    "min_cash_pct": 2.0,          # below this, no adds (nothing to deploy)
    "cash_reserve_pct": 0.02,     # keep a little cash for rounding / drift
    "min_add_usd": 500.0,         # ignore sub-noise add notionals
    # --- LLM eval plumbing (mirrors llm_watchlist_buyer) ------------------
    "concurrency": 5,
    "per_call_timeout_sec": 90,
    "max_tokens": 65536,
    "temperature": 0.2,
    "max_signals_per_kind": 5,
    # Per-name web search at add time (SerpAPI) — same entry-timing / catalyst
    # block the other buyers use. Auto-no-ops when SERPAPI_API_KEY is unset.
    "news_search": True,
    "news_queries": 1,
    "news_max_chars": 1500,
    "news_concurrency": 3,
}


# ---------------------------------------------------------------------------
# Pure decision core
# ---------------------------------------------------------------------------


@dataclass
class DoubleDownPlan:
    """A planned set of conviction-adds over the current holdings."""

    buys: list[dict] = field(default_factory=list)   # {ticker, qty, conviction, why}
    # Names considered but not added, with a reason (audit / dry-run only).
    skips: list[dict] = field(default_factory=list)  # {ticker, reason}


def _held_weight_pct(ticker: str, book: dict, prices: dict[str, float]) -> float | None:
    """Current weight of ``ticker`` as a % of total portfolio value (None if not held)."""
    total = float(book.get("total_value_usd") or 0)
    if total <= 0:
        return None
    for h in book.get("holdings") or []:
        if str(h.get("ticker") or "").upper() == ticker:
            qty = float(h.get("quantity") or 0)
            if qty <= 0:
                return None
            price = prices.get(ticker) or float(h.get("price_usd") or 0)
            if price <= 0:
                return None
            return qty * price / total * 100.0
    return None


def plan_double_down(
    qualifying: list[dict],
    book: dict,
    prices: dict[str, float],
    *,
    add_position_pct: float,
    max_position_pct: float,
    cash_reserve_pct: float,
    min_add_usd: float,
) -> DoubleDownPlan:
    """Decide how much to add to each high-conviction holding. Pure.

    ``qualifying`` are the held names that cleared the conviction gate, each
    ``{ticker, conviction, ...}``. ``prices`` maps ticker → price. ``book`` is
    the current portfolio book.

    For each name the add budget is one ``add_position_pct`` step of NAV, capped
    so the resulting weight never exceeds ``max_position_pct`` (the gap to the
    ceiling) and bounded by spendable cash (after the reserve). Highest
    conviction is filled first so a cash-constrained run presses the strongest
    names. A name already at/above the ceiling, or too small an add to clear
    ``min_add_usd``, is skipped with a reason. Every input name lands in exactly
    one of buys / skips.
    """
    plan = DoubleDownPlan()
    total_value = float(book.get("total_value_usd") or 0)
    cash = float(book.get("cash_usd") or 0)
    if total_value <= 0:
        return plan

    ceiling_usd = total_value * float(max_position_pct) / 100.0
    step_usd = total_value * float(add_position_pct) / 100.0
    spendable = cash - total_value * float(cash_reserve_pct)

    held_value = {
        str(h.get("ticker") or "").upper(): float(h.get("market_value_usd") or 0)
        for h in (book.get("holdings") or [])
    }

    # Highest conviction first (deterministic tie-break on ticker) so a
    # cash-constrained run presses the strongest names.
    ordered = sorted(
        qualifying,
        key=lambda e: (-int(e.get("conviction") or 0), str(e.get("ticker") or "")),
    )

    for ev in ordered:
        ticker = str(ev.get("ticker") or "").upper()
        current_value = held_value.get(ticker, 0.0)
        if current_value <= 0:
            # Defensive: candidates come from the book, so this shouldn't happen.
            plan.skips.append({"ticker": ticker, "reason": "not currently held"})
            continue
        price = prices.get(ticker)
        if not price or price <= 0:
            plan.skips.append({"ticker": ticker, "reason": "unpriced"})
            continue

        gap_usd = ceiling_usd - current_value
        if gap_usd < min_add_usd:
            plan.skips.append({"ticker": ticker,
                               "reason": f"already at/near the {max_position_pct:g}% ceiling"})
            continue
        if spendable < min_add_usd:
            plan.skips.append({"ticker": ticker, "reason": "insufficient cash to add"})
            continue

        budget = min(step_usd, gap_usd, spendable)
        qty = int(math.floor(budget / price))
        if qty < 1 or qty * price < min_add_usd:
            plan.skips.append({"ticker": ticker, "reason": "add too small after rounding"})
            continue

        plan.buys.append({
            "ticker": ticker,
            "qty": qty,
            "conviction": int(ev.get("conviction") or 0),
            "why": ev.get("rationale") or "",
        })
        spendable -= qty * price

    return plan


# ---------------------------------------------------------------------------
# Heartbeat strategy
# ---------------------------------------------------------------------------


def _holding_rationale(ticker: str, book: dict, prices: dict[str, float]) -> str:
    """The 'why this is a candidate' line handed to the LLM evaluator.

    Frames the decision as an ADD to an existing winner (weight + P&L vs cost),
    which is what turns the shared buyer prompt into a double-down judgement
    without a bespoke prompt template.
    """
    weight = _held_weight_pct(ticker, book, prices)
    pnl_pct = None
    for h in book.get("holdings") or []:
        if str(h.get("ticker") or "").upper() == ticker:
            avg = float(h.get("avg_cost_usd") or 0)
            price = prices.get(ticker) or float(h.get("price_usd") or 0)
            if avg > 0 and price > 0:
                pnl_pct = (price / avg - 1.0) * 100.0
            break
    weight_s = f"{weight:.1f}%" if weight is not None else "?"
    pnl_s = f"{pnl_pct:+.0f}% vs cost" if pnl_pct is not None else "P&L unknown"
    return (
        f"ALREADY HELD — {weight_s} of the portfolio, {pnl_s}. This is a "
        "DOUBLE-DOWN decision: BUY = add to this winner. Return conviction 5 "
        "only if it still looks really good to size up TODAY at this price; "
        "otherwise PASS and we leave the position as is."
    )


def rebalance_double_down(ctx: "RebalanceContext") -> "RebalanceResult":
    """Add to the portfolio's high-conviction holdings (the 'double down').

    Self-sourced buyer: the candidate feed is the portfolio's CURRENT HOLDINGS,
    not the screen. For each held name below the ``max_position_pct`` ceiling it
    runs the shared per-name LLM evaluation (its own mandate + the research card
    + Level 0 facts + recent news) and, for the ones that come back BUY at/above
    the conviction gate, adds one ``add_position_pct`` step toward the ceiling.
    Never opens a new position, never sells. Records a fresh thesis per add.

    Idempotent modulo price drift: names already at the ceiling have nothing to
    add, so a re-run on an unchanged book is a no-op. Defensive by contract —
    per-ticker eval errors are journalled and skipped; the heartbeat can't crash.
    """
    from agent_strategies import RebalanceResult  # local: avoid import cycle
    import llm_watchlist_buyer as _buyer
    import screen as _screen

    result = RebalanceResult()
    params = {**DOUBLE_DOWN_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    if not ctx.portfolio_id:
        result.notes["reason"] = "double_down only runs on a human portfolio"
        return result

    provider = params["provider"]
    model = params["model"]
    if not provider or not model:
        result.errors.append("double_down needs a provider + model")
        return result

    # 0. Book + cash gate (before any LLM work).
    book = ctx.get_book()
    total_value = float(book.get("total_value_usd") or 0)
    cash_usd = float(book.get("cash_usd") or 0)
    if total_value <= 0:
        result.errors.append(f"total_value_usd <= 0 for {handle}")
        return result
    cash_pct = cash_usd / total_value * 100.0
    min_cash_pct = float(params["min_cash_pct"])
    if cash_pct < min_cash_pct:
        result.notes["reason"] = "insufficient cash to add"
        result.notes["cash_pct"] = round(cash_pct, 2)
        return result

    holdings = book.get("holdings") or []
    if not holdings:
        result.notes["reason"] = "no holdings to double down on"
        return result

    max_position_pct = float(params["max_position_pct"])

    # 1. Candidate set = held names, priced, below the ceiling, off cooldown.
    recently_sold = ctx.db.get_recently_sold_tickers(ctx.portfolio_id, days=90)
    prices: dict[str, float] = {}
    candidates: list[str] = []
    skipped_at_ceiling: list[str] = []
    skipped_cooldown: list[str] = []
    unpriced: list[str] = []
    for h in holdings:
        ticker = str(h.get("ticker") or "").upper()
        if not ticker:
            continue
        # A partly-trimmed name inside the 90-day post-sell window is left alone
        # — don't fight a recent exit/trim by the owner or reviewer.
        if ticker in recently_sold:
            skipped_cooldown.append(ticker)
            continue
        try:
            price = ctx.pm.get_price(ticker)
        except PortfolioError:
            unpriced.append(ticker)
            continue
        prices[ticker] = price
        weight = (float(h.get("quantity") or 0) * price / total_value) * 100.0
        if weight >= max_position_pct:
            skipped_at_ceiling.append(ticker)
            continue
        candidates.append(ticker)

    if skipped_at_ceiling:
        result.notes["skipped_at_ceiling"] = skipped_at_ceiling
    if skipped_cooldown:
        result.notes["skipped_recent_sell_cooldown"] = skipped_cooldown
    if unpriced:
        result.notes["unpriced"] = unpriced
    if not candidates:
        result.notes.setdefault("reason", "every holding is at the ceiling, unpriced, or on cooldown")
        return result

    # 2. Load Level 0 facts for the held names + build the per-ticker eval data.
    #    load_facts covers Tier-1; a held name no longer in Tier-1 has no fact
    #    row and is skipped (we only add to names we still have facts for).
    cand_set = set(candidates)
    fact_rows = {
        str(r.get("ticker") or "").upper(): r
        for r in _screen.load_facts(ctx.db)
        if str(r.get("ticker") or "").upper() in cand_set
    }
    by_ticker_data = _buyer.build_candidate_data(ctx.db, fact_rows, candidates)
    missing_facts = [t for t in candidates if t not in by_ticker_data]
    if missing_facts:
        result.notes["missing_facts"] = missing_facts
        candidates = [t for t in candidates if t in by_ticker_data]
    if not candidates:
        result.notes["reason"] = "no Level 0 facts for any held name"
        return result

    combined_rationale = {t: _holding_rationale(t, book, prices) for t in candidates}

    # Per-name web search at add time (entry timing / catalyst / risk). No-op
    # when SERPAPI_API_KEY is unset.
    if params.get("news_search"):
        key = _buyer.serpapi_key()
        if key:
            fetched = _buyer.attach_recent_news(
                {t: by_ticker_data[t] for t in candidates},
                api_key=key,
                concurrency=int(params.get("news_concurrency", 3)),
                logger=logger,
                max_queries=int(params.get("news_queries", 1)),
                max_chars=int(params.get("news_max_chars", 1500)),
            )
            result.notes["news_fetched"] = fetched

    # 3. Per-ticker LLM evaluation (the shared buyer thinking core).
    evaluations, eval_notes = _buyer.evaluate_candidates(
        provider=provider,
        model=model,
        candidates=candidates,
        by_ticker_data=by_ticker_data,
        combined_rationale=combined_rationale,
        portfolio=book,
        portfolio_mandate=ctx.mandate,
        params=params,
        label=handle,
    )
    result.notes.update(eval_notes)

    min_conviction = int(params["min_conviction"])
    qualifying = [
        e for e in evaluations
        if str(e.get("verdict") or "").upper() == "BUY"
        and int(e.get("conviction") or 0) >= min_conviction
    ]
    result.notes["qualifying"] = len(qualifying)
    if not qualifying:
        result.notes.setdefault("reason", "no held name met the conviction gate to add")
        return result

    # 4. Size the adds (pure planner) and execute.
    plan = plan_double_down(
        qualifying, book, prices,
        add_position_pct=float(params["add_position_pct"]),
        max_position_pct=max_position_pct,
        cash_reserve_pct=float(params["cash_reserve_pct"]),
        min_add_usd=float(params["min_add_usd"]),
    )
    by_ticker_eval = {e["ticker"]: e for e in qualifying}

    if ctx.dry_run:
        result.notes["dry_run_plan"] = {
            "buys": plan.buys,
            "skips": plan.skips,
            "max_position_pct": max_position_pct,
            "add_position_pct": params["add_position_pct"],
            "cash_pct": round(cash_pct, 2),
        }
        logger.info(
            "[dry-run] %s: %d double-down add(s), %d candidate(s) evaluated",
            handle, len(plan.buys), len(candidates),
        )
        return result

    for b in plan.buys:
        ticker = b["ticker"]
        ev = by_ticker_eval.get(ticker) or {}
        weight = _held_weight_pct(ticker, book, prices)
        weight_s = f"{weight:.1f}%" if weight is not None else "?"
        note = (
            f"Double-down {b['conviction']}/5 — added to {ticker} "
            f"(held {weight_s}): {(ev.get('rationale') or '')[:80]}"
        )
        # Record a fresh thesis for the add (the higher-conviction view). Like
        # every re-buy this supersedes the position's prior active thesis — the
        # audit trail keeps the old one as 'superseded'.
        thesis = {
            "thesis_text": ev.get("thesis_text") or None,
            "extend_signals": ev.get("extend_signals") or None,
            "break_signals": ev.get("break_signals") or None,
        }
        try:
            ctx.buy(ticker, b["qty"], note=note, thesis=thesis)
            result.buys += 1
        except PortfolioError as exc:
            result.errors.append(f"add {ticker} x{b['qty']}: {exc}")
        except Exception as exc:  # noqa: BLE001 — one bad add must not abort the batch
            logger.warning("%s: add %s x%s failed (skipped): %s",
                           handle, ticker, b["qty"], exc)
            result.errors.append(f"add {ticker} x{b['qty']}: {exc}")

    result.notes["adds"] = result.buys
    result.notes["max_position_pct"] = max_position_pct
    return result
