#!/usr/bin/env python3
"""Rebuild `agent_portfolio_history.flow_usd` + `twr_index` from history.

Run once after migration 090; safe to re-run at any time. It recomputes each
portfolio's whole series from the snapshots and the cash ledger, so it is also
the repair tool if a day's writer was interrupted or a historical row was
corrected.

It shares `returns.twr_index` with the daily writer's `returns.advance_index`,
and `tests/test_returns.py` pins that those two agree step for step — a
backfill that used its own arithmetic would give a portfolio a different
history depending on which process last touched it.

    python backfill_twr.py --dry-run     # print what would change
    python backfill_twr.py               # write it
    python backfill_twr.py --portfolio <uuid>
"""
from __future__ import annotations

import argparse
import logging
import sys
from collections import defaultdict

from dotenv import load_dotenv

from db import SupabaseDB
from returns import Point, pct_from_index, twr_index

logger = logging.getLogger("backfill_twr")


def _flows_by_portfolio_date(db: SupabaseDB) -> dict[tuple[str, str], float]:
    """Net external flow keyed by (portfolio_id, date), from the ledger.

    A `baseline-reset` row corrects a number rather than moving money, so it is
    excluded — counting it would delete a return the portfolio really earned.
    """
    resp = (
        db.client.table("portfolio_cash_ledger")
        .select("portfolio_id, delta_usd, reason, created_at")
        .execute()
    )
    out: dict[tuple[str, str], float] = defaultdict(float)
    for row in resp.data or []:
        if (row.get("reason") or "") in db.NON_FLOW_LEDGER_REASONS:
            continue
        pid, created = row.get("portfolio_id"), row.get("created_at")
        if not pid or not created:
            continue
        out[(pid, str(created)[:10])] += float(row.get("delta_usd") or 0)
    return dict(out)


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="Compute, write nothing")
    ap.add_argument("--portfolio", type=str, default=None, help="Only this portfolio id")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
    )
    db = SupabaseDB()

    flows = _flows_by_portfolio_date(db)
    rows = db._paginate(
        "agent_portfolio_history",
        "portfolio_id, snapshot_date, total_value_usd, flow_usd, twr_index",
        order="snapshot_date",
    )
    if args.portfolio:
        rows = [r for r in rows if r.get("portfolio_id") == args.portfolio]

    by_portfolio: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_portfolio[r["portfolio_id"]].append(r)

    updates: list[dict] = []
    for pid, series in by_portfolio.items():
        series.sort(key=lambda r: r["snapshot_date"])
        points = [
            Point(
                float(r["total_value_usd"] or 0),
                flows.get((pid, r["snapshot_date"]), 0.0),
            )
            for r in series
        ]
        index = twr_index(points)
        for r, pt, idx in zip(series, points, index):
            updates.append({
                "portfolio_id": pid,
                "snapshot_date": r["snapshot_date"],
                "flow_usd": round(pt.flow, 2),
                "twr_index": round(idx, 10),
            })
        logger.info(
            "%s: %d snapshots, %d flow days, TWR %s%%",
            pid, len(series),
            sum(1 for p in points if p.flow),
            pct_from_index(index[-1]) if index else "—",
        )

    if args.dry_run:
        logger.info("[dry-run] %d rows would be updated", len(updates))
        return 0

    # Upsert in chunks on the (portfolio_id, snapshot_date) primary key. Only
    # the two new columns are sent, so a concurrent valuation run rewriting
    # today's value is not clobbered by a stale figure from this pass.
    written = 0
    for i in range(0, len(updates), 500):
        chunk = updates[i : i + 500]
        (
            db.client.table("agent_portfolio_history")
            .upsert(chunk, on_conflict="portfolio_id,snapshot_date")
            .execute()
        )
        written += len(chunk)
    logger.info("Wrote %d rows across %d portfolios", written, len(by_portfolio))
    return 0


if __name__ == "__main__":
    sys.exit(main())
