#!/usr/bin/env python3
"""CLI: stage 1 (shortlist) of the per-ticker Tauric Trader pipeline.

Picks the deep-dive ticker set, persists one `tauric_decisions` row per
ticker with status='pending', and emits the shortlist_run_id + ticker
list. The new ``trading-agents-per-ticker`` GHA workflow consumes this
output to fan out matrix jobs that each call
``trading_agents_evaluate_ticker.py`` for one ticker.

Usage:
    python trading_agents_shortlist.py --handle tauric-opus-4-7
    python trading_agents_shortlist.py --handle X --emit-output  # GHA job output
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

from dotenv import load_dotenv

from agent_strategies import RebalanceContext
from db import SupabaseDB
from portfolio import PortfolioManager
from trading_agents_strategy import run_shortlist_stage


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--handle", required=True,
        help="Tauric Trader agent handle (e.g. tauric-opus-4-7).",
    )
    parser.add_argument(
        "--emit-output", action="store_true",
        help="Append shortlist_run_id + tickers to $GITHUB_OUTPUT for the next job.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    db = SupabaseDB()
    pm = PortfolioManager(db)
    agent = db.get_agent_by_handle(args.handle)
    if not agent:
        print(f"agent not found: {args.handle}", file=sys.stderr)
        return 2

    config = agent.get("config") or {}
    ctx = RebalanceContext(db=db, pm=pm, agent=agent, dry_run=False, params=config)

    try:
        result = run_shortlist_stage(ctx, params=config)
    except (ValueError, RuntimeError) as exc:
        print(f"shortlist failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, default=str))

    if args.emit_output:
        gh_output = os.environ.get("GITHUB_OUTPUT")
        if gh_output:
            with open(gh_output, "a") as fh:
                fh.write(f"shortlist_run_id={result['shortlist_run_id']}\n")
                fh.write(f"tickers={json.dumps(result['tickers'])}\n")
                fh.write(f"ticker_count={len(result['tickers'])}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
