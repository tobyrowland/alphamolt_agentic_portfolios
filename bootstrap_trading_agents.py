#!/usr/bin/env python3
"""Bootstrap the three Tauric Trader house agents.

Inserts (or updates, idempotently) three rows in `agents`:

    tauric-opus-4-7    Tauric Trader (Claude Opus 4.7)
    tauric-gemini-3    Tauric Trader (Gemini 3 Pro)
    tauric-qwen        Tauric Trader (Qwen 3)

Each row is wired to the `trading_agents` strategy with a `config` JSONB
specifying its LLM brain. After insertion, every variant gets a $1M
paper-money account opened via `PortfolioManager.open_account`.

Existing rows are detected by handle and left untouched — re-running is
safe. No existing agents are modified by this script.

Usage:
    python bootstrap_trading_agents.py             # insert + open accounts
    python bootstrap_trading_agents.py --dry-run   # print what would change
"""

from __future__ import annotations

import argparse
import logging
import sys

from dotenv import load_dotenv

from db import SupabaseDB
from portfolio import DEFAULT_STARTING_CASH, PortfolioManager

UPSTREAM_REPO_URL = "https://github.com/TauricResearch/TradingAgents"

# Short chip rendered on the leaderboard. The `{brain}` placeholder is
# substituted per-variant below. Keep under ~500 chars to stay within the
# createAgent validator's existing cap (see migration 010).
DESCRIPTION_TEMPLATE = (
    "Tauric Trader is a reference implementation of the open-source "
    "TauricResearch/TradingAgents multi-agent framework (Apache 2.0, "
    f"{UPSTREAM_REPO_URL}). Brain: {{brain}}."
)

# Longer narrative for the agent profile page. Markdown-friendly.
LONG_DESCRIPTION_TEMPLATE = (
    "Built on the **TauricResearch/TradingAgents** framework — a multi-agent "
    "debate system pairing fundamental, sentiment, news and technical analysts "
    "with bull/bear researchers, a trader and a risk manager. This variant "
    "runs the framework unchanged with **{brain}** as its deep-think model.\n\n"
    "Each week it picks ~30 candidates from the alphamolt screener, then runs "
    "the full multi-analyst debate per ticker to derive BUY/SELL/HOLD "
    f"decisions.\n\nFramework: {UPSTREAM_REPO_URL}"
)


# (handle, display_name, brain_label, config)
VARIANTS: list[tuple[str, str, str, dict]] = [
    (
        "tauric-opus-4-7",
        "Tauric Trader (Claude Opus 4.7)",
        "Claude Opus 4.7",
        {
            "llm_provider": "anthropic",
            "deep_think_llm": "claude-opus-4-7",
            "quick_think_llm": "claude-haiku-4-5-20251001",
            "max_debate_rounds": 2,
            "max_candidates": 30,
            "max_positions": 20,
            "cash_reserve_pct": 0.02,
            "online_tools": True,
        },
    ),
    (
        "tauric-gemini-3",
        "Tauric Trader (Gemini 3 Pro)",
        "Gemini 3 Pro",
        {
            "llm_provider": "google",
            "deep_think_llm": "gemini-3-pro",
            "quick_think_llm": "gemini-3-flash",
            "max_debate_rounds": 2,
            "max_candidates": 30,
            "max_positions": 20,
            "cash_reserve_pct": 0.02,
            "online_tools": True,
        },
    ),
    (
        "tauric-qwen",
        "Tauric Trader (Qwen 3)",
        "Qwen 3",
        {
            "llm_provider": "qwen",
            "deep_think_llm": "qwen3-max",
            "quick_think_llm": "qwen3-turbo",
            "backend_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            "max_debate_rounds": 2,
            "max_candidates": 30,
            "max_positions": 20,
            "cash_reserve_pct": 0.02,
            "online_tools": True,
        },
    ),
]


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print rows that would be inserted, without writing.",
    )
    parser.add_argument(
        "--starting-cash",
        type=float,
        default=DEFAULT_STARTING_CASH,
        help=f"Starting cash per agent (default ${DEFAULT_STARTING_CASH:,.0f})",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logger = logging.getLogger("bootstrap_trading_agents")

    db = SupabaseDB()
    pm = PortfolioManager(db)

    inserted = 0
    existed = 0
    opened_accounts = 0

    for handle, display_name, brain, config in VARIANTS:
        description = DESCRIPTION_TEMPLATE.format(brain=brain)
        long_description = LONG_DESCRIPTION_TEMPLATE.format(brain=brain)

        existing = db.get_agent_by_handle(handle)
        if existing:
            existed += 1
            logger.info(
                "  %-20s  (already exists, id=%s — leaving row untouched)",
                handle,
                existing["id"][:8],
            )
            agent_id = existing["id"]
        else:
            row = {
                "handle": handle,
                "display_name": display_name,
                "description": description,
                "long_description": long_description,
                "is_house_agent": True,
                "api_key_hash": "house-agent",
                "api_key_prefix": f"ak_house_{handle.split('-')[0][:8]}",
                "strategy": "trading_agents",
                "heartbeat_interval_hours": 168,
                "config": config,
            }
            if args.dry_run:
                logger.info("  %-20s  [dry-run] would insert: %s", handle, row)
                inserted += 1
                continue
            resp = db.client.table("agents").insert(row).execute()
            if not resp.data:
                logger.error("  %-20s  insert returned no row", handle)
                continue
            agent_id = resp.data[0]["id"]
            inserted += 1
            logger.info(
                "  %-20s  ✓ inserted (id=%s, brain=%s)",
                handle,
                agent_id[:8],
                brain,
            )

        # Open paper-money account (idempotent — open_account no-ops if a
        # row already exists for this agent_id).
        if args.dry_run:
            continue
        before = db.get_agent_account(agent_id)
        pm.open_account(agent_id, starting_cash=args.starting_cash)
        if not before:
            opened_accounts += 1
            logger.info(
                "  %-20s  ✓ opened paper account with $%.2f",
                handle,
                args.starting_cash,
            )

    logger.info(
        "Bootstrap complete: %d inserted, %d already existed, %d new paper accounts opened",
        inserted,
        existed,
        opened_accounts,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
