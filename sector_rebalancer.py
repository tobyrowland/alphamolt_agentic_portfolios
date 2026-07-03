"""Sector Rebalancer strategy core.

A mechanical sell-side risk manager for human portfolios that keeps any single
GICS sector under a settable share of the book (`max_sector_pct`). It is the
**sell half** of the concentration cap; the **buy half** lives in the swarm
draft (`swarm.snake_draft_plan`'s `max_sector_value`), which the heartbeat wires
up from the same slider. Together they mean the buyer can never re-concentrate a
sector with cash this agent freed, and this agent cleans up a sector that ran
over the cap from price appreciation or manual buys.

Trim semantics (the design the owner chose — 2a "partial trim to the cap"):

- For each sector whose total market value exceeds the cap, sell just enough to
  bring it back to the cap — PARTIAL sells, not full-position exits.
- Weakest names go first: lowest current screen rank (a name that has fallen
  out of the screen entirely sorts weakest of all), ties broken by the smaller
  unrealized gain — so conviction/winning names are kept and the laggards are
  trimmed.
- Holdings with no GICS sector ("unclassified") are never trimmed and never
  count toward any sector's cap — they can't breach a sector limit.

The decision core (`plan_sector_trims`) is pure — holdings + sectors in, a list
of sells out — so it is unit-tested without a DB or a broker
(`tests/test_sector_rebalancer.py`). The `rebalance_sector_rebalancer` wrapper does the
IO and trades through the standard `ctx.sell` facade, so it works on a paper
book or a live Alpaca account exactly like every other strategy.
"""

from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING

from portfolio import PortfolioError

if TYPE_CHECKING:  # avoid a runtime import cycle with agent_strategies
    from agent_strategies import RebalanceContext, RebalanceResult

logger = logging.getLogger(__name__)


SECTOR_REBALANCER_DEFAULTS = {
    "max_sector_pct": 30.0,   # cap any one GICS sector at this % of total value
    "min_trade_usd": 50.0,    # don't emit a dust trim below this notional
}

# A name absent from the screen ranking sorts weakest of all (it has fallen out
# of the buyable set), so it is trimmed before any still-ranked name.
_WORST_RANK = math.inf


# ---------------------------------------------------------------------------
# Pure decision core
# ---------------------------------------------------------------------------


def plan_sector_trims(
    holdings: list[dict],
    sector_of: dict[str, str],
    total_value: float,
    max_sector_pct: float,
    *,
    ranks: dict[str, float] | None = None,
    min_trade_usd: float = 50.0,
) -> list[dict]:
    """Decide which shares to sell to bring every over-cap sector to the cap.

    Pure. `holdings` are book rows (`ticker`, `quantity`, `price_usd`,
    `market_value_usd`, `unrealized_pnl_usd`). `sector_of[ticker]` maps a held
    name to its GICS sector (absent = unclassified, never trimmed). `ranks` is
    an optional `{ticker: screen_rank}` (lower = stronger); names absent from it
    are treated as the weakest. Returns `[{ticker, qty, why}]` — whole-share
    partial sells, weakest names first, each capped at the held quantity.
    """
    ranks = ranks or {}
    if total_value <= 0 or max_sector_pct <= 0 or max_sector_pct >= 100:
        # >= 100% is "no real cap" — the slider's graceful high end.
        return []
    cap_usd = total_value * float(max_sector_pct) / 100.0

    # Group held positions by sector (skip unclassified — can't breach a cap).
    by_sector: dict[str, list[dict]] = {}
    for h in holdings:
        ticker = str(h.get("ticker") or "").upper()
        sec = sector_of.get(ticker)
        qty = float(h.get("quantity") or 0)
        price = float(h.get("price_usd") or 0)
        if not sec or qty <= 0 or price <= 0:
            continue
        by_sector.setdefault(sec, []).append(
            {
                "ticker": ticker,
                "qty": qty,
                "price": price,
                "mv": float(h.get("market_value_usd") or qty * price),
                "pnl": float(h.get("unrealized_pnl_usd") or 0),
            }
        )

    sells: list[dict] = []
    for sec, rows in by_sector.items():
        sector_mv = sum(r["mv"] for r in rows)
        over = sector_mv - cap_usd
        if over <= 0:
            continue
        # Weakest first. A lower screen rank number is STRONGER (rank 1 = best),
        # so we trim the highest rank numbers first; a name absent from the
        # ranking has fallen out of the screen entirely and is weakest of all
        # (-inf sorts ahead of every real -rank). Ties break to the smaller
        # unrealized gain, then ticker for determinism.
        rows.sort(
            key=lambda r: (-ranks.get(r["ticker"], _WORST_RANK), r["pnl"], r["ticker"])
        )
        for r in rows:
            if over <= 0:
                break
            price = r["price"]
            # Sell at least enough to cross back under the cap (ceil), but never
            # more than we hold.
            qty = min(r["qty"], math.ceil(over / price))
            qty = int(qty)
            if qty < 1:
                continue
            notional = qty * price
            # Dust guard: skip a trim too small to be worth the trade, UNLESS it
            # closes the whole position (a tiny full exit is fine).
            if notional < min_trade_usd and qty < r["qty"]:
                continue
            sells.append(
                {
                    "ticker": r["ticker"],
                    "qty": qty,
                    "why": (
                        f"{sec} at {sector_mv / total_value * 100:.0f}% of the "
                        f"portfolio (> {max_sector_pct:.0f}% cap)"
                    ),
                }
            )
            over -= notional

    return sells


