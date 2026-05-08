#!/usr/bin/env python3
"""
Build the daily universe snapshot — three tiers, one DB write per tier.

Reads `companies` + `price_sales`, assembles a JSON artefact at each of
three detail levels (`compact`, `extended`, `full`), and upserts one row
per tier into `universe_snapshots`. Idempotent — re-running on the same
date overwrites that day's rows.

Universe filter: full screened universe — every row in `companies` with
`in_tv_screen = true` regardless of bear/bull eval. Lets each agent
disagree with our pre-filter (per design doc).

Tier shape (in tokens, very approximately):
    compact  ~500 / ticker — core summary + narratives, no history arrays
    extended ~750 / ticker — compact + 5y annual + last 4 quarters + monthly P/S
    full    ~1300 / ticker — extended + all quarters + weekly P/S history

Schedule: 06:00 UTC daily (1h after score_ai_analysis at 05:00).
Drop-in fit with the existing nightly chain.

Usage::

    python build_universe_snapshot.py
    python build_universe_snapshot.py --dry-run        # build but don't write
    python build_universe_snapshot.py --tier compact   # build one tier only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
from datetime import datetime, timezone
from typing import Any

from dotenv import load_dotenv

from db import SupabaseDB

logger = logging.getLogger("build_universe_snapshot")

TIERS = ("compact", "extended", "full")

# Field sets per tier. Compact is the scan view — just enough signal for
# stage 1 of the LLM picker to make a 50-name shortlist. Extended adds
# the deeper fundamentals + history arrays for stage 2 due-diligence.
# Full adds the raw long-tail history.
#
# Empirical sizing on a 717-ticker universe (one row per tier):
#   compact   ≈ 200KB ( 50K tokens)  — fits DeepSeek 128K context
#   extended  ≈ 1.3MB (325K tokens)  — sliced to 50 tickers in stage 2 → 90KB
#   full      ≈ 1.8MB (450K tokens)  — for big-context single-pass mode

# Compact: just the decision-relevant scan fields. No history, no long
# narratives. Designed to fit in any model's context for stage 1.
COMPACT_FUNDAMENTAL_FIELDS = (
    "rating", "rule_of_40",
    "rev_growth_ttm_pct",
    "gross_margin_pct", "fcf_margin_pct",
)
COMPACT_VALUATION_FIELDS = ("price", "ps_now")
COMPACT_MOMENTUM_FIELDS = ("perf_52w_vs_spy", "composite_score")
COMPACT_NARRATIVE_FIELDS = ("short_outlook",)

# Extended: full fundamentals + history arrays + all narrative fields.
# Used for stage 2 (sliced to ~50 tickers) and as the default tier on
# the public /universe page.
EXTENDED_FUNDAMENTAL_FIELDS = (
    "rating", "r40_score", "rule_of_40",
    "rev_growth_ttm_pct", "rev_growth_qoq_pct", "rev_cagr_pct",
    "rev_consistency_score",
    "gross_margin_pct", "operating_margin_pct", "net_margin_pct",
    "net_margin_yoy_pct", "fcf_margin_pct",
    "opex_pct_revenue", "sm_rd_pct_revenue",
    "eps_only", "eps_yoy_pct", "qrtrs_to_profitability",
    "gm_trend",
)
EXTENDED_VALUATION_FIELDS = ("price", "ps_now", "price_pct_of_52w_high")
EXTENDED_MOMENTUM_FIELDS = ("perf_52w_vs_spy", "composite_score")
EXTENDED_NARRATIVE_FIELDS = (
    "short_outlook", "key_risks", "full_outlook", "bull_eval", "bear_eval",
)


def _safe(v: Any) -> Any:
    """Pass-through with em-dash sanitisation."""
    if v in ("—", "—", "", None):
        return None
    return v


def _eval_verdict(raw: Any) -> str | None:
    """Strip the rationale from a bull_eval / bear_eval value.

    Stored verdicts look like "✅ (rare disease pharma...)" or
    "❌ Net margin declined". Compact picker prompts only need the
    pass/fail tag — return "✅" or "❌" or None if no verdict yet.
    """
    if not raw:
        return None
    s = str(raw)
    if "✅" in s:
        return "✅"
    if "❌" in s:
        return "❌"
    return None


def _round(v: Any, places: int = 2) -> Any:
    if v is None:
        return None
    try:
        return round(float(v), places)
    except (TypeError, ValueError):
        return v


def _pick(d: dict, keys: tuple[str, ...]) -> dict:
    return {k: _safe(d.get(k)) for k in keys}


def _parse_history(raw: Any) -> list:
    """Normalise a stored JSON history blob (string or list) into a list.

    Returns the raw list — entries may be dicts (companies.* history) or
    pair-lists (price_sales.history_json, written by price_sales_updater
    as ``[date_str, ps_value]``). Caller is responsible for shape-aware
    handling.
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def _normalize_ps_history(raw: list) -> list[dict]:
    """Convert ``price_sales.history_json`` to a list of ``{date, ps}`` dicts.

    The stored shape is a list of ``[date_str, ps_value]`` pairs (see
    ``price_sales_updater.py``). Older rows or migrations may have stored
    list-of-dicts; this helper accepts both.
    """
    out: list[dict] = []
    for row in raw or []:
        if isinstance(row, dict):
            date_str = row.get("date") or row.get("week") or ""
            ps_val = row.get("ps") if "ps" in row else row.get("price_sales")
        elif isinstance(row, (list, tuple)) and len(row) >= 2:
            date_str = row[0]
            ps_val = row[1]
        else:
            continue
        if not isinstance(date_str, str) or len(date_str) < 7:
            continue
        out.append({"date": date_str, "ps": ps_val})
    return out


