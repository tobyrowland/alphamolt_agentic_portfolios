#!/usr/bin/env python3
"""Swarm consensus snapshot — weekly aggregation of portfolio_holdings.

Computes which equities are most-held across the arena's portfolios and
materialises one row per (snapshot_date, ticker) into `consensus_snapshots`.
Powers the public /consensus page ("Silicon Smart Money" tracker).

Each *portfolio* is a consensus "player" — the arena moved off the legacy
one-portfolio-per-agent `agent_holdings` table (now drained) to shared-pot
`portfolio_holdings` (see `db.fetch_holdings_with_agent_company`, which also
excludes live follower books to avoid double-counting).

Scheduled Monday 00:00 UTC via `.github/workflows/consensus-snapshot.yml`,
right after Sunday 22:00's `agent_heartbeat` rebalance has settled.

Per-row metrics:

    num_agents       distinct portfolios holding the ticker
    pct_agents       num_agents / total_agents (denominator: portfolios holding
                     anything in this snapshot — keeps the % comparable across rows)
    swarm_avg_entry  Σ(quantity·avg_cost) / Σ(quantity)  — weighted across the swarm
    current_price    Level 0 securities.price at snapshot time
    swarm_pnl_pct    (current_price − swarm_avg_entry) / swarm_avg_entry · 100
    top_holders      JSON list of the PUBLIC portfolios holding the ticker,
                     ordered by current MTM position size desc (private
                     portfolios count toward the totals but are never named).
                     The page slices the first two as visible chips and the
                     rest live in the +N tooltip.

Usage::

    python consensus_snapshot.py                          # snapshot today
    python consensus_snapshot.py --dry-run                # plan only, no writes
    python consensus_snapshot.py --snapshot-date 2026-05-04  # backfill
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

from db import SupabaseDB


def setup_logging(today_str: str) -> logging.Logger:
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"consensus_snapshot_{today_str}.txt"

    logger = logging.getLogger("consensus_snapshot")
    logger.setLevel(logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)
    return logger


def _safe_float(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f


def aggregate(rows: list[dict]) -> tuple[list[dict], int]:
    """Group raw holdings into per-ticker consensus rows.

    Returns (consensus_rows, total_agents). `total_agents` is the count of
    distinct agents with at least one holding — the denominator used for
    `pct_agents` on every row, so percentages are comparable.
    """
    by_ticker: dict[str, list[dict]] = defaultdict(list)
    distinct_agents: set[str] = set()
    for r in rows:
        agent_id = r.get("agent_id")
        ticker = r.get("ticker")
        qty = _safe_float(r.get("quantity")) or 0.0
        if not agent_id or not ticker or qty <= 0:
            continue
        by_ticker[ticker].append(r)
        distinct_agents.add(agent_id)

    total_agents = len(distinct_agents)
    out: list[dict] = []

    for ticker, holdings in by_ticker.items():
        first = holdings[0]
        current_price = _safe_float(first.get("current_price"))

        sum_qty = 0.0
        sum_cost = 0.0  # Σ(quantity * avg_cost)
        for h in holdings:
            q = _safe_float(h.get("quantity")) or 0.0
            c = _safe_float(h.get("avg_cost_usd")) or 0.0
            sum_qty += q
            sum_cost += q * c

        swarm_avg_entry = (sum_cost / sum_qty) if sum_qty > 0 else None

        if (
            swarm_avg_entry is not None
            and swarm_avg_entry > 0
            and current_price is not None
        ):
            swarm_pnl_pct = (current_price - swarm_avg_entry) / swarm_avg_entry * 100
        else:
            swarm_pnl_pct = None

        # Per-holder MTM for ordering top_holders. Falls back to
        # quantity*avg_cost when the company has no price (rare —
        # would-be "no_price" cases in lib/portfolio.ts).
        #
        # PUBLIC PAGE PRIVACY: /consensus renders each top_holder as a link to
        # its portfolio page, so only *public* portfolios may be named here.
        # Private portfolios still count toward num_agents / pct_agents (the
        # aggregate totals), but are omitted from the named holder list — a
        # holder with no is_public key defaults to excluded, fail-closed.
        scored = []
        for h in holdings:
            if not h.get("is_public"):
                continue
            q = _safe_float(h.get("quantity")) or 0.0
            c = _safe_float(h.get("avg_cost_usd")) or 0.0
            mtm = q * (current_price if current_price is not None else c)
            scored.append({
                "handle": h.get("handle"),
                "display_name": h.get("display_name"),
                "mtm_usd": round(mtm, 2),
            })
        scored.sort(key=lambda x: x["mtm_usd"], reverse=True)

        out.append({
            "ticker": ticker,
            "num_agents": len(holdings),
            "total_agents": total_agents,
            "pct_agents": (
                round(len(holdings) / total_agents * 100, 2)
                if total_agents > 0 else 0.0
            ),
            "total_quantity": round(sum_qty, 6),
            "swarm_avg_entry": (
                round(swarm_avg_entry, 4) if swarm_avg_entry is not None else None
            ),
            "current_price": (
                round(current_price, 4) if current_price is not None else None
            ),
            "swarm_pnl_pct": (
                round(swarm_pnl_pct, 2) if swarm_pnl_pct is not None else None
            ),
            "top_holders": scored,
        })

    # Rank: most-held first; tiebreak by aggregate MTM (sum_qty * current_price).
    def sort_key(row: dict) -> tuple:
        price = row.get("current_price") or 0
        agg_mtm = (row.get("total_quantity") or 0) * price
        return (-row["num_agents"], -agg_mtm)

    out.sort(key=sort_key)
    for i, row in enumerate(out, start=1):
        row["rank"] = i
    return out, total_agents


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Aggregate and log, but don't write to the database",
    )
    parser.add_argument(
        "--snapshot-date",
        type=str,
        default=None,
        help="ISO date for the snapshot (defaults to today)",
    )
    args = parser.parse_args()

    snapshot_date = args.snapshot_date or date.today().isoformat()
    logger = setup_logging(snapshot_date)
    logger.info(
        "=== consensus_snapshot started (date=%s, dry_run=%s) ===",
        snapshot_date,
        args.dry_run,
    )

    started = time.time()
    db = SupabaseDB()
    raw = db.fetch_holdings_with_agent_company()
    logger.info("Fetched %d raw holding rows", len(raw))

    consensus_rows, total_agents = aggregate(raw)
    logger.info(
        "Aggregated into %d ticker rows across %d distinct agents",
        len(consensus_rows),
        total_agents,
    )

    for r in consensus_rows[:10]:
        logger.info(
            "  #%d %s — %d agents (%.1f%%), avg_entry=%s, price=%s, pnl=%s%%",
            r["rank"],
            r["ticker"],
            r["num_agents"],
            r["pct_agents"],
            r["swarm_avg_entry"],
            r["current_price"],
            r["swarm_pnl_pct"],
        )

    # Fail loud on an empty aggregation. Without this, a change to the holdings
    # source (as happened when `agent_holdings` was drained in favour of
    # `portfolio_holdings`) makes every run write zero rows, the reads fall back
    # to the last non-empty snapshot, and the /consensus page + the Moltbook
    # consensus post silently freeze on stale data for weeks. Refuse to
    # "succeed" on nothing: leave the previous snapshot intact and exit non-zero
    # so the scheduled job goes red.
    if not consensus_rows:
        logger.error(
            "ABORT: aggregation produced 0 consensus rows from %d raw holdings "
            "(total_agents=%d). Refusing to write an empty snapshot — the "
            "holdings source likely changed. Previous snapshot left intact.",
            len(raw), total_agents,
        )
        if not args.dry_run:
            db.log_run("consensus_snapshot", {
                "updated": 0,
                "skipped": 0,
                "errors": 1,
                "duration_secs": round(time.time() - started, 2),
                "details": {
                    "snapshot_date": snapshot_date,
                    "total_agents": total_agents,
                    "raw_rows": len(raw),
                    "reason": "zero_rows",
                },
            })
        return 1

    rows_for_db = [{"snapshot_date": snapshot_date, **r} for r in consensus_rows]

    if args.dry_run:
        logger.info("[dry-run] skipping write of %d rows", len(rows_for_db))
    else:
        db.replace_consensus_snapshot(snapshot_date, rows_for_db)
        logger.info("Wrote %d rows to consensus_snapshots", len(rows_for_db))

    duration = time.time() - started
    if not args.dry_run:
        db.log_run("consensus_snapshot", {
            "updated": len(rows_for_db),
            "skipped": 0,
            "errors": 0,
            "duration_secs": round(duration, 2),
            "details": {
                "snapshot_date": snapshot_date,
                "total_agents": total_agents,
                "tickers": len(rows_for_db),
            },
        })
    logger.info("=== done in %.1fs ===", duration)
    return 0


if __name__ == "__main__":
    sys.exit(main())
