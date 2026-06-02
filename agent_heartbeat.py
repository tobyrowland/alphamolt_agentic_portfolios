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
    python agent_heartbeat.py --portfolio my-slug # one portfolio (Pass 2 only)
    python agent_heartbeat.py --force             # ignore interval guard
    python agent_heartbeat.py --dry-run           # plan only, no trades
    python agent_heartbeat.py --manual            # tag rows triggered_by=manual
"""

from __future__ import annotations

import argparse
import logging
import os
import re
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


# Master kill-switch for routing real orders. A portfolio with mode='live'
# only places real Alpaca orders when this env var is truthy in the run
# environment — so flipping a portfolio live in the DB is NOT enough on its
# own; the operator must also enable execution where the heartbeat runs.
_LIVE_EXEC_ENV = "ALPACA_LIVE_EXECUTION_ENABLED"


def _resolve_live_executor(portfolio: dict, *, dry_run: bool):
    """Decide whether this portfolio's trades route to a real broker.

    Returns ``(mode, executor)``. ``mode='live'`` with a live executor only
    when ALL of: the portfolio is ``mode='live'``, it's not a dry run, and the
    master env switch is set. Any miss falls back to ``('paper', None)`` so the
    swarm trades the simulated book and never places a real order by surprise.
    """
    log = logging.getLogger("agent_heartbeat")
    mode = (portfolio.get("mode") or "paper").lower()
    slug = portfolio.get("slug") or portfolio["id"][:8]
    if mode != "live":
        return "paper", None
    if dry_run:
        log.info("portfolio %s is live but this is a dry run — paper.", slug)
        return "paper", None
    if os.environ.get(_LIVE_EXEC_ENV, "").strip().lower() not in (
        "1", "true", "yes", "on",
    ):
        log.warning(
            "portfolio %s is mode='live' but %s is not set — trading PAPER "
            "this run (no real orders placed).", slug, _LIVE_EXEC_ENV,
        )
        return "paper", None
    try:
        from alpaca_execution import AlpacaExecutionBackend

        backend = AlpacaExecutionBackend()
        log.warning(
            "LIVE EXECUTION ENABLED for portfolio %s — placing REAL orders "
            "via Alpaca (%s endpoint).",
            slug, "paper-sandbox" if backend.client.is_paper else "LIVE",
        )
        return "live", backend
    except Exception as exc:  # noqa: BLE001 — never crash the heartbeat on broker init
        log.error(
            "portfolio %s: failed to init Alpaca executor (%s) — trading "
            "PAPER this run.", slug, exc,
        )
        return "paper", None


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
    triggered_by: str | None = None,
) -> None:
    notes = dict(result.notes) if result else {}
    # For human-portfolio member runs, tag the journal with the portfolio.
    if portfolio_id:
        notes["portfolio_id"] = portfolio_id
    # Tag manually-triggered runs (workflow_dispatch via the "Run now" button)
    # so the UI can distinguish them from scheduled rebalances.
    if triggered_by:
        notes["triggered_by"] = triggered_by
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
    # advance_agent is False for human-portfolio member runs: those rebalance
    # on the *portfolio's* cadence (portfolios.last_heartbeat_at), and an
    # agent may be a member of several portfolios, so its own clock must not
    # be touched here.
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
    triggered_by: str | None = None,
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
            triggered_by=triggered_by,
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
            triggered_by=triggered_by,
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
        triggered_by=triggered_by,
    )
    return status


# Human portfolios rebalance weekly, matching the default agent cadence.
PORTFOLIO_HEARTBEAT_INTERVAL_HOURS = 168


def _portfolio_is_due(portfolio: dict, now: datetime) -> bool:
    last = _parse_ts(portfolio.get("last_heartbeat_at"))
    if last is None:
        return True
    return now >= last + timedelta(hours=PORTFOLIO_HEARTBEAT_INTERVAL_HOURS)


def _run_portfolio(
    db: SupabaseDB,
    pm: PortfolioManager,
    portfolio: dict,
    *,
    force: bool,
    dry_run: bool,
    logger: logging.Logger,
    handle_filter: str | None = None,
    triggered_by: str | None = None,
) -> dict[str, int]:
    """Rebalance one launched human portfolio.

    Each member agent runs its own strategy, in portfolio_agents.joined_at
    order, against the *shared* portfolio book — so a later member sees the
    trades earlier members already made. Returns a status-count dict.

    When `handle_filter` is set, only the matching member runs and all
    others are silently skipped (no counts bump) — used by the "Run now"
    button to target a single (portfolio, agent) pair.
    """
    counts = {"ok": 0, "dry-run": 0, "skipped": 0, "error": 0}
    slug = portfolio.get("slug") or portfolio["id"][:8]

    if not force and not _portfolio_is_due(portfolio, _now_utc()):
        logger.info("  portfolio %-22s skip (not due)", slug)
        counts["skipped"] += 1
        return counts

    members = [m["agent"] for m in db.get_portfolio_members(portfolio["id"])]
    mandate = portfolio.get("description")
    if handle_filter:
        members = [m for m in members if m.get("handle") == handle_filter]
    logger.info("  portfolio %-22s %d member(s)", slug, len(members))

    for member in members:
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
                dry_run=dry_run, triggered_by=triggered_by,
            )
            counts["error"] += 1
            continue

        mode, executor = _resolve_live_executor(portfolio, dry_run=dry_run)
        ctx = RebalanceContext(
            db=db, pm=pm, agent=member, dry_run=dry_run,
            params=dict(member.get("config") or {}),
            portfolio_id=portfolio["id"],
            members=members,
            mandate=mandate,
            mode=mode,
            executor=executor,
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
                dry_run=dry_run, triggered_by=triggered_by,
            )
            counts["error"] += 1
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
            triggered_by=triggered_by,
        )
        counts[status] = counts.get(status, 0) + 1

    # Stamp the portfolio's heartbeat clock once, after every member ran.
    # Skipped when `handle_filter` is set: a "Run now" on one member must
    # not satisfy the weekly cadence for the rest of the portfolio.
    if not dry_run and not handle_filter:
        db.update_portfolio_last_heartbeat(
            portfolio["id"], _now_utc().isoformat()
        )

    return counts


_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _resolve_portfolio(db: SupabaseDB, id_or_slug: str) -> dict | None:
    """Resolve a portfolio by UUID first, then slug. UUID detect via regex."""
    if _UUID_RE.match(id_or_slug):
        portfolio = db.get_portfolio_by_id(id_or_slug)
        if portfolio:
            return portfolio
    return db.get_portfolio_by_slug(id_or_slug)


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--handle",
        help="Run only the agent with this handle (still respects --force/interval)",
    )
    parser.add_argument(
        "--portfolio",
        help="Run only this portfolio (id or slug). Skips Pass 1 entirely; "
        "combine with --handle to target a single (portfolio, agent) pair.",
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
    parser.add_argument(
        "--manual",
        action="store_true",
        help="Tag every agent_heartbeats row written during this run with "
        "notes.triggered_by='manual' (used by the 'Run now' button)",
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
    triggered_by = "manual" if args.manual else None

    # --portfolio short-circuits Pass 1 entirely. Resolve the portfolio once
    # and run only Pass 2 against it, optionally filtered to a single member.
    if args.portfolio:
        portfolio = _resolve_portfolio(db, args.portfolio)
        if not portfolio:
            logger.error("No portfolio with id-or-slug '%s'", args.portfolio)
            return 1
        slug = portfolio.get("slug") or portfolio["id"][:8]
        logger.info(
            "=== agent_heartbeat (portfolio=%s, handle=%s, dry_run=%s, "
            "force=%s, manual=%s) ===",
            slug, args.handle or "—", args.dry_run, args.force, args.manual,
        )

        start = time.time()
        pcounts = _run_portfolio(
            db, pm, portfolio,
            force=args.force, dry_run=args.dry_run, logger=logger,
            handle_filter=args.handle, triggered_by=triggered_by,
        )
        counts = {"ok": 0, "dry-run": 0, "skipped": 0, "error": 0}
        for key, val in pcounts.items():
            counts[key] = counts.get(key, 0) + val

        elapsed = round(time.time() - start, 1)
        logger.info(
            "=== done: ok=%d dry-run=%d skipped=%d error=%d (%.1fs) ===",
            counts["ok"], counts["dry-run"], counts["skipped"],
            counts["error"], elapsed,
        )
        return 0 if counts["error"] == 0 else 1

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
        "=== agent_heartbeat: %d agents (dry_run=%s, force=%s, manual=%s) ===",
        len(agents), args.dry_run, args.force, args.manual,
    )

    start = time.time()
    counts = {"ok": 0, "dry-run": 0, "skipped": 0, "error": 0}
    for agent in agents:
        status = _run_one(
            db, pm, agent,
            force=args.force,
            dry_run=args.dry_run,
            logger=logger,
            triggered_by=triggered_by,
        )
        counts[status] = counts.get(status, 0) + 1

    # Second pass: human-owned portfolios (migration 025 + 031). Each
    # member agent rebalances the shared book in joined_at order. Skipped for
    # a single --handle invocation (that targets one legacy agent). Every
    # human portfolio is funded with $1M at creation (migration 031 RPC
    # `create_portfolio_funded` + draft-portfolio backfill).
    if not args.handle:
        portfolios = db.get_human_portfolios()
        logger.info("=== human portfolios: %d ===", len(portfolios))
        for portfolio in portfolios:
            pcounts = _run_portfolio(
                db, pm, portfolio,
                force=args.force, dry_run=args.dry_run, logger=logger,
                triggered_by=triggered_by,
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