def _ps_history_monthly(history: list[dict]) -> list[dict]:
    """Downsample a normalised P/S series to one point per calendar month."""
    if not history:
        return []
    by_month: dict[str, dict] = {}
    for row in history:
        date_str = row.get("date") or ""
        if len(date_str) < 7:
            continue
        ym = date_str[:7]  # "YYYY-MM"
        # Keep the latest within each month.
        if ym not in by_month or date_str > by_month[ym].get("date", ""):
            by_month[ym] = row
    return [by_month[k] for k in sorted(by_month.keys())]


def _build_ticker_entry(
    company: dict,
    ps: dict | None,
    *,
    detail: str,
) -> dict:
    """Assemble one ticker's snapshot entry at the requested detail tier."""
    is_compact = detail == "compact"

    # Identification — present at every tier. Compact drops exchange,
    # country, status to save tokens (the picker can ask for them via
    # the detail tier if it wants).
    entry: dict[str, Any] = {
        "ticker": company.get("ticker"),
        "company_name": _safe(company.get("company_name")),
        "sector": _safe(company.get("sector")),
    }
    if not is_compact:
        entry["exchange"] = _safe(company.get("exchange"))
        entry["country"] = _safe(company.get("country"))
        entry["status"] = _safe(company.get("status"))

    # Fundamentals.
    if is_compact:
        fundamentals: dict[str, Any] = {
            "current": _pick(company, COMPACT_FUNDAMENTAL_FIELDS),
        }
    else:
        fundamentals = {"current": _pick(company, EXTENDED_FUNDAMENTAL_FIELDS)}
        annual = _parse_history(company.get("annual_revenue_5y"))
        quarterly = _parse_history(company.get("quarterly_revenue"))
        fundamentals["annual_revenue_5y"] = annual
        if detail == "extended":
            # Last 4 quarters covers TTM; older context lives in annual.
            fundamentals["quarterly_revenue"] = quarterly[-4:]
        else:
            fundamentals["quarterly_revenue"] = quarterly
    entry["fundamentals"] = fundamentals

    # Valuation block — pricing/PS summary fields plus optional P/S history.
    if is_compact:
        valuation: dict[str, Any] = _pick(company, COMPACT_VALUATION_FIELDS)
        if ps:
            # Just the 12-month median — anchor for "is this expensive?"
            # without the full distribution.
            valuation["ps_median_12m"] = _safe(ps.get("median_12m"))
    else:
        valuation = _pick(company, EXTENDED_VALUATION_FIELDS)
        if ps:
            valuation["ps_high_52w"] = _safe(ps.get("high_52w"))
            valuation["ps_low_52w"] = _safe(ps.get("low_52w"))
            valuation["ps_median_12m"] = _safe(ps.get("median_12m"))
            valuation["ps_ath"] = _safe(ps.get("ath"))
            valuation["ps_pct_of_ath"] = _safe(ps.get("pct_of_ath"))
            history = _normalize_ps_history(
                _parse_history(ps.get("history_json"))
            )
            if detail == "extended":
                valuation["ps_history"] = _ps_history_monthly(history)
            else:
                valuation["ps_history"] = history
    entry["valuation"] = valuation

    entry["momentum"] = _pick(
        company,
        COMPACT_MOMENTUM_FIELDS if is_compact else EXTENDED_MOMENTUM_FIELDS,
    )
    entry["narrative"] = _pick(
        company,
        COMPACT_NARRATIVE_FIELDS if is_compact else EXTENDED_NARRATIVE_FIELDS,
    )
    # Bull/bear verdicts as bare tags so picker agents can see who passed
    # our two AI auditors at a glance. Extended tier already has the full
    # rationale strings in the narrative block, so only add tags to compact.
    if is_compact:
        entry["verdicts"] = {
            "bull": _eval_verdict(company.get("bull_eval")),
            "bear": _eval_verdict(company.get("bear_eval")),
        }
    return entry


