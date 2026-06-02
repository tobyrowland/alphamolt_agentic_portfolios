#!/usr/bin/env python3
"""
Mirror a paper portfolio's composition onto a live Alpaca account.

The model (chosen for AlphaMolt): the **paper** portfolio is the brain — the
swarm/mandate/agents run there as normal, at the $1M paper scale. The **live**
portfolio is a private *follower*: it holds the same names in the same
proportions, but sized to the **real Alpaca account value**, executed with real
money. The live portfolio has no agents/mandate of its own.

"Mirror purchases" is implemented as **target-weight replication**, not
trade-by-trade replay:

    target_shares[t] = (paper_weight[t] * alpaca_equity) / price[t]

then we diff against the current Alpaca positions and place orders only for the
deltas (sells first to free buying power, then buys). This is self-correcting —
partial fills, fractional shares, price drift, or a missed run never
accumulate, because each pass simply re-converges the live account onto the
paper book's current shape.

A name is only rebalanced when its weight drifts more than ``threshold`` (1% of
equity by default), to avoid churning tiny fee-bearing orders every run.

Entry points:
  - `mirror_paper_to_alpaca(...)` — called by agent_heartbeat right after the
    paper portfolio rebalances.
  - CLI: `python alpaca_mirror.py --slug <live-slug> [--dry-run]
    [--threshold 0.01]` — resolves the paper sibling by owner, mirrors, syncs.

Real orders only fire when ALPACA_LIVE_EXECUTION_ENABLED is truthy (same master
switch as the heartbeat) or against the paper sandbox; otherwise use --dry-run
to preview.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from dataclasses import dataclass

from db import SupabaseDB
from portfolio import PortfolioError, PortfolioManager

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger("alpaca_mirror")

DEFAULT_THRESHOLD = 0.01   # rebalance a name only if |Δweight| > 1% of equity
MIN_ORDER_USD = 1.0        # skip dust orders below $1 notional


@dataclass
class MirrorOrder:
    ticker: str
    side: str          # 'buy' | 'sell'
    qty: float
    target_w: float
    cur_w: float
    ref_price: float   # intended price — basis for the execution price band


def plan_mirror(
    paper_book: dict,
    equity: float,
    alpaca_positions: dict[str, float],
    price_fn,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    min_order_usd: float = MIN_ORDER_USD,
) -> list[MirrorOrder]:
    """Pure planner: paper composition + Alpaca equity/positions -> orders.

    ``paper_book`` is a ``PortfolioManager.get_portfolio_book`` result.
    ``alpaca_positions`` maps symbol -> current qty held on Alpaca.
    ``price_fn(ticker) -> float`` supplies the price for share math (raises to
    signal an unusable price; that ticker is skipped). Returns orders with
    sells first (free buying power) then buys, each sorted by ticker.
    """
    total = float(paper_book.get("total_value_usd") or 0)
    if total <= 0 or equity <= 0:
        return []

    # Target weight per name from the paper book's market values.
    target_w: dict[str, float] = {}
    for h in paper_book.get("holdings", []):
        mv = float(h.get("market_value_usd") or 0)
        if mv > 0:
            target_w[h["ticker"]] = mv / total

    sells: list[MirrorOrder] = []
    buys: list[MirrorOrder] = []
    for ticker in sorted(set(target_w) | set(alpaca_positions)):
        try:
            price = price_fn(ticker)
        except PortfolioError:
            logger.warning("mirror: no price for %s — skipping", ticker)
            continue
        if not price or price <= 0:
            continue

        tw = target_w.get(ticker, 0.0)
        cur_qty = float(alpaca_positions.get(ticker, 0.0))
        cur_w = (cur_qty * price) / equity if equity else 0.0
        if abs(tw - cur_qty * price / equity) <= threshold:
            continue

        target_qty = (tw * equity) / price
        delta = round(target_qty - cur_qty, 4)
        if abs(delta) * price < min_order_usd:
            continue
        order = MirrorOrder(
            ticker=ticker,
            side="buy" if delta > 0 else "sell",
            qty=abs(delta),
            target_w=tw,
            cur_w=cur_w,
            ref_price=price,
        )
        (buys if delta > 0 else sells).append(order)

    return sells + buys


def mirror_paper_to_alpaca(
    db: SupabaseDB,
    pm: PortfolioManager,
    executor,
    live_pf: dict,
    paper_pf: dict,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    dry_run: bool = False,
) -> dict:
    """Rebalance the live Alpaca account to match the paper portfolio.

    Skips when the market is closed (mirror needs fills; a queued order would
    desync the book until the next run). On success, syncs the real fills back
    into the live portfolio's normal tables. Returns a small summary dict.
    """
    live_slug = live_pf.get("slug") or live_pf["id"][:8]
    if live_pf.get("mode") != "live":
        raise ValueError(f"{live_slug} is not mode='live'")

    if not dry_run:
        clock = executor.client.get_clock()
        if not clock.get("is_open"):
            logger.info("mirror %s: market closed — skipping this run", live_slug)
            return {"status": "market_closed", "orders": 0}

    paper_book = pm.get_portfolio_book(paper_pf["id"])
    account = executor.client.get_account()
    equity = float(account.get("equity") or 0)
    positions = {
        p["symbol"]: float(p["qty"]) for p in executor.client.list_positions()
    }

    orders = plan_mirror(
        paper_book, equity, positions, pm.get_price, threshold=threshold
    )
    tag = "DRY-RUN " if dry_run else ""
    logger.info(
        "%smirror %s <- %s: equity=$%.2f, %d order(s)",
        tag, live_slug, paper_pf.get("slug"), equity, len(orders),
    )

    placed = 0
    for o in orders:
        logger.info(
            "  %s %-8s %.4f sh   (target_w=%.1f%% cur_w=%.1f%%)",
            o.side, o.ticker, o.qty, o.target_w * 100, o.cur_w * 100,
        )
        if dry_run:
            continue
        try:
            res = executor.execute_and_wait(
                o.ticker, o.side, o.qty,
                allow_live=True, ref_price=o.ref_price,
            )
            if res.filled_qty > 0:
                placed += 1
        except Exception as exc:  # noqa: BLE001 — one bad order shouldn't abort the rebalance
            logger.error("  order %s %s failed: %s", o.side, o.ticker, exc)

    if not dry_run and placed:
        # Record the real fills + reconcile any drift into the live book.
        executor.sync_to_db(db, live_slug)

    return {"status": "ok", "orders": len(orders), "placed": placed}


def _sibling_paper_portfolio(db: SupabaseDB, live_pf: dict) -> dict | None:
    """The paper portfolio the live follower mirrors — same owner, mode='paper'."""
    owner = live_pf.get("owner_user_id")
    if not owner:
        return None
    for p in db.get_human_portfolios():
        if p.get("owner_user_id") == owner and (p.get("mode") or "paper") != "live":
            return p
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Mirror a paper portfolio to Alpaca")
    ap.add_argument("--slug", required=True, help="the LIVE portfolio slug")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    db = SupabaseDB()
    pm = PortfolioManager(db)
    live_pf = db.get_portfolio_by_slug(args.slug)
    if not live_pf:
        logger.error("no portfolio with slug %r", args.slug)
        return 1
    if live_pf.get("mode") != "live":
        logger.error("%s is not a live portfolio (mode=%r)", args.slug,
                     live_pf.get("mode"))
        return 1
    paper_pf = _sibling_paper_portfolio(db, live_pf)
    if not paper_pf:
        logger.error("no sibling paper portfolio found for %s", args.slug)
        return 1

    try:
        from alpaca_execution import AlpacaExecutionBackend
        executor = AlpacaExecutionBackend()
    except Exception as exc:  # noqa: BLE001
        logger.error("Alpaca init failed: %s", exc)
        return 1

    summary = mirror_paper_to_alpaca(
        db, pm, executor, live_pf, paper_pf,
        threshold=args.threshold, dry_run=args.dry_run,
    )
    logger.info("mirror summary: %s", summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
