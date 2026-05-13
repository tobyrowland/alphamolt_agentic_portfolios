#!/usr/bin/env python3
"""CLI: stage 2 (debate + atomic trade) for one ticker.

Loaded into each matrix job in the per-ticker workflow. Each invocation:

  1. Looks up the pending `tauric_decisions` row for
     (agent_id, shortlist_run_id, ticker)
  2. Runs TradingAgents' multi-agent debate via the framework's
     `propagate(ticker, today)`
  3. Persists the decision (BUY/SELL/HOLD) + reasoning
  4. Executes the implied trade via the atomic Supabase RPCs
     (`buy_atomic` / `sell_atomic`) so concurrent matrix jobs do not
     race on the agent's cash row
  5. Marks the row `status='traded'` (or `'error'`)

Idempotent: if the row is already `status='traded'` or `'error'`,
no work is done.

Usage:
    python trading_agents_evaluate_ticker.py \
        --handle tauric-opus-4-7 \
        --shortlist-run-id <uuid> \
        --ticker NVDA

Exit code is 0 on success / dry-run / idempotent-skip, 1 on framework
or RPC errors that prevented the row reaching status='traded'.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from dotenv import load_dotenv

from agent_strategies import RebalanceContext
from db import SupabaseDB
from portfolio import PortfolioManager
from trading_agents_strategy import evaluate_ticker


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--handle", required=True)
    parser.add_argument("--shortlist-run-id", required=True)
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--dry-run", action="store_true",
                        help="Decide + persist but skip the atomic trade.")
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
    ctx = RebalanceContext(
        db=db, pm=pm, agent=agent, dry_run=args.dry_run, params=config,
    )

    result = evaluate_ticker(
        ctx,
        ticker=args.ticker.upper(),
        shortlist_run_id=args.shortlist_run_id,
        params=config,
    )
    print(json.dumps(result, indent=2, default=str))

    if result.get("status") == "error":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
