#!/usr/bin/env python3
"""Agent heartbeat — scheduled portfolio rebalance loop.

Iterates over every row in the `agents` table. For each agent:

    1. Skip if `strategy` is NULL (manually-managed agent).
    2. Skip if `last_heartbeat_at` is newer than
       `NOW() - heartbeat_interval_hours` (not due yet), unless `--force`.
    3. Dispatch to the named strategy in ``agent_strategies.STRATEGIES``.
    4. Journal the run in `agent_heartbeats` and update
       `agents.last_heartbeat_at`.

Designed to run weekly (Sundays 07:00 UTC) via
``.github/workflows/agent-heartbeat.yml`` but safe to run ad-hoc for a
single agent.

Usage::

    python agent_heartbeat.py                     # all due agents
    python agent_heartbeat.py --handle my-agent   # one agent
    python agent_heartbeat.py --force             # ignore interval guard
    python agent_heartbeat.py --dry-run           # plan only, no trades
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv

from agent_strategies import RebalanceContext, RebalanceResult, get_strategy
from db import SupabaseDB
from portfolio import PortfolioManager


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    # Supabase returns ISO-8601 with microseconds and a +00:00 offset.
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _is_due(agent: dict, now: datetime) -> bool:
    interval = agent.get("heartbeat_interval_hours")
    last = _parse_ts(agent.get("last_heartbeat_at"))
    if last is None:
        return True
    if interval is None:
        return True
    due_at = last + timedelta(hours=int(interval))
    return now >= due_at


def _journal(
    db: SupabaseDB,
    *,
    agent_id: str,
    strategy: str,
    started_at: datetime,
    status: str,
    result: RebalanceResult | None = None,
    error_message: str | None = None,
    dry_run: bool = False,
) -> None:
    row = {
        "agent_id": agent_id,
        "strategy": strategy,
        "started_at": started_at.isoformat(),
        "finished_at": _now_utc().isoformat(),
        "status": status,
        "trades_executed": (result.trades if result else 0),
        "buys": (result.buys if result else 0),
        "sells": (result.sells if result else 0),
        "notes": (result.notes if result else {}),
        "error_message": error_message,
    }
    db.insert_agent_heartbeat(row)
    # Update last_heartbeat_at on every persisted attempt — success or error.
    # This honours the agents.heartbeat_interval_hours interval guard even when
    # the strategy errored (e.g. tauric-qwen's parked-with-9999h state stays
    # in effect after a permanent-failure attempt; transient errors back off
    # by the same interval as successful runs).
    if not dry_run:
        db.update_agent_last_heartbeat(agent_id, _now_utc().isoformat())


def _run_one(
    db: SupabaseDB,
    pm: PortfolioManager,
    agent: dict,
    *,
    force: bool,
    dry_run: bool,
    logger: logging.Logger,
) -> str:
    handle = agent.get("handle", agent["id"][:8])
    strategy_name = agent.get("strategy")
    started = _now_utc()

    if not strategy_name:
        logger.info("  %-24s  skip (no strategy)", handle)
        return "skipped"

    if not force and not _is_due(agent, started):
        logger.info(
            "  %-24s  skip (last=%s, interval=%sh)",
            handle,
            agent.get("last_heartbeat_at") or "never",
            agent.get("heartbeat_interval_hours"),
        )
        return "skipped"

    strategy = get_strategy(strategy_name)
    if strategy is None:
        logger.error("  %-24s  ERROR unknown strategy: %s", handle, strategy_name)
        _journal(
            db,
            agent_id=agent["id"],
            strategy=strategy_name,
            started_at=started,
            status="error",
            error_message=f"unknown strategy: {strategy_name}",
        )
        return "error"

    # Pass agents.config (JSONB, defaults to {}) into the strategy's params
    # bag. Existing strategies (dual_positive, momentum) only consult their
    # own DEFAULTS dict keys, so unrelated config keys (provider, model,
    # picker_mode) are safely ignored.
    config = agent.get("config") or {}
    ctx = RebalanceContext(
        db=db, pm=pm, agent=agent, dry_run=dry_run, params=dict(config),
    )
    try:
        result = strategy(ctx)
    except Exception as exc:  # noqa: BLE001
        logger.exception("  %-24s  strategy crashed", handle)
        _journal(
            db,
            agent_id=agent["id"],
            strategy=strategy_name,
            started_at=started,
            status="error",
            error_message=f"{exc}\n{traceback.format_exc()}",
        )
        return "error"

    status = "dry-run" if dry_run else ("ok" if not result.errors else "error")
    logger.info(
        "  %-24s  %s  buys=%d sells=%d errors=%d",
        handle,
        status,
        result.buys,
        result.sells,
        len(result.errors),
    )
    _journal(
        db,
        agent_id=agent["id"],
        strategy=strategy_name,
        started_at=started,
        status=status,
        result=result,
        error_message="; ".join(result.errors) if result.errors else None,
        dry_run=dry_run,
    )
    return status


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--handle",
        help="Run only the agent with this handle (still respects --force/interval)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore heartbeat_interval_hours and run even if not due",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan trades and journal a 'dry-run' row, but execute no trades "
        "and do not advance last_heartbeat_at",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logger = logging.getLogger("agent_heartbeat")

    db = SupabaseDB()
    pm = PortfolioManager(db)

    if args.handle:
        agent = db.get_agent_by_handle(args.handle)
        if not agent:
            logger.error("No agent with handle '%s'", args.handle)
            return 1
        agents = [agent]
    else:
        agents = db.get_all_agents()
        # The `trading_agents` strategy (Tauric Trader variants) takes
        # 15–45 min per ticker × 15 tickers — way past this workflow's
        # timeout. They run from their dedicated `trading-agents-heartbeat`
        # workflow with a 180-min timeout instead. Explicit `--handle`
        # invocations (the dedicated workflow's matrix uses one) still
        # work because the filter is only applied to the bulk path.
        agents = [
            a for a in agents if a.get("strategy") != "trading_agents"
        ]

    logger.info(
        "=== agent_heartbeat: %d agents (dry_run=%s, force=%s) ===",
        len(agents), args.dry_run, args.force,
    )

    start = time.time()
    counts = {"ok": 0, "dry-run": 0, "skipped": 0, "error": 0}
    for agent in agents:
        status = _run_one(
            db, pm, agent,
            force=args.force,
            dry_run=args.dry_run,
            logger=logger,
        )
        counts[status] = counts.get(status, 0) + 1

    elapsed = round(time.time() - start, 1)
    logger.info(
        "=== done: ok=%d dry-run=%d skipped=%d error=%d (%.1fs) ===",
        counts["ok"], counts["dry-run"], counts["skipped"], counts["error"], elapsed,
    )

    db.log_run("agent_heartbeat", {
        "updated": counts["ok"],
        "skipped": counts["skipped"],
        "errors": counts["error"],
        "duration_secs": elapsed,
        "details": counts,
    })
    return 0 if counts["error"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
