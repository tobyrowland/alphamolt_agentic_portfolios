#!/usr/bin/env python3
"""
Price-Sales Weekly Updater.

Reads tickers from the companies table (Supabase), fetches market cap and revenue
data from EODHD, computes Price-to-Sales ratios, and maintains a rolling 52-week
P/S history in the price_sales table.

For backfill (new tickers), fetches 52 weeks of weekly closing prices and
combines with revenue TTM to build historical P/S.  For weekly updates, fetches
the current fundamentals snapshot for a single new data point.

Runs every Sunday at 02:00 UTC via GitHub Actions.
"""

import argparse
import json
import logging
import os
import statistics
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

from db import SupabaseDB
from eodhd_updater import fetch_fundamentals_with_fallbacks
from exchanges import resolve_eodhd_exchange, YAHOO_SUFFIX

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PS_SHEET = "Price-Sales"

EODHD_BASE_URL = "https://eodhd.com/api"
EODHD_API_KEY = os.environ.get("EODHD_API_KEY", "")

DELAY_BETWEEN_CALLS = 0.5  # seconds between EODHD API calls

# When ps_now diverges from the latest stored weekly-history point by more than
# this fraction, the underlying revenue denominator almost certainly stepped
# (e.g. a new quarter rolled into TTM at earnings). The append-only history is
# then anchored to a stale revenue base while ps_now uses the fresh one, which
# is exactly the "P/S out of sync" symptom: the headline / current marker drops
# but the chart line, 52w high/low, median and ATH stay on the old base. We
# rebuild the whole curve from weekly prices anchored to the CURRENT ps_now so
# every P/S figure shares one denominator again. 15% tolerates normal
# week-to-week price drift; an earnings revenue step is typically far larger.
PS_REBASE_THRESHOLD = 0.15

# Price-Sales sheet column order (kept for reference / legacy compatibility)
PS_COLUMNS = [
    "ticker", "company_name", "ps_now", "52w_high", "52w_low",
    "12m_median", "ath", "%_of_ath", "history_json", "last_updated",
    "first_recorded",
]

