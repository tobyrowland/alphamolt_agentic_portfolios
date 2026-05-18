#!/usr/bin/env python3
"""Agent heartbeat — scheduled portfolio rebalance loop.

Iterates over every row in the `agents` table. For each agent:

    1. Skip if `strategy` is NULL (manually-managed agent).
    2. Skip if `last_heartbeat_at` is newer than
       `NOW() - heartbeat_interval_hours` (not due yet), unless `--force`.
    3. Dispatch to the named strategy in ``agent_strategies.STRATEGIES``.
    4. Journal the run in `agent_heartbeats` and update
       `agents.last_heartbeat_at`.

Designed to run daily (07:00 UTC) via
``.github/workflows/agent-heartbeat.yml``; each agent — and each human
portfolio member — only rebalances when its own ``heartbeat_interval_hours``
cadence is due, so a daily run is mostly cheap no-op skips. Safe to run
ad-hoc for a single agent.

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

from agent_strategies import (
    RebalanceContext,
    RebalanceResult,
    get_strategy,
    strategy_phase,
)
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
    portfolio_id: str | None = None,
    advance_agent: bool = True,
) -> None:
    notes = dict(result.notes) if result else {}
    # For human-portfolio member runs, tag the journal with the portfolio.
    if portfolio_id:
        notes["portfolio_id"] = portfolio_id
    row = {
        "agent_id": agent_id,
        "strategy": strategy,
        "started_at": started_at.isoformat(),
        "finished_at": _now_utc().isoformat(),
        "status": status,
        "trades_executed": (result.trades if result else 0),
        "buys": (result.buys if result else 0),
        "sells": (result.sells if result else 0),
        "notes": notes,
        "error_message": error_message,
    }
    db.insert_agent_heartbeat(row)
    # Update last_heartbeat_at on every persisted attempt — success or error.
    # This honours the agents.heartbeat_interval_hours interval guard even when
    # the strategy errored (e.g. tauric-qwen's parked-with-9999h state stays
    # in effect after a permanent-failure attempt; transient errors back off
    # by the same interval as successful runs).
    #
    # advance_agent is False for human-portfolio member runs: those track
    # cadence per (portfolio, agent) membership via
    # portfolio_agents.last_heartbeat_at (an agent can be a member of
    # several portfolios), so the shared agents row is left untouched.
    if not dry_run and advance_agent:
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


def _member_is_due(agent: dict, member_last: str | None, now: datetime) -> bool:
    """Whether a portfolio member is due to rebalance, on its own cadence.

    Gates on the per-membership last-run (``portfolio_agents.last_heartbeat_at``,
    passed as ``member_last``) and the agent's ``heartbeat_interval_hours``.
    A NULL last-run (never run in this portfolio) or NULL interval is due.
    """
    last = _parse_ts(member_last)
    if last is None:
        return True
    interval = agent.get("heartbeat_interval_hours")
    if interval is None:
        return True
    return now >= last + timedelta(hours=int(interval))


def _run_portfolio(
    db: SupabaseDB,
    pm: PortfolioManager,
    portfolio: dict,
    *,
    force: bool,
    dry_run: bool,
    logger: logging.Logger,
) -> dict[str, int]:
    """Rebalance one launched human portfolio.

    Each member agent runs its own strategy against the *shared* portfolio
    book — so a later member sees the trades earlier members made. Members
    are gated individually on their own cadence (the per-membership clock
    ``portfolio_agents.last_heartbeat_at`` plus the agent's
    ``heartbeat_interval_hours``), so e.g. a daily curator and a weekly
    buyer coexist in one portfolio. Curate-phase members run before
    trade-phase ones, so on a day both are due the buyer sees the fresh
    shortlist. Returns a status-count dict.
    """
    counts = {"ok": 0, "dry-run": 0, "skipped": 0, "error": 0}
    slug = portfolio.get("slug") or portfolio["id"][:8]

    member_entries = db.get_portfolio_members(portfolio["id"])
    mandate = portfolio.get("description")

    # Run curate-phase members (e.g. watchlist_curator) before trade-phase
    # ones. Stable sort preserves joined_at order within each phase.
    _phase_rank = {"curate": 0, "trade": 1}
    member_entries.sort(
        key=lambda e: _phase_rank.get(
            strategy_phase(e["agent"].get("strategy")), 1
        ),
    )
    member_agents = [e["agent"] for e in member_entries]
    logger.info("  portfolio %-22s %d member(s)", slug, len(member_entries))

    ran_any = False
    for entry in member_entries:
        member = entry["agent"]
        handle = member.get("handle", member["id"][:8])
        strategy_name = member.get("strategy")
        started = _now_utc()

        if not strategy_name:
            logger.info("    %-22s skip (no strategy)", handle)
            counts["skipped"] += 1
            continue
        # trading_agents runs from its own long-timeout workflow.
        if strategy_name == "trading_agents":
            logger.info("    %-22s skip (trading_agents)", handle)
            counts["skipped"] += 1
            continue
        # Per-membership cadence guard (migration 029): a member only
        # rebalances when its own heartbeat_interval_hours is due here.
        if not force and not _member_is_due(
            member, entry.get("member_last_heartbeat_at"), started
        ):
            logger.info(
                "    %-22s skip (last=%s, interval=%sh)",
                handle,
                entry.get("member_last_heartbeat_at") or "never",
                member.get("heartbeat_interval_hours"),
            )
            counts["skipped"] += 1
            continue

        strategy = get_strategy(strategy_name)
        if strategy is None:
            logger.error(
                "    %-22s ERROR unknown strategy: %s", handle, strategy_name
            )
            _journal(
                db, agent_id=member["id"], strategy=strategy_name,
                started_at=started, status="error",
                error_message=f"unknown strategy: {strategy_name}",
                portfolio_id=portfolio["id"], advance_agent=False,
                dry_run=dry_run,
            )
            if not dry_run:
                db.update_portfolio_member_heartbeat(
                    portfolio["id"], member["id"], _now_utc().isoformat()
                )
            counts["error"] += 1
            ran_any = True
            continue

        ctx = RebalanceContext(
            db=db, pm=pm, agent=member, dry_run=dry_run,
            params=dict(member.get("config") or {}),
            portfolio_id=portfolio["id"],
            members=member_agents,
            mandate=mandate,
        )
        try:
            result = strategy(ctx)
        except Exception as exc:  # noqa: BLE001
            logger.exception("    %-22s strategy crashed", handle)
            _journal(
                db, agent_id=member["id"], strategy=strategy_name,
                started_at=started, status="error",
                error_message=f"{exc}\n{traceback.format_exc()}",
                portfolio_id=portfolio["id"], advance_agent=False,
                dry_run=dry_run,
            )
            if not dry_run:
                db.update_portfolio_member_heartbeat(
                    portfolio["id"], member["id"], _now_utc().isoformat()
                )
            counts["error"] += 1
            ran_any = True
            continue

        status = (
            "dry-run" if dry_run else ("ok" if not result.errors else "error")
        )
        logger.info(
            "    %-22s %s  buys=%d sells=%d errors=%d",
            handle, status, result.buys, result.sells, len(result.errors),
        )
        _journal(
            db, agent_id=member["id"], strategy=strategy_name,
            started_at=started, status=status, result=result,
            error_message="; ".join(result.errors) if result.errors else None,
            portfolio_id=portfolio["id"], advance_agent=False, dry_run=dry_run,
        )
        if not dry_run:
            db.update_portfolio_member_heartbeat(
                portfolio["id"], member["id"], _now_utc().isoformat()
            )
        counts[status] = counts.get(status, 0) + 1
        ran_any = True

    # Stamp the portfolio's clock when at least one member actually ran —
    # informational ("last activity"); the per-member clocks are the gate.
    if not dry_run and ran_any:
        db.update_portfolio_last_heartbeat(
            portfolio["id"], _now_utc().isoformat()
        )

    return counts


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
        # The pipeline strategies (watchlist_curator / watchlist_buyer) only
        # make sense operating a shared human portfolio — their legacy 1:1
        # agent account has no mandate and no watchlist, so they'd no-op.
        # Skip them in Pass 1; they run in Pass 2 as portfolio members.
        agents = [
            a for a in agents
            if a.get("strategy") not in ("watchlist_curator", "watchlist_buyer")
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

    # Second pass: launched human-owned portfolios (migration 025). Each
    # member agent rebalances the shared book in joined_at order. Skipped for
    # a single --handle invocation (that targets one legacy agent).
    if not args.handle:
        portfolios = db.get_launched_human_portfolios()
        logger.info("=== human portfolios: %d launched ===", len(portfolios))
        for portfolio in portfolios:
            pcounts = _run_portfolio(
                db, pm, portfolio,
                force=args.force, dry_run=args.dry_run, logger=logger,
            )
            for key, val in pcounts.items():
                counts[key] = counts.get(key, 0) + val

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
