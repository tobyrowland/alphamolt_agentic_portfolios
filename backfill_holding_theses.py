#!/usr/bin/env python3
"""backfill_holding_theses.py — give existing holdings machine-checkable break signals.

The Portfolio Review Agent (`portfolio_reviewer`) decides HOLD/SELL partly from
each position's recorded `break_signals` (`theses.check_thesis`). Positions that
were established by a path that didn't author a thesis — a bulk import, a manual
buy, a holdings write that bypassed `PortfolioManager.buy` — end up with either a
**snapshot-only** thesis (`source='auto'`, no signals) or **no thesis at all**.
For those, the reviewer has nothing to check against and falls back to the bare
mandate.

This operator script repairs that for a portfolio's CURRENT holdings, using the
shared research card (`ai_analysis.research_card.break_signals`) — the same
company-defined base set the LLM buyer inherits via
`llm_watchlist_buyer._merge_break_signals`:

  * A holding whose active thesis has NO break signals  → the signals are added
    in place (its original buy-time snapshot is preserved, so `change_pct`
    signals still measure drift from the real entry).
  * A holding with NO active thesis                     → a fresh thesis is
    recorded (snapshot of current state + the card's break signals), attributed
    to the position's opener.
  * A holding whose thesis already has break signals    → left untouched
    (idempotent — safe to re-run).
  * A holding whose research card has no break signals  → skipped (nothing to
    inherit yet; it'll be picked up once the card is scored).

This does NOT fabricate a buy narrative — only the machine-checkable signals are
inherited, which are derived from the card, not invented intent.

Usage:
    python backfill_holding_theses.py --portfolio sonofchucky --dry-run
    python backfill_holding_theses.py --portfolio sonofchucky
    python backfill_holding_theses.py --all            # every human portfolio
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone

import theses
from db import SupabaseDB

logger = logging.getLogger("backfill_holding_theses")

# Mirrors theses._STATIC_OPS + the change_pct operators check_thesis understands.
_ALLOWED_OPS = {">", ">=", "<", "<=", "==", "!=", "change_pct_lt", "change_pct_gt"}


def _clean_card_signals(raw) -> list[dict]:
    """Keep only well-formed break-signal dicts from a research card.

    The card's signals are already validated when written by
    `research_evaluation`, but `check_thesis` also defends against malformed
    entries — this is a light shape filter so we never store junk.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for s in raw:
        if not isinstance(s, dict):
            continue
        field = str(s.get("field") or "").strip()
        op = str(s.get("op") or "").strip()
        value = s.get("value")
        if not field or op not in _ALLOWED_OPS:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        out.append({
            "field": field,
            "op": op,
            "value": float(value),
            "description": str(s.get("description") or "").strip(),
        })
    return out