# Logs sheet column order (kept for reference)
LOG_COLUMNS = [
    "run_date", "backfilled", "updated", "skipped", "errors", "duration_secs",
]


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def setup_logging() -> logging.Logger:
    today_str = date.today().isoformat()
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"price_sales_{today_str}.txt"

    logger = logging.getLogger("price_sales_updater")
    logger.setLevel(logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    return logger


# ---------------------------------------------------------------------------
# EODHD API helpers
# ---------------------------------------------------------------------------


def _safe_float(val) -> float | None:
    """Convert a value to float, returning None on failure."""
    if val is None:
        return None
    try:
        f = float(val)
        return f if f == f else None  # NaN check
    except (ValueError, TypeError):
        return None


def eodhd_get(endpoint: str, params: dict | None = None,
              logger=None) -> dict | list | None:
    """Make a GET request to EODHD API."""
    url = f"{EODHD_BASE_URL}/{endpoint}"
    query = {"api_token": EODHD_API_KEY, "fmt": "json"}
    if params:
        query.update(params)

    try:
        resp = requests.get(url, params=query, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 0
        if logger:
            logger.warning("EODHD %s → HTTP %s", endpoint, status)
        return None
    except Exception as e:
        if logger:
            logger.warning("EODHD request failed for %s: %s", endpoint, e)
        return None


def fetch_fundamentals(ticker: str, exchange: str, logger,
                       company_name: str = "") -> dict | None:
    """Fetch EODHD fundamentals using the shared full fallback chain.

    Delegates to eodhd_updater.fetch_fundamentals_with_fallbacks which tries:
      1. Primary exchange
      2. Fallback exchanges (EXCHANGE_FALLBACKS)
      3. EODHD search API by ticker code
      4. OTC base ticker (strip F/Y suffix) + search
      5. Search by company name

    Returns the full JSON response or None.
    """
    return fetch_fundamentals_with_fallbacks(
        ticker, EODHD_API_KEY, logger,
        exchange=exchange, company=company_name,
    )


def _yahoo_chart_request(yahoo_ticker: str, logger) -> list | None:
    """Make a single Yahoo Finance chart request with retry on SSL/connection errors."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}"
    params = {"range": "1y", "interval": "1wk"}
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/120.0.0.0 Safari/537.36",
    }

    max_retries = 3
    for attempt in range(max_retries):
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            result = data.get("chart", {}).get("result", [])
            if not result:
                return None

            timestamps = result[0].get("timestamp", [])
            adj_closes = (
                result[0].get("indicators", {})
                .get("adjclose", [{}])[0]
                .get("adjclose", [])
            )
            if not timestamps or not adj_closes:
                return None

            prices = []
            for ts, close in zip(timestamps, adj_closes):
                if close is None:
                    continue
                dt = datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
                prices.append({"date": dt, "close": close})
            return prices if prices else None

        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            wait = 2 ** (attempt + 1)
            logger.warning("Yahoo %s attempt %d/%d failed (%s), retrying in %ds",
                           yahoo_ticker, attempt + 1, max_retries, type(e).__name__, wait)
            time.sleep(wait)
        except Exception as e:
            logger.warning("Yahoo Finance failed for %s: %s", yahoo_ticker, e)
            return None

    return None


def fetch_weekly_prices(ticker: str, exchange: str, logger) -> list | None:
    """Fetch ~52 weeks of weekly closing prices from Yahoo Finance.

    Returns list of {"date": "YYYY-MM-DD", "close": float} dicts, or None.
    """
    eodhd_exchange = resolve_eodhd_exchange(exchange)
    suffix = YAHOO_SUFFIX.get(eodhd_exchange, "")
    yahoo_ticker = ticker + suffix

    time.sleep(DELAY_BETWEEN_CALLS)  # rate limit
    prices = _yahoo_chart_request(yahoo_ticker, logger)
    if prices:
        logger.info("Yahoo Finance: got %d weekly prices for %s", len(prices), yahoo_ticker)
        return prices

    # Fallback: try bare ticker (for US-listed ADRs)
    if suffix:
        time.sleep(DELAY_BETWEEN_CALLS)
        prices = _yahoo_chart_request(ticker, logger)
        if prices:
            logger.info("Yahoo Finance: got %d weekly prices for %s (bare fallback)",
                        len(prices), ticker)
            return prices

    logger.warning("Yahoo Finance: no prices for %s (tried %s%s)",
                   ticker, yahoo_ticker, f" and {ticker}" if suffix else "")
    return None


def get_revenue_ttm(fundamentals: dict) -> float | None:
    """Extract trailing-twelve-month revenue from EODHD fundamentals."""
    # Try Highlights.RevenueTTM first
    highlights = fundamentals.get("Highlights", {})
    rev_ttm = _safe_float(highlights.get("RevenueTTM"))
    if rev_ttm and rev_ttm > 0:
        return rev_ttm

    # Fallback: sum last 4 quarterly income statements
    financials = fundamentals.get("Financials", {})
    quarterly = financials.get("Income_Statement", {}).get("quarterly", {})
    if not quarterly:
        return None

    # Sort by date descending
    sorted_q = sorted(quarterly.items(), key=lambda x: x[0], reverse=True)
    total = 0.0
    count = 0
    for _date, entry in sorted_q[:4]:
        rev = _safe_float(entry.get("totalRevenue"))
        if rev is not None:
            total += rev
            count += 1
    return total if count >= 2 else None  # need at least 2 quarters


def get_market_cap(fundamentals: dict) -> float | None:
    """Extract market capitalization from EODHD fundamentals."""
    highlights = fundamentals.get("Highlights", {})
    return _safe_float(highlights.get("MarketCapitalization"))


def get_shares_outstanding(fundamentals: dict) -> float | None:
    """Extract shares outstanding from EODHD fundamentals."""
    shares = fundamentals.get("SharesStats", {})
    val = _safe_float(shares.get("SharesOutstanding"))
    if val and val > 0:
        return val
    # Fallback: MarketCap / price
    highlights = fundamentals.get("Highlights", {})
    mcap = _safe_float(highlights.get("MarketCapitalization"))
    # Try technicals
    technicals = fundamentals.get("Technicals", {})
    price = _safe_float(technicals.get("50DayMA"))
    if mcap and price and price > 0:
        return mcap / price
    return None


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------


def get_last_friday() -> date:
    """Return the most recent Friday (looking back from today)."""
    today = date.today()
    days_since_friday = (today.weekday() - 4) % 7
    if days_since_friday == 0 and today.weekday() != 4:
        days_since_friday = 7
    if today.weekday() == 4:
        days_since_friday = 0
    return today - timedelta(days=days_since_friday)


def get_backfill_from() -> date:
    """Return the date ~52 weeks ago for backfill."""
    return date.today() - timedelta(weeks=52)


# ---------------------------------------------------------------------------
# Core P/S logic
# ---------------------------------------------------------------------------


def _parse_history(raw) -> list:
    """Parse a stored history_json blob into a list of [date, ps] rows."""
    try:
        if isinstance(raw, str):
            parsed = json.loads(raw)
        elif isinstance(raw, list):
            parsed = raw
        else:
            return []
    except (json.JSONDecodeError, TypeError):
        return []
    return parsed if isinstance(parsed, list) else []


def _build_weekly_history(
    ticker: str,
    exchange: str,
    ps_current: float,
    last_friday_str: str,
    logger,
) -> list:
    """Reconstruct ~52 weeks of P/S anchored to the CURRENT ps_current.

    Uses weekly price ratios: ps_week = ps_current * (week_close / latest_close).
    This is equivalent to (price * shares) / revenue without needing shares, and
    crucially anchors the whole curve to today's revenue denominator — so a
    rebuild after an earnings step re-syncs the history with ps_now instead of
    leaving it stranded on the old denominator.
    """
    history: list = []
    weekly_prices = fetch_weekly_prices(ticker, exchange, logger)

    if weekly_prices and len(weekly_prices) > 1:
        latest_close = _safe_float(
            weekly_prices[-1].get("adjusted_close")
            or weekly_prices[-1].get("close")
        )
        if latest_close and latest_close > 0:
            for day in weekly_prices[-52:]:
                close = _safe_float(day.get("adjusted_close") or day.get("close"))
                if not close or close <= 0:
                    continue
                ps_val = round(ps_current * (close / latest_close), 2)
                if ps_val > 0:
                    history.append([day["date"], ps_val])
            logger.info("%s: built %d weekly data points", ticker, len(history))
        else:
            logger.info("%s: latest close invalid, using current P/S only", ticker)
    else:
        logger.info("%s: no weekly prices returned (%s), using current P/S only",
                    ticker, "None" if weekly_prices is None else f"{len(weekly_prices)} pts")

    # Always ensure the curve ends on today's anchor point.
    if not history or history[-1][0] != last_friday_str:
        history.append([last_friday_str, ps_current])
    return history


def compute_ps_for_ticker(
    ticker: str,
    exchange: str,
    existing: dict | None,
    last_friday: date,
    backfill_from: date,
    logger,
    company_name: str = "",
) -> dict | None:
    """Fetch data from EODHD and compute P/S ratio + history for one ticker.

    Returns a dict ready for DB writing, or None if data is insufficient.
    History entries are only added on Fridays (weekly granularity),
    but ps_now and last_updated refresh daily.
    """
    today = date.today()
    today_str = today.isoformat()
    last_friday_str = last_friday.isoformat()
    is_friday_run = today.weekday() == 4  # Friday = 4
    mode = "backfill" if existing is None else "update"

    # --- Fetch fundamentals (market cap, revenue, shares) ---
    fundamentals = fetch_fundamentals(ticker, exchange, logger, company_name=company_name)
    if not fundamentals:
        logger.warning("SKIP %s: no fundamentals data", ticker)
        return None

    # Extract company name
    general = fundamentals.get("General", {})
    company_name = general.get("Name", "")

    revenue_ttm = get_revenue_ttm(fundamentals)
    if not revenue_ttm or revenue_ttm <= 0:
        logger.warning("SKIP %s: revenue_ttm=%s", ticker, revenue_ttm)
        return None

    market_cap = get_market_cap(fundamentals)

    # Current P/S from fundamentals
    if market_cap and market_cap > 0:
        ps_current = round(market_cap / revenue_ttm, 2)
    else:
        logger.warning("SKIP %s: no market cap data", ticker)
        return None

    # --- Build history ---
    # Decide between an append-only weekly update and a full rebuild of the
    # curve from prices. Rebuild when there's no prior row (initial backfill)
    # OR when ps_now has diverged from the stored history beyond the rebase
    # threshold — i.e. the revenue denominator stepped (earnings) and the
    # append-only history is now stranded on the old base (see
    # PS_REBASE_THRESHOLD).
    existing_history = _parse_history(existing.get("history_json")) if existing else []

    rebuild = mode == "backfill"
    rebased = False
    if mode == "update" and existing_history:
        last_row = existing_history[-1]
        last_ps = _safe_float(last_row[1]) if isinstance(last_row, list) and len(last_row) > 1 else None
        if last_ps and last_ps > 0:
            divergence = abs(ps_current - last_ps) / last_ps
            if divergence >= PS_REBASE_THRESHOLD:
                logger.info(
                    "%s: ps_now %.2f diverged %.0f%% from last history point %.2f — rebasing history",
                    ticker, ps_current, divergence * 100, last_ps,
                )
                rebuild = True
                rebased = True

    if rebuild:
        rebuilt = _build_weekly_history(ticker, exchange, ps_current, last_friday_str, logger)
        if rebased and len(rebuilt) < 2 and len(existing_history) >= 2:
            # Rebase wanted but weekly prices were unavailable this run — keep
            # the existing series rather than collapse the chart to one point.
            # ps_now still refreshes; the next run with prices will re-anchor.
            logger.warning("%s: rebase wanted but weekly prices unavailable; keeping existing history", ticker)
            new_history = existing_history
            rebased = False
        else:
            new_history = rebuilt
    else:
        # Append-only update: a new weekly point lands on Fridays only.
        if is_friday_run:
            existing_history.append([today_str, ps_current])
            # Keep rolling 52-entry window
            if len(existing_history) > 52:
                existing_history = existing_history[-52:]
        new_history = existing_history

    if not new_history:
        logger.warning("SKIP %s: empty history after processing", ticker)
        return None

    # --- Compute stats ---
    values = [h[1] for h in new_history]
    ps_52w_high = round(max(values), 2)
    ps_52w_low = round(min(values), 2)
    ps_12m_median = round(statistics.median(values), 2)

    # ATH: sticky within one revenue denominator — never goes down. But a
    # rebuilt curve (initial backfill OR a post-earnings rebase) is a fresh,
    # self-consistent snapshot on today's denominator, so the prior ATH (on the
    # old base) is no longer comparable; anchor ATH to the rebuilt curve.
    prev_ath = 0
    if existing and not rebuild:
        prev_ath = _safe_float(existing.get("ath")) or 0
    ps_ath = round(max(prev_ath, ps_current, ps_52w_high), 2)
    pct_of_ath = round(ps_current / ps_ath, 2) if ps_ath > 0 else 0

    first_recorded = (
        new_history[0][0]
        if mode == "backfill"
        else (existing.get("first_recorded") or new_history[0][0])
    )

    logger.info(
        "OK %s [%s]: ps=%.2f ath=%.2f 52wH=%.2f 52wL=%.2f med=%.2f (%d pts)",
        ticker, f"{mode}/rebased" if rebased else mode, ps_current, ps_ath,
        ps_52w_high, ps_52w_low, ps_12m_median, len(new_history),
    )

    return {
        "ticker": ticker,
        "company_name": company_name,
        "ps_now": ps_current,
        "high_52w": ps_52w_high,
        "low_52w": ps_52w_low,
        "median_12m": ps_12m_median,
        "ath": ps_ath,
        "pct_of_ath": pct_of_ath,
        "history_json": new_history,  # store as actual JSONB, not JSON string
        "last_updated": today_str,
        "first_recorded": first_recorded,
        "mode": mode,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    load_dotenv()
    logger = setup_logging()
    start_time = time.time()

    parser = argparse.ArgumentParser(description="Price-Sales weekly updater")
    parser.add_argument(
        "--tickers",
        nargs="*",
        help="Process only these tickers (for testing). E.g. --tickers DDOG CHOLAFIN CGD",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force update all tickers (ignore staleness check)",
    )
    args = parser.parse_args()

    logger.info("=" * 60)
    logger.info("Price-Sales updater starting (EODHD)")
    logger.info("=" * 60)

    if not EODHD_API_KEY:
        logger.error("EODHD_API_KEY env var is not set")
        sys.exit(1)

    db = SupabaseDB()

    # Read inputs from Level 0 (the legacy companies/price_sales are retired).
    # Universe = active Tier 1 securities; map `name` → company_name for the
    # downstream P/S computation that expects that key.
    sec_rows = db.get_all_securities(
        columns="ticker, exchange, name, is_tier1", status="active"
    )
    ticker_list = [
        {"ticker": s["ticker"], "exchange": s.get("exchange", ""),
         "company_name": s.get("name", "")}
        for s in sec_rows
        if s.get("is_tier1")
    ]
    logger.info("Read %d Tier 1 tickers from securities", len(ticker_list))

    # Prior P/S state per ticker from `valuation` (latest row), shaped to the
    # keys compute_ps_for_ticker expects (history_json / ath / last_updated).
    val_latest = db.get_all_valuation_latest()
    ps_map = {
        t: {
            "history_json": v.get("history_json"),
            "ath": v.get("ps_ath"),
            "last_updated": v.get("date"),
        }
        for t, v in val_latest.items()
    }
    logger.info("Read %d existing valuation rows", len(ps_map))

    # Filter to specific tickers if requested
    if args.tickers:
        filter_set = set(t.upper() for t in args.tickers)
        ticker_list = [t for t in ticker_list if t["ticker"].upper() in filter_set]
        logger.info("Filtered to %d tickers: %s", len(ticker_list), args.tickers)

    # Compute dates
    today = date.today()
    today_str = today.isoformat()
    last_friday = get_last_friday()
    backfill_from = get_backfill_from()
    logger.info("Today: %s | Last Friday: %s | Backfill from: %s",
                today, last_friday, backfill_from)

    # Classify and process tickers
    backfilled = 0
    updated = 0
    skipped = 0
    errors = 0

    for item in ticker_list:
        ticker = item["ticker"]
        exchange = item.get("exchange", "")
        company_name = item.get("company_name", "")
        existing = ps_map.get(ticker)

        # Classify — run daily; skip only if already updated today
        if existing is None:
            mode = "backfill"
        elif args.force:
            mode = "update"
        elif not existing.get("last_updated") or existing["last_updated"] < today_str:
            mode = "update"
        else:
            skipped += 1
            continue

        logger.info("Processing %s (%s) — mode=%s", ticker, exchange, mode)

        try:
            result = compute_ps_for_ticker(
                ticker, exchange,
                existing if mode == "update" else None,
                last_friday, backfill_from, logger,
                company_name=company_name,
            )
        except Exception as e:
            logger.error("ERROR processing %s: %s", ticker, e)
            errors += 1
            continue

        if result is None:
            # Uncomputable, not a failure: no fundamentals, no/zero revenue
            # (pre-revenue biotech), or no market cap. Count as skipped so the
            # activity log reads honestly — genuine fetch exceptions above are
            # the only thing that counts as an error.
            skipped += 1
            continue

        # Write to the Level 0 `valuation` table — this script is now the daily
        # P/S maintainer for valuation (the legacy `companies`/`price_sales`
        # tables are retired). Map the computed P/S series onto valuation cols.
        result_mode = result.pop("mode")
        val_row = {
            "ticker": ticker,
            "date": today_str,
            "ps": result.get("ps_now"),
            "ps_high_52w": result.get("high_52w"),
            "ps_low_52w": result.get("low_52w"),
            "ps_median_12m": result.get("median_12m"),
            "ps_ath": result.get("ath"),
            "ps_pct_of_ath": result.get("pct_of_ath"),
            "history_json": result.get("history_json"),
            "source": "price_sales_updater",
            "fetched_at": datetime.utcnow().isoformat(),
        }
        try:
            db.upsert_valuation_batch([val_row])
            if result_mode == "backfill":
                backfilled += 1
            else:
                updated += 1
        except Exception as e:
            logger.error("ERROR writing %s to DB: %s", ticker, e)
            errors += 1

    # Log run stats
    duration = round(time.time() - start_time, 1)
    stats = {
        "backfilled": backfilled,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "duration_secs": duration,
    }
    try:
        db.log_run("price_sales_updater", stats)
    except Exception as e:
        logger.error("Failed to log run stats: %s", e)

    logger.info("=" * 60)
    logger.info(
        "Done in %.1fs — backfilled=%d updated=%d skipped=%d errors=%d",
        duration, backfilled, updated, skipped, errors,
    )
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
