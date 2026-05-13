#!/usr/bin/env python3
"""CLI: stage 3 — summarize a shortlist run + journal a heartbeat row.

Runs after the matrix of per-ticker `evaluate_ticker` jobs has completed.
Aggregates the `tauric_decisions` rows for the shortlist_run_id and
writes one journal row into `agent_heartbeats` for visibility / parity
with the old monolithic flow.

Usage:
    python trading_agents_summarize.py \
        --handle tauric-opus-4-7 \
        --shortlist-run-id <uuid>
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone

from dotenv import load_dotenv

from db import SupabaseDB
from trading_agents_strategy import summarize_shortlist_run


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--handle", required=True)
    parser.add_argument("--shortlist-run-id", required=True)
    parser.add_argument(
        "--no-heartbeat", action="store_true",
        help="Don't write an agent_heartbeats journal row (default writes one).",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    db = SupabaseDB()
    agent = db.get_agent_by_handle(args.handle)
    if not agent:
        print(f"agent not found: {args.handle}", file=sys.stderr)
        return 2

    summary = summarize_shortlist_run(
        db, agent_id=agent["id"], shortlist_run_id=args.shortlist_run_id,
    )
    print(json.dumps(summary, indent=2, default=str))

    if args.no_heartbeat:
        return 0

    # Decide final status for the journal row.
    by_outcome = summary["by_outcome"]
    buys = by_outcome.get("bought", 0)
    sells = by_outcome.get("sold", 0)
    errors_in_status = summary["by_status"].get("error", 0)
    pending = summary["by_status"].get("pending", 0)
    evaluating = summary["by_status"].get("evaluating", 0)
    stuck = pending + evaluating  # never finished — incomplete run

    if errors_in_status == 0 and stuck == 0:
        status = "ok"
    elif buys + sells > 0:
        status = "ok"  # partial success — some trades landed
    else:
        status = "error"

    now_iso = datetime.now(timezone.utc).isoformat()
    journal_row = {
        "agent_id": agent["id"],
        "strategy": "trading_agents",
        "started_at": now_iso,
        "finished_at": now_iso,
        "status": status,
        "trades_executed": buys + sells,
        "buys": buys,
        "sells": sells,
        "notes": {
            "mode": "per_ticker",
            "shortlist_run_id": args.shortlist_run_id,
            "summary": summary,
        },
        "error_message": None,
    }
    db.client.table("agent_heartbeats").insert(journal_row).execute()
    # Also update agents.last_heartbeat_at so the interval guard ticks.
    db.client.table("agents").update({"last_heartbeat_at": now_iso}).match(
        {"id": agent["id"]}
    ).execute()
    logging.info(
        "summarize %s: status=%s buys=%d sells=%d errors=%d stuck=%d",
        args.handle, status, buys, sells, errors_in_status, stuck,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
