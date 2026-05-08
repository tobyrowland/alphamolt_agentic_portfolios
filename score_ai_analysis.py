#!/usr/bin/env python3
"""
Score & Rank AI Analysis (Supabase).

Reads companies, price-sales, and TradingView market data to compute
status and composite_score for every ticker. Assigns sort_order and
writes scoring results back to the companies table via Supabase.

Schedule: 06:30 UTC daily (after eodhd_updater and update_ai_narratives).
"""

import json
import logging
import math
import re
import sys
from datetime import date
from pathlib import Path

from dotenv import load_dotenv
from scipy.stats import percentileofscore

from db import SupabaseDB
from tv_screen import run_tradingview_screen, fetch_market_data

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

NULL_VALUE = "—"

# Status priority for sorting (lower = higher priority)
STATUS_PRIORITY = {
    "🏷️": 1, "🟢 Eligible": 1, "🟢": 1,
    "🆕 New": 2, "🆕": 2,
    "❌": 3,
}


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def setup_logging() -> logging.Logger:
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"score_ai_analysis_{date.today().isoformat()}.txt"

    logger = logging.getLogger("score_ai_analysis")
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    return logger


# ---------------------------------------------------------------------------
# Scoring logic
# ---------------------------------------------------------------------------


def parse_r40_score(r40_str):
    """Parse r40_score like '💎💎💎 R40: 90' → 90."""
    if not r40_str:
        return None
    match = re.search(r"R40:\s*(\d+)", str(r40_str))
    if match:
        return int(match.group(1))
    return None


def parse_rating_numeric(rating_str):
    """Parse rating like '1.8' → 1.8."""
    if not rating_str:
        return None
    match = re.match(r"([\d.]+)", str(rating_str))
    if match:
        return float(match.group(1))
    return None


def _status_base(status_str):
    """Extract the emoji prefix from a status string."""
    if not status_str:
        return ""
    for emoji in ("🏷️", "🟢", "🆕", "❌"):
        if status_str.startswith(emoji):
            return emoji
    return status_str


def compute_status(entry, ps_data, screened_tickers):
    """Determine status for a single ticker."""
    ticker = entry["ticker"]
    red_flags = entry.get("_red_flags", [])
    has_ai = bool(entry.get("ai_analyzed_at"))
    has_eodhd = bool(entry.get("data_updated_at"))

    # Rows that no longer appear in the live TV screen are excluded
    # outright — covers historical/foreign tickers that can't be
    # deleted because of FK references from agent_holdings/agent_trades.
    if ticker not in screened_tickers:
        return "❌ Not in current screen"

    if red_flags:
        flag_names = ", ".join(red_flags[:3])
        return f"❌ {flag_names}"

    sector = entry.get("sector", "")
    net_margin = entry.get("net_margin_pct")
    if isinstance(net_margin, (int, float)):
        if sector == "Health Technology" and net_margin < 0:
            return "❌ Unprofitable Health Tech"

    if has_ai and has_eodhd:
        ps_row = ps_data.get(ticker, {})
        ps_now = ps_row.get("ps_now")
        median = ps_row.get("12m_median") if isinstance(ps_row.get("12m_median"), (int, float)) else None
        if ps_now is not None and median is not None and median > 0 and ps_now / median < 0.80:
            pct = round((1 - ps_now / median) * 100)
            return f"🏷️ -{pct}% vs. 52w p/s"
        return "🟢 Eligible"

    return "🆕 New"


def _rating_multiplier(rating):
    """Return a multiplier based on TradingView analyst rating.

    1.0–1.2   → 1.0  (no penalty — best in class)
    1.21–1.6  → linear taper from 1.0 → 0.01  (proceed with caution)
    >1.6      → 0.01  (disqualify)
    None      → 1.0  (no data, no penalty)
    """
    if rating is None:
        return 1.0
    if rating <= 1.2:
        return 1.0
    if rating <= 1.6:
        return 1.0 - (rating - 1.2) / (1.6 - 1.2) * 0.99
    return 0.01


def _collar_perf(perf):
    """Apply strict momentum collar to perf_52w_vs_spy.

    < -0.5  → None  (disqualified — falling knife)
    > 0.4   → 0.4   (capped — avoid hype blow-off tops)
    else    → perf   (pass through for linear scaling)
    """
    if perf is None:
        return perf
    if perf < -0.5:
        return None  # sentinel: hard disqualify
    return min(perf, 0.4)