# ---------------------------------------------------------------------------
# Heartbeat strategy
# ---------------------------------------------------------------------------


def _build_ranks(ctx: "RebalanceContext") -> dict[str, float]:
    """Best-effort {ticker: screen_rank} for the portfolio (lower = stronger).

    Held names absent from the (top-N) screen ranking are simply not in the map,
    so `plan_sector_trims` treats them as weakest and trims them first.
    """
    try:
        import screen as _screen

        rows = _screen.portfolio_screen_candidate_rows(ctx.db, ctx.portfolio_id)
        return {
            str(r.get("ticker") or "").upper(): float(r.get("rank"))
            for r in rows
            if r.get("rank") is not None
        }
    except Exception as exc:  # noqa: BLE001 — ranking is an ordering nicety
        logger.warning("sector_rebalancer: screen rank load failed: %s", exc)
        return {}


def rebalance_sector_rebalancer(ctx: "RebalanceContext") -> "RebalanceResult":
    """Trim over-cap sectors back to `max_sector_pct`. Never raises.

    The sell half of the concentration cap: partial-trims any GICS sector that
    exceeds the cap, weakest names first. The buy half (the draft refusing to
    breach the cap) is enforced in `agent_heartbeat._run_portfolio_swarm` from
    this agent's same `max_sector_pct` slider. No-op on a legacy 1:1 agent
    portfolio and on a portfolio with no over-cap sector.
    """
    from agent_strategies import RebalanceResult  # local: avoid import cycle

    result = RebalanceResult()
    params = {**SECTOR_REBALANCER_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    if not ctx.portfolio_id:
        result.notes["reason"] = "sector_rebalancer only runs on a human portfolio"
        return result

    max_sector_pct = float(params["max_sector_pct"])
    result.notes["max_sector_pct"] = max_sector_pct
    if max_sector_pct >= 100:
        result.notes["reason"] = "cap at 100% — no constraint"
        return result

    try:
        book = ctx.get_book()
    except Exception as exc:  # noqa: BLE001 — never crash the heartbeat
        result.errors.append(f"book read failed: {exc}")
        return result

    holdings = book.get("holdings") or []
    total_value = float(book.get("total_value_usd") or 0)
    if total_value <= 0 or not holdings:
        result.notes.setdefault("reason", "no holdings to rebalance")
        return result

    sector_of = ctx.db.get_sectors([h.get("ticker") for h in holdings])
    ranks = _build_ranks(ctx)

    sells = plan_sector_trims(
        holdings, sector_of, total_value, max_sector_pct,
        ranks=ranks, min_trade_usd=float(params["min_trade_usd"]),
    )

    if ctx.dry_run:
        result.notes["dry_run_plan"] = {
            "trims": [{"ticker": s["ticker"], "qty": s["qty"]} for s in sells],
        }
        logger.info(
            "[dry-run] %s: sector cap %.0f%% — %d trim(s)",
            handle, max_sector_pct, len(sells),
        )
        return result

    for s in sells:
        note = f"Trimmed {s['ticker']} — {s['why']}."
        try:
            ctx.sell(s["ticker"], s["qty"], note=note)
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"trim {s['ticker']} x{s['qty']}: {exc}")

    result.notes["trims"] = result.sells
    if not sells:
        result.notes.setdefault("reason", "every sector within cap")
    return result