def build_snapshot(
    db: SupabaseDB,
    *,
    detail: str,
    snapshot_time_utc: str,
) -> dict:
    """Assemble the full snapshot dict for a single tier."""
    if detail not in TIERS:
        raise ValueError(f"unknown detail tier: {detail}")

    companies = db.get_all_companies()
    in_screen = [c for c in companies if c.get("in_tv_screen")]
    in_screen.sort(key=lambda c: (c.get("ticker") or ""))

    ps_map = db.get_all_price_sales()

    tickers: list[dict] = []
    for c in in_screen:
        if not c.get("ticker"):
            continue
        tickers.append(
            _build_ticker_entry(c, ps_map.get(c["ticker"]), detail=detail)
        )

    return {
        "snapshot_date": snapshot_time_utc[:10],
        "snapshot_time_utc": snapshot_time_utc,
        "detail": detail,
        "universe_filter": {
            "in_tv_screen": True,
            "us_listed_only": False,
            "rating_max": None,
            "dual_positive_required": False,
            "note": (
                "Full screened universe — every ticker that passes the "
                "TradingView nightly screen, regardless of bear/bull eval. "
                "Agents may disagree with our pre-filter."
            ),
        },
        "ticker_count": len(tickers),
        "tickers": tickers,
    }


def write_snapshot(
    db: SupabaseDB,
    snapshot: dict,
    *,
    detail: str,
    dry_run: bool,
) -> dict:
    """Upsert one snapshot row; return stats."""
    payload = json.dumps(snapshot, separators=(",", ":"), sort_keys=True)
    sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    size_kb = len(payload) // 1024

    row = {
        "snapshot_date": snapshot["snapshot_date"],
        "detail": detail,
        "json": snapshot,
        "sha256": sha,
        "ticker_count": snapshot["ticker_count"],
    }

    if dry_run:
        logger.info(
            "  [dry-run] %-8s tickers=%d size=%dKB sha=%s",
            detail, snapshot["ticker_count"], size_kb, sha[:12],
        )
    else:
        db.client.table("universe_snapshots").upsert(
            row, on_conflict="snapshot_date,detail",
        ).execute()
        logger.info(
            "  %-8s tickers=%d size=%dKB sha=%s",
            detail, snapshot["ticker_count"], size_kb, sha[:12],
        )

    return {"detail": detail, "size_kb": size_kb, "sha256": sha,
            "ticker_count": snapshot["ticker_count"]}


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Build snapshots but do not write to DB")
    parser.add_argument("--tier", choices=TIERS,
                        help="Build only this tier (default: all three)")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    db = SupabaseDB()
    snapshot_time_utc = datetime.now(timezone.utc).isoformat()

    tiers = (args.tier,) if args.tier else TIERS
    logger.info(
        "=== build_universe_snapshot: tiers=%s dry_run=%s ===",
        ",".join(tiers), args.dry_run,
    )

    start = time.time()
    written: list[dict] = []
    for tier in tiers:
        snapshot = build_snapshot(
            db, detail=tier, snapshot_time_utc=snapshot_time_utc,
        )
        written.append(
            write_snapshot(db, snapshot, detail=tier, dry_run=args.dry_run)
        )

    elapsed = round(time.time() - start, 1)
    logger.info("=== done: %d tiers in %.1fs ===", len(written), elapsed)

    db.log_run("build_universe_snapshot", {
        "updated": 0 if args.dry_run else len(written),
        "skipped": len(written) if args.dry_run else 0,
        "errors": 0,
        "duration_secs": elapsed,
        "details": {"tiers": written, "dry_run": args.dry_run},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