def compute_composite_score(row_data, all_rows):
    """Calculate composite score using percentile-based weighting.

    Base score (0–100) from three factors, then multiplied by a rating gate.
    Performance is collared: < -0.5 disqualifies, > 0.4 capped.
    Percentile ranking uses the collared values so scaling is linear
    within the -0.5 to 0.4 band.
    """
    def pct(values, v, invert=False):
        if v is None or not values:
            return 0.5
        p = percentileofscore(values, v, kind="mean") / 100
        return (1 - p) if invert else p

    # Hard disqualify: perf < -0.5
    collared_perf = _collar_perf(row_data.get("_perf_f"))
    if row_data.get("_perf_f") is not None and collared_perf is None:
        return 0

    all_ps = [r["_ps_now_f"] for r in all_rows if r.get("_ps_now_f") is not None]
    all_r40 = [r["_r40_f"] for r in all_rows if r.get("_r40_f") is not None]
    # Collar all perf values so percentile ranking scales within the band
    all_perf = [_collar_perf(r["_perf_f"]) for r in all_rows
                if r.get("_perf_f") is not None and _collar_perf(r["_perf_f"]) is not None]

    base = (
        pct(all_r40, row_data.get("_r40_f")) * 47
        + pct(all_ps, row_data.get("_ps_now_f"), invert=True) * 29
        + pct(all_perf, collared_perf) * 24
    )

    return base * _rating_multiplier(row_data.get("_rating_f"))


# ---------------------------------------------------------------------------
# Sort helpers
# ---------------------------------------------------------------------------


