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


def _mirror_live_sibling(db, pm, *, paper: dict, live: dict, dry_run: bool) -> None:
    """Mirror a paper portfolio's composition onto its live Alpaca follower.

    Gated like all live execution: never on a dry run, and only when the master
    switch is set. Market-hours and fill handling live in `alpaca_mirror`. Never
    crashes the heartbeat — a mirror failure is logged and swallowed.
    """
    log = logging.getLogger("agent_heartbeat")
    slug = live.get("slug") or live["id"][:8]
    if dry_run:
        log.info("live mirror %s skipped (dry run)", slug)
        return
    if os.environ.get(_LIVE_EXEC_ENV, "").strip().lower() not in (
        "1", "true", "yes", "on",
    ):
        log.warning(
            "live portfolio %s present but %s not set — skipping mirror "
            "(no real orders).", slug, _LIVE_EXEC_ENV,
        )
        return
    try:
        from alpaca_execution import AlpacaExecutionBackend
        from alpaca_mirror import mirror_paper_to_alpaca

        executor = AlpacaExecutionBackend.for_slug(slug, allow_shared_fallback=True)
        summary = mirror_paper_to_alpaca(
            db, pm, executor, live, paper, dry_run=False,
        )
        log.info("live mirror %s: %s", slug, summary)
    except Exception as exc:  # noqa: BLE001 — never crash the heartbeat on the mirror
        log.error("live mirror %s failed: %s", slug, exc)


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
    # the strategy errored (a parked agent's long interval-guard stays in
    # effect after a permanent-failure attempt; transient errors back off
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


# Human portfolios rebalance weekly by default, matching the default agent
# cadence. Owners can opt a portfolio into a daily cadence via the
# portfolios.rebalance_cadence toggle (migration 051).
PORTFOLIO_HEARTBEAT_INTERVAL_HOURS = 168
PORTFOLIO_CADENCE_HOURS = {"daily": 24, "weekly": 168}


def _portfolio_interval_hours(portfolio: dict) -> int:
    """The min hours between rebalances for this portfolio (migration 051).

    Reads portfolios.rebalance_cadence ('daily' | 'weekly'); anything else
    (including NULL on a pre-migration row) falls back to the weekly default.
    """
    cadence = (portfolio.get("rebalance_cadence") or "weekly").strip().lower()
    return PORTFOLIO_CADENCE_HOURS.get(cadence, PORTFOLIO_HEARTBEAT_INTERVAL_HOURS)


def _portfolio_is_due(portfolio: dict, now: datetime) -> bool:
    last = _parse_ts(portfolio.get("last_heartbeat_at"))
    if last is None:
        return True
    return now >= last + timedelta(hours=_portfolio_interval_hours(portfolio))


def _resolve_member_mandate(member_row: dict, portfolio_mandate: str | None) -> str | None:
    """The brief a member agent works to (migration 046).

    Per-agent mandates replace the old single portfolio mandate: each thinking
    agent self-briefs. Resolution mirrors params — the saved INSTANCE override
    wins, else the agent's baked-in DEFAULT, else the portfolio brief as a
    legacy fallback (for 1:1 agents that predate per-agent mandates).
    """
    override = (member_row.get("mandate") or "").strip()
    if override:
        return override
    default = ((member_row.get("agent") or {}).get("default_mandate") or "").strip()
    if default:
        return default
    return portfolio_mandate


# Cap how many top-ranked screen names a thinking (llm_watchlist_buyer) swarm
# buyer evaluates per run — bounds LLM cost/latency against the 30-min job
# timeout and keeps buyers focused on the best names (the screener already
# ranks the whole universe). Aligns with the default screen_config.topN.
MAX_SWARM_EVAL = 40
# Dust guard: the snake draft won't open a position smaller than this fraction
# of total value, so a buyer spending down the tail of the cash can't open a
# $9 sliver (mirrors llm_watchlist_buyer's min_position_pct).
MIN_DRAFT_POSITION_PCT = 0.02