def _resolve_portfolio(db: SupabaseDB, slug: str) -> dict | None:
    resp = (
        db.client.table("portfolios").select("id, slug").eq("slug", slug).execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def backfill_portfolio(db: SupabaseDB, portfolio: dict, *, dry_run: bool) -> dict:
    pid = portfolio["id"]
    slug = portfolio.get("slug") or pid
    stats = {
        "repaired": 0, "created": 0,
        "skipped_has_signals": 0, "skipped_no_card": 0, "errors": 0,
    }

    holdings = (
        db.client.table("portfolio_holdings")
        .select("ticker, opened_by_agent_id")
        .eq("portfolio_id", pid)
        .execute()
        .data
    ) or []
    if not holdings:
        logger.info("[%s] no holdings — nothing to backfill", slug)
        return stats

    tickers = [str(h["ticker"]).upper() for h in holdings]
    ai_map = db.get_ai_analysis(tickers)

    thesis_rows = (
        db.client.table("investment_theses")
        .select("id, ticker, break_signals")
        .eq("portfolio_id", pid)
        .eq("status", "active")
        .execute()
        .data
    ) or []
    thesis_by_ticker: dict[str, dict] = {}
    for t in thesis_rows:
        # One active thesis per (portfolio, ticker) by construction; first wins.
        thesis_by_ticker.setdefault(str(t["ticker"]).upper(), t)

    # Fallback opener for thesis-less holdings with no recorded opener: the
    # portfolio's earliest-joined member agent.
    members = (
        db.client.table("portfolio_agents")
        .select("agent_id, joined_at")
        .eq("portfolio_id", pid)
        .order("joined_at")
        .execute()
        .data
    ) or []
    fallback_agent = members[0]["agent_id"] if members else None

    tag = " [dry-run]" if dry_run else ""
    for h in holdings:
        ticker = str(h["ticker"]).upper()
        card = (ai_map.get(ticker) or {}).get("research_card") or {}
        signals = _clean_card_signals(card.get("break_signals"))
        if not signals:
            stats["skipped_no_card"] += 1
            logger.info("  %-6s skip — research card has no break signals yet", ticker)
            continue

        existing = thesis_by_ticker.get(ticker)
        if existing:
            cur = existing.get("break_signals")
            if isinstance(cur, list) and len(cur) > 0:
                stats["skipped_has_signals"] += 1
                logger.info(
                    "  %-6s skip — thesis %s already has %d break signal(s)",
                    ticker, existing["id"], len(cur),
                )
                continue
            logger.info(
                "  %-6s REPAIR — add %d break signal(s) to thesis %s%s",
                ticker, len(signals), existing["id"], tag,
            )
            if not dry_run:
                try:
                    db.client.table("investment_theses").update(
                        {"break_signals": signals, "status_changed_at": "now()"}
                    ).eq("id", existing["id"]).execute()
                except Exception as exc:  # noqa: BLE001
                    logger.warning("  %-6s repair failed: %s", ticker, exc)
                    stats["errors"] += 1
                    continue
            stats["repaired"] += 1
        else:
            agent_id = h.get("opened_by_agent_id") or fallback_agent
            if not agent_id:
                logger.warning("  %-6s skip — no agent to attribute a thesis to", ticker)
                stats["errors"] += 1
                continue
            note = (
                f"[backfilled {datetime.now(timezone.utc).date().isoformat()}] "
                "Base break signals inherited from the research card; no thesis "
                "was recorded when this position was opened."
            )
            logger.info(
                "  %-6s CREATE — new thesis with %d break signal(s)%s",
                ticker, len(signals), tag,
            )
            if not dry_run:
                try:
                    theses.record_thesis(
                        db, agent_id=agent_id, ticker=ticker, portfolio_id=pid,
                        thesis_text=note, break_signals=signals,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("  %-6s create failed: %s", ticker, exc)
                    stats["errors"] += 1
                    continue
            stats["created"] += 1

    logger.info(
        "[%s] repaired=%d created=%d skipped_has_signals=%d skipped_no_card=%d errors=%d%s",
        slug, stats["repaired"], stats["created"], stats["skipped_has_signals"],
        stats["skipped_no_card"], stats["errors"], tag,
    )
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--portfolio", help="portfolio slug to backfill")
    g.add_argument("--all", action="store_true", help="every human-owned portfolio")
    ap.add_argument("--dry-run", action="store_true", help="plan only, write nothing")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    db = SupabaseDB()

    if args.all:
        portfolios = (
            db.client.table("portfolios")
            .select("id, slug")
            .not_.is_("owner_user_id", "null")
            .execute()
            .data
        ) or []
        if not portfolios:
            logger.info("no human-owned portfolios found")
            return
    else:
        p = _resolve_portfolio(db, args.portfolio)
        if not p:
            logger.error("no portfolio with slug %r", args.portfolio)
            sys.exit(1)
        portfolios = [p]

    totals = {
        "repaired": 0, "created": 0,
        "skipped_has_signals": 0, "skipped_no_card": 0, "errors": 0,
    }
    for p in portfolios:
        s = backfill_portfolio(db, p, dry_run=args.dry_run)
        for k in totals:
            totals[k] += s.get(k, 0)

    if len(portfolios) > 1:
        logger.info(
            "TOTAL repaired=%d created=%d skipped_has_signals=%d "
            "skipped_no_card=%d errors=%d%s",
            totals["repaired"], totals["created"], totals["skipped_has_signals"],
            totals["skipped_no_card"], totals["errors"],
            " [dry-run]" if args.dry_run else "",
        )


if __name__ == "__main__":
    main()