def sort_key(entry):
    """Sort by status priority, then composite score descending."""
    status = str(entry.get("status", "")).strip()
    priority = STATUS_PRIORITY.get(status, 99)
    if priority == 99:
        emoji = _status_base(status)
        for k, v in STATUS_PRIORITY.items():
            if k.startswith(emoji) and emoji:
                priority = v
                break
    return (priority, -entry.get("_composite_score", 0))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    logger = setup_logging()
    logger.info("=" * 60)
    logger.info("Score AI Analysis — %s", date.today().isoformat())
    logger.info("=" * 60)

    db = SupabaseDB()

    # Step 1: Load all data sources
    logger.info("Step 1: Loading data sources...")

    companies = db.get_all_companies()
    if not companies:
        logger.warning("No companies data — nothing to score")
        return

    logger.info("Loaded %d companies from database", len(companies))

    ps_data = db.get_all_price_sales()
    logger.info("Loaded Price-Sales data for %d tickers", len(ps_data))

    # Step 2: Run TradingView screen for market data
    logger.info("Step 2: TradingView screen for market data...")
    screened = run_tradingview_screen(logger)
    screened_map = {eq["ticker"].upper(): eq for eq in screened}
    screened_tickers = set(screened_map.keys())
    logger.info("TradingView returned %d equities", len(screened))

    # Step 2b: Fetch market data for tickers NOT in the screen
    missing_tickers = [
        (c["ticker"], c.get("exchange", ""))
        for c in companies
        if c["ticker"] not in screened_tickers
    ]
    if missing_tickers:
        logger.info("Fetching market data for %d tickers not in TradingView screen...",
                    len(missing_tickers))
        extra_data = fetch_market_data(missing_tickers, logger)
    else:
        extra_data = {}

    # Step 3: Compute status and scoring inputs for each ticker
    logger.info("Step 3: Computing status and scores...")

    entries = []
    for company in companies:
        ticker = company["ticker"]

        # Extract flags from JSONB (defensive: handle both dict and legacy JSON string)
        flags = company.get("flags") or {}
        if isinstance(flags, str):
            try:
                flags = json.loads(flags) if flags else {}
            except (json.JSONDecodeError, ValueError):
                flags = {}
        red_flags = [col for col, level in flags.items() if level == "red"]
        yellow_flags = [col for col, level in flags.items() if level == "yellow"]

        entry = dict(company)
        entry["_red_flags"] = red_flags
        entry["_yellow_flags"] = yellow_flags

        # Merge market data — prefer screened data, fall back to direct lookup
        tv = screened_map.get(ticker) or extra_data.get(ticker, {})

        tv_price = tv.get("price")
        entry["price"] = tv_price if tv_price is not None else entry.get("price")

        tv_perf = tv.get("perf_52w_vs_spy")
        entry["perf_52w_vs_spy"] = tv_perf if tv_perf is not None else entry.get("perf_52w_vs_spy")

        tv_rating = tv.get("rating")
        entry["rating"] = tv_rating if tv_rating is not None else (entry.get("rating") or "")

        # Merge P/S data
        ps = ps_data.get(ticker, {})
        ps_now = ps.get("ps_now")
        if isinstance(ps_now, (int, float)):
            entry["ps_now"] = ps_now
        else:
            entry["ps_now"] = None

        high_52w = ps.get("52w_high") if isinstance(ps.get("52w_high"), (int, float)) else None
        if entry["ps_now"] is not None and high_52w is not None and high_52w > 0:
            entry["price_pct_of_52w_high"] = entry["ps_now"] / high_52w
        else:
            entry["price_pct_of_52w_high"] = None

        # Status
        entry["status"] = compute_status(entry, ps_data, screened_tickers)

        # Scoring inputs
        entry["_ps_now_f"] = entry["ps_now"]

        perf_raw = entry.get("perf_52w_vs_spy")
        if isinstance(perf_raw, (int, float)):
            entry["_perf_f"] = perf_raw
        else:
            entry["_perf_f"] = db.safe_float(perf_raw)

        entry["_r40_f"] = parse_r40_score(entry.get("r40_score", ""))

        rating_raw = entry.get("rating")
        if isinstance(rating_raw, (int, float)):
            entry["_rating_f"] = rating_raw
        else:
            entry["_rating_f"] = parse_rating_numeric(rating_raw)

        entries.append(entry)

    # Step 4: Compute composite scores with penalties
    collar_disqualified = []
    for entry in entries:
        raw = compute_composite_score(entry, entries)

        if raw == 0 and entry.get("_perf_f") is not None:
            collar_disqualified.append(
                (entry["ticker"], entry.get("_perf_f"))
            )

        # Penalty from short_outlook emoji
        outlook = str(entry.get("short_outlook") or "").strip()
        if outlook.startswith("🔴"):
            raw *= 0.25
        elif outlook.startswith("🟡"):
            raw *= 0.50

        # Penalty from yellow flags
        if entry.get("_yellow_flags"):
            raw *= 0.50

        entry["_composite_score"] = raw
        entry["composite_score"] = raw

    if collar_disqualified:
        logger.info("Momentum collar disqualified %d tickers:", len(collar_disqualified))
        for ticker, perf in collar_disqualified:
            logger.info("  %s  perf_52w_vs_spy=%.4f", ticker, perf)
    else:
        logger.info("Momentum collar: no tickers disqualified")

    # Step 5: Sort and assign sort_order
    entries.sort(key=sort_key)

    for i, entry in enumerate(entries):
        entry["sort_order"] = i + 1

    # Log top 10
    logger.info("Top 10 by composite score:")
    for i, entry in enumerate(entries[:10]):
        logger.info("  %2d. %-8s %s  score=%.1f",
                    i + 1, entry["ticker"], entry["status"], entry["_composite_score"])

    # Step 6: Write scoring results back to database
    logger.info("Step 6: Writing scoring results to database...")

    today = date.today().isoformat()
    upsert_rows = []
    for entry in entries:
        row = {
            "ticker": entry["ticker"],
            "status": entry["status"],
            "composite_score": round(entry["_composite_score"], 1),
            "sort_order": entry["sort_order"],
            "scored_at": today,
        }

        # Price
        price = entry.get("price")
        if isinstance(price, (int, float)) and not (math.isnan(price) or math.isinf(price)):
            row["price"] = round(price, 2)

        # P/S now
        ps_now = entry.get("ps_now")
        if isinstance(ps_now, (int, float)) and not (math.isnan(ps_now) or math.isinf(ps_now)):
            row["ps_now"] = round(ps_now, 2)

        # Price % of 52w high
        pct_high = entry.get("price_pct_of_52w_high")
        if isinstance(pct_high, (int, float)) and not (math.isnan(pct_high) or math.isinf(pct_high)):
            row["price_pct_of_52w_high"] = round(pct_high, 4)

        # Perf 52w vs SPY
        perf = entry.get("perf_52w_vs_spy")
        if isinstance(perf, (int, float)) and not (math.isnan(perf) or math.isinf(perf)):
            row["perf_52w_vs_spy"] = round(perf, 4)

        # Rating
        rating = entry.get("rating")
        if isinstance(rating, (int, float)) and not (math.isnan(rating) or math.isinf(rating)):
            row["rating"] = rating
        elif isinstance(rating, str) and rating.strip():
            row["rating"] = rating.strip()

        upsert_rows.append(row)

    db.upsert_companies_batch(upsert_rows)
    logger.info("Wrote scoring results for %d tickers", len(upsert_rows))

    # Summary
    status_counts = {}
    for entry in entries:
        base = _status_base(entry["status"])
        status_counts[base] = status_counts.get(base, 0) + 1
    logger.info("Status summary: %s", status_counts)
    logger.info("Score AI Analysis complete — %d tickers scored and sorted", len(entries))


if __name__ == "__main__":
    main()