def _llm_swarm_convictions(
    db: SupabaseDB,
    member_row: dict,
    cfg: dict,
    portfolio_mandate: str | None,
    pid: str,
    eval_pool: list[str],
    by_ticker_data: dict[str, dict],
    cand_map: dict[str, str],
    book: dict,
    *,
    eval_cache: dict,
    dry_run: bool,
    logger: logging.Logger,
) -> tuple[dict[str, int], dict[str, dict], float, int]:
    """Per-name LLM convictions + theses for one `llm_watchlist_buyer` in the swarm.

    Runs the SAME Phase-1 evaluation the standalone buyer uses
    (`llm_watchlist_buyer.evaluate_candidates`) over the top-N screen pool, using
    THIS buyer's own mandate + provider/model. Returns
    `(convictions{ticker: 1-5 for BUY >= gate}, evals{ticker: eval}, max_per, gate)`.

    Two deliberate safety choices: identical (provider, model, mandate) sweeps are
    cached so co-briefed buyers don't double-pay; and any eval failure degrades to
    "this buyer buys nothing this cycle" — never a fallback to the mechanical rank
    baseline, which is exactly the bug being fixed. Records true PASSes for the
    screener 30-day hide (never in dry-run).
    """
    import llm_watchlist_buyer as _llm_buyer

    aid = member_row["agent"]["id"]
    label = member_row["agent"].get("handle", aid[:8])
    bp = {**_llm_buyer.LLM_WATCHLIST_BUYER_DEFAULTS, **cfg}
    mandate_m = _resolve_member_mandate(member_row, portfolio_mandate)
    gate = int(cfg.get("convictionGate") or bp["min_conviction"])
    ps_mode = str(cfg.get("ps_vs_median_mode") or bp["ps_vs_median_mode"]).strip().lower()
    ps_pct = cfg.get("ps_vs_median_pct")
    if ps_pct is None:
        ps_pct = bp["ps_vs_median_pct"]
    max_per = float(cfg.get("target_position_pct", bp["target_position_pct"])) / 100.0

    if not eval_pool:
        return {}, {}, max_per, gate

    key = (bp["provider"], bp["model"], mandate_m or "")
    evals_list = eval_cache.get(key)
    if evals_list is None:
        try:
            evals_list, _notes = _llm_buyer.evaluate_candidates(
                provider=bp["provider"],
                model=bp["model"],
                candidates=eval_pool,
                by_ticker_data=by_ticker_data,
                combined_rationale=cand_map,
                portfolio=book,
                portfolio_mandate=mandate_m,
                params=bp,
                label=label,
            )
        except Exception as exc:  # noqa: BLE001 — a dead provider buys nothing, never mechanically
            logger.warning("swarm LLM eval failed for %s: %s", label, exc)
            evals_list = []
        eval_cache[key] = evals_list

    evals_by_ticker = {e["ticker"]: e for e in evals_list}

    # Per-buyer P/S-vs-median band (synchronous entry-price discipline). The shared
    # eval pool is cached across co-briefed buyers, so this can't pre-filter the
    # pool — it's applied here, after eval, on THIS buyer's conviction map (its band
    # may differ from a co-briefed buyer's). No-op when mode is OFF (default).
    def _value_ok(ticker: str) -> bool:
        val = (by_ticker_data.get(ticker) or {}).get("valuation") or {}
        return _llm_buyer.passes_ps_band(
            val.get("ps"), val.get("ps_median_12m"), ps_mode, ps_pct
        )

    convictions = {
        e["ticker"]: int(e["conviction"])
        for e in evals_list
        if str(e.get("verdict") or "").upper() == "BUY"
        and int(e.get("conviction") or 0) >= gate
        and _value_ok(e["ticker"])
    }

    if not dry_run:
        rej = _llm_buyer._pass_rejection_rows(evals_list, aid)
        if rej:
            try:
                db.record_screener_rejections(
                    pid, rej, days=int(bp["rejection_window_days"])
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("swarm rejection record failed for %s: %s", label, exc)

    return convictions, evals_by_ticker, max_per, gate


def _run_portfolio_swarm(
    db: SupabaseDB,
    pm: PortfolioManager,
    portfolio: dict,
    member_rows: list[dict],
    *,
    dry_run: bool,
    logger: logging.Logger,
    triggered_by: str | None = None,
) -> dict[str, int]:
    """Coordinate a portfolio's swarm for one cycle (portfolio brief §4).

    BUY — snake draft: the buyers draft from the shared top-N screen
    candidates one name at a time (rotating/reversing order), each only
    drafting names that clear its own conviction gate, sized by its
    max-per-name against the shared cash. A drafted name is taken (no
    double-buying) and the opened position is attributed to the buyer.

    SELL — first valid sell: each reviewer runs its existing sell strategy
    sequentially against the shared book, so the first reviewer to close a
    name removes it before the next sees it (first-valid-sell by construction;
    each sell is tagged with the acting reviewer via agent_trades.agent_id).

    Conviction source per buyer: an `llm_watchlist_buyer` runs a real per-name
    LLM evaluation (its own mandate, hard conviction gate, rich thesis with
    extend/break signals — see `_llm_swarm_convictions`); `ma_sniper` uses its
    200-week proximity; any other buyer falls back to the deterministic
    screen-rank baseline (swarm.rank_to_conviction). The draft mechanics
    (order, gates, shared cash, attribution) are identical across all three.
    """
    import screen as _screen
    import swarm as _swarm

    counts = {"ok": 0, "dry-run": 0, "skipped": 0, "error": 0}
    pid = portfolio["id"]
    slug = portfolio.get("slug") or pid[:8]
    mandate = portfolio.get("description")
    members = [m["agent"] for m in member_rows]
    agent_by_id = {m["agent"]["id"]: m for m in member_rows}
    buyers_m = [m for m in member_rows if (m.get("role") == "buyer")]
    reviewers_m = [m for m in member_rows if (m.get("role") == "reviewer")]
    mode, executor = _resolve_live_executor(portfolio, dry_run=dry_run)

    # ---- BUY: snake draft over the screen's top-N candidates ----
    # Thinking buyers (llm_watchlist_buyer) evaluate each candidate with their
    # own mandate rather than the rank baseline, so when any are present we pull
    # the screen FACT ROWS (rank + Level 0 data) and cap the pool to the top
    # MAX_SWARM_EVAL names to bound LLM cost/latency.
    llm_buyers = [
        m for m in buyers_m
        if m["agent"].get("strategy") == "llm_watchlist_buyer"
    ]
    candidate_rows = _screen.portfolio_screen_candidate_rows(db, pid)
    if llm_buyers:
        candidate_rows = candidate_rows[:MAX_SWARM_EVAL]
    cand_map = {
        str(r["ticker"]).upper(): f"screen rank #{r['rank']} · {r.get('final_pct', 0)}th pct"
        for r in candidate_rows
    }  # {ticker: rationale}
    fact_rows = {str(r.get("ticker") or "").upper(): r for r in candidate_rows}
    book = pm.get_portfolio_book(pid)
    held = {str(h.get("ticker") or "").upper() for h in (book.get("holdings") or [])}
    recently_sold = {
        str(t).upper() for t in db.get_recently_sold_tickers(pid, days=90)
    }
    prices: dict[str, float] = {}
    for t in cand_map:
        if t in held or t in recently_sold:
            continue
        try:
            prices[t] = pm.get_price(t)
        except Exception:  # noqa: BLE001 — unpriced names just aren't draftable
            continue
    draftable = [t for t in cand_map if t in prices]

    # Per-name LLM evaluation inputs for thinking buyers (built once, shared
    # across co-briefed buyers). Active-thesis names are excluded so we never
    # re-think or clobber a position we already hold a thesis on.
    by_ticker_data: dict[str, dict] = {}
    eval_pool: list[str] = []
    if llm_buyers:
        import llm_watchlist_buyer as _llm_buyer

        active_thesis = _llm_buyer._active_thesis_tickers(db, pid)
        eval_pool = [t for t in draftable if t not in active_thesis]
        by_ticker_data = _llm_buyer.build_candidate_data(db, fact_rows, eval_pool)
        eval_pool = [t for t in eval_pool if t in by_ticker_data]

        # Per-name web search at buy time — enrich the shared candidate data ONCE
        # (every co-briefed buyer reads the same dict; the run cache dedupes across
        # portfolios). Auto-no-ops when SERPAPI_API_KEY is unset. Uses the buyer
        # default knobs since the enrichment is shared, not per-buyer.
        _news_defaults = _llm_buyer.LLM_WATCHLIST_BUYER_DEFAULTS
        if _news_defaults.get("news_search"):
            _key = _llm_buyer.serpapi_key()
            if _key:
                _llm_buyer.attach_recent_news(
                    by_ticker_data,
                    api_key=_key,
                    concurrency=int(_news_defaults["concurrency"]),
                    logger=logger,
                    max_queries=int(_news_defaults.get("news_queries", 1)),
                    max_chars=int(_news_defaults.get("news_max_chars", 1500)),
                )

    total_value = float(book.get("total_value_usd") or 0)
    cash = float(book.get("cash_usd") or 0)
    n = len(draftable)
    rank_conv = {t: _swarm.rank_to_conviction(i, n) for i, t in enumerate(draftable)}

    sw_buyers: list = []
    convictions: dict[str, dict[str, int]] = {}
    sniper_details: dict[str, dict] = {}
    buyer_evals: dict[str, dict[str, dict]] = {}  # agent_id -> ticker -> LLM eval
    eval_cache: dict[tuple, list[dict]] = {}      # dedupe identical eval sweeps
    for m in buyers_m:
        aid = m["agent"]["id"]
        cfg = m.get("config") or {}
        strat = m["agent"].get("strategy")
        gate = int(cfg.get("convictionGate", 1) or 1)
        if strat == "ma_sniper":
            # The 200-week sniper sources conviction from each candidate's
            # proximity to its long-run trend instead of the screen-rank
            # baseline: it expresses conviction ONLY for names at/below their
            # 200-week MA (within `band_pct`), and is silent — accumulating
            # cash — for everything else. Sizing honours the `target_position_pct`
            # slider on this path (translated to the draft's max-per-name).
            import ma_sniper as _ma_sniper

            band = float(cfg.get("band_pct", _ma_sniper.DEFAULT_BAND * 100.0)) / 100.0
            size_pct = cfg.get("target_position_pct")
            max_per = (
                float(size_pct) / 100.0
                if size_pct is not None
                else float(cfg.get("maxPerName", 0.05) or 0.05)
            )
            convictions[aid] = _ma_sniper.sniper_convictions(
                db, draftable, prices, band=band, details=sniper_details,
            )
        elif strat == "llm_watchlist_buyer":
            # The thinking buyer: real per-name LLM verdicts (its own mandate),
            # a hard conviction gate, and a rich thesis recorded at the buy site.
            convictions[aid], buyer_evals[aid], max_per, gate = _llm_swarm_convictions(
                db, m, cfg, mandate, pid, eval_pool, by_ticker_data, cand_map, book,
                eval_cache=eval_cache, dry_run=dry_run, logger=logger,
            )
        else:
            max_per = float(cfg.get("maxPerName", 0.08) or 0.08)
            convictions[aid] = dict(rank_conv)
        sw_buyers.append(
            _swarm.Buyer(aid, gate=gate, max_per_name=max_per)
        )
    if sniper_details:
        logger.info(
            "  portfolio %-22s sniper: %d name(s) at/below 200w MA (%s)",
            slug, len(sniper_details), ", ".join(sorted(sniper_details)),
        )

    plan = _swarm.snake_draft_plan(
        sw_buyers, draftable, prices, total_value, cash,
        min_order_value=total_value * MIN_DRAFT_POSITION_PCT,
        convictions=convictions,
    )
    logger.info(
        "  portfolio %-22s swarm: %d buyer(s), %d candidate(s), %d draft pick(s)%s",
        slug, len(sw_buyers), n, len(plan.picks), " [dry-run]" if dry_run else "",
    )

    buy_counts: dict[str, int] = {}
    for pick in plan.picks:
        m = agent_by_id.get(pick.agent_id)
        if not m:
            continue
        buy_counts[pick.agent_id] = buy_counts.get(pick.agent_id, 0)
        if dry_run:
            buy_counts[pick.agent_id] += 1
            continue
        ctx = RebalanceContext(
            db=db, pm=pm, agent=m["agent"], dry_run=False,
            params=dict(m.get("config") or {}), portfolio_id=pid,
            members=members, mandate=_resolve_member_mandate(m, mandate),
            mode=mode, executor=executor,
        )
        ev = buyer_evals.get(pick.agent_id, {}).get(pick.ticker)
        if ev:
            # Thinking buyer: record the LLM's narrative + extend/break signals
            # so the reviewer's thesis-break machinery actually has something to
            # check (the rank stub left it with nothing).
            note = (
                f"swarm draft (LLM {pick.conviction}/5): "
                f"{(ev.get('rationale') or '')[:80]}"
            ).strip()
            thesis = {
                "thesis_text": ev.get("thesis_text") or None,
                "extend_signals": ev.get("extend_signals") or None,
                "break_signals": ev.get("break_signals") or None,
            }
        else:
            rationale = cand_map.get(pick.ticker)
            snipe = sniper_details.get(pick.ticker)
            if snipe:
                # A sniper strike — record the discount to the 200-week average so
                # the thesis captures the fat pitch, not just the screen rank.
                disc = snipe["discount_pct"]
                where = f"{abs(disc):.1f}% below" if disc < 0 else f"{disc:.1f}% above"
                rationale = (
                    f"At 200-week average ({where} trend); {rationale or 'quality screen pick'}"
                )
            note = f"swarm draft (conviction {pick.conviction}/5): {rationale or ''}".strip()
            thesis = {"thesis_text": rationale} if rationale else None
        try:
            ctx.buy(pick.ticker, pick.qty, note=note, thesis=thesis)
            buy_counts[pick.agent_id] += 1
            # Attribution — stamp the opener (only if unset, to preserve the
            # original buyer across later top-ups).
            try:
                db.client.table("portfolio_holdings").update(
                    {"opened_by_agent_id": pick.agent_id}
                ).eq("portfolio_id", pid).eq("ticker", pick.ticker).is_(
                    "opened_by_agent_id", "null"
                ).execute()
            except Exception as exc:  # noqa: BLE001
                logger.warning("attribution stamp failed for %s: %s", pick.ticker, exc)
        except Exception as exc:  # noqa: BLE001 — one bad buy must not abort
            logger.warning("swarm buy %s x%s failed: %s", pick.ticker, pick.qty, exc)

    for m in buyers_m:
        aid = m["agent"]["id"]
        res = RebalanceResult()
        res.buys = buy_counts.get(aid, 0)
        res.notes["role"] = "buyer"
        res.notes["remit"] = m.get("remit")
        status = "dry-run" if dry_run else "ok"
        _journal(
            db, agent_id=aid, strategy=m["agent"].get("strategy") or "swarm_buyer",
            started_at=_now_utc(), status=status, result=res, portfolio_id=pid,
            advance_agent=False, dry_run=dry_run, triggered_by=triggered_by,
        )
        counts[status] = counts.get(status, 0) + 1

    # ---- SELL: each reviewer runs its strategy in order (first-valid-sell) ----
    for m in reviewers_m:
        agent = m["agent"]
        strategy_name = agent.get("strategy")
        strategy = get_strategy(strategy_name) if strategy_name else None
        started = _now_utc()
        if strategy is None:
            counts["skipped"] += 1
            continue
        ctx = RebalanceContext(
            db=db, pm=pm, agent=agent, dry_run=dry_run,
            params=dict(m.get("config") or {}), portfolio_id=pid,
            members=members, mandate=_resolve_member_mandate(m, mandate),
            mode=mode, executor=executor,
        )
        try:
            result = strategy(ctx)
        except Exception as exc:  # noqa: BLE001
            logger.exception("    reviewer %s crashed", agent.get("handle"))
            _journal(
                db, agent_id=agent["id"], strategy=strategy_name or "reviewer",
                started_at=started, status="error",
                error_message=f"{exc}\n{traceback.format_exc()}",
                portfolio_id=pid, advance_agent=False, dry_run=dry_run,
                triggered_by=triggered_by,
            )
            counts["error"] += 1
            continue
        status = "dry-run" if dry_run else ("ok" if not result.errors else "error")
        _journal(
            db, agent_id=agent["id"], strategy=strategy_name or "reviewer",
            started_at=started, status=status, result=result,
            error_message="; ".join(result.errors) if result.errors else None,
            portfolio_id=pid, advance_agent=False, dry_run=dry_run,
            triggered_by=triggered_by,
        )
        counts[status] = counts.get(status, 0) + 1

    if not dry_run:
        db.update_portfolio_last_heartbeat(pid, _now_utc().isoformat())
    return counts


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

    member_rows = db.get_portfolio_members(portfolio["id"])

    # Per-instance Run/Stop (migration 045): a stopped team agent stays on the
    # roster but trades nothing. Drop disabled members before any dispatch so
    # both the swarm and the legacy per-member loop honour the switch.
    member_rows = [m for m in member_rows if m.get("enabled", True)]

    # Swarm path (portfolio brief §4): snake-draft buys + first-valid-sell is
    # the STANDARD coordination for any portfolio with role-tagged buyers — no
    # opt-in. Skipped for a single-member "Run now" (handle_filter) so targeted
    # runs keep per-member behaviour, and for portfolios with no buyer-role
    # members (legacy 1:1 agents / other strategies) which fall through to the
    # independent per-member loop below.
    if (
        not handle_filter
        and any(m.get("role") == "buyer" for m in member_rows)
    ):
        return _run_portfolio_swarm(
            db, pm, portfolio, member_rows,
            dry_run=dry_run, logger=logger, triggered_by=triggered_by,
        )

    members = [m["agent"] for m in member_rows]
    mandate = portfolio.get("description")
    run_rows = member_rows
    if handle_filter:
        run_rows = [mr for mr in member_rows if mr["agent"].get("handle") == handle_filter]
    logger.info("  portfolio %-22s %d member(s)", slug, len(run_rows))

    for member_row in run_rows:
        member = member_row["agent"]
        handle = member.get("handle", member["id"][:8])
        strategy_name = member.get("strategy")
        started = _now_utc()

        if not strategy_name:
            logger.info("    %-22s skip (no strategy)", handle)
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
        # Per-instance params (portfolio_agents.config, migration 045) override
        # the agent-level config; the membership-less legacy 1:1 agents fall
        # back to their agents.config. Mandate is resolved per-agent (046).
        params = {**(member.get("config") or {}), **(member_row.get("config") or {})}
        ctx = RebalanceContext(
            db=db, pm=pm, agent=member, dry_run=dry_run,
            params=params,
            portfolio_id=portfolio["id"],
            members=members,
            mandate=_resolve_member_mandate(member_row, mandate),
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
        # A live portfolio is a private FOLLOWER (migration 037): it has no
        # agents of its own. It doesn't rebalance in the member loop — instead
        # it mirrors its paper sibling's composition onto Alpaca right after
        # that sibling rebalances (alpaca_mirror).
        live_by_owner = {
            p["owner_user_id"]: p
            for p in portfolios
            if (p.get("mode") or "paper") == "live"
        }
        paper_pfs = [
            p for p in portfolios if (p.get("mode") or "paper") != "live"
        ]
        logger.info(
            "=== human portfolios: %d (paper=%d, live-followers=%d) ===",
            len(portfolios), len(paper_pfs), len(live_by_owner),
        )
        for portfolio in paper_pfs:
            pcounts = _run_portfolio(
                db, pm, portfolio,
                force=args.force, dry_run=args.dry_run, logger=logger,
                triggered_by=triggered_by,
            )
            for key, val in pcounts.items():
                counts[key] = counts.get(key, 0) + val
            # Mirror the live follower (if the owner has one) onto Alpaca.
            live = live_by_owner.get(portfolio.get("owner_user_id"))
            if live:
                _mirror_live_sibling(
                    db, pm, paper=portfolio, live=live, dry_run=args.dry_run,
                )

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
