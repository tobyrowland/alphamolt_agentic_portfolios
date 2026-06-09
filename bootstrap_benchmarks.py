#!/usr/bin/env python3
"""
One-off seed for benchmark portfolios (S&P 500, MSCI World).

For each (ticker, display_name) below:
  1. Picks an anchor date: MIN(inception_date) across agent_accounts,
     falling back to today if no accounts exist yet.
  2. Hits Yahoo Finance's chart API for daily adjusted closes between
     min(anchor, today − 53 weeks) and today, and inserts every
     (price_date, adjusted_close) into benchmark_prices. The series is
     pulled ≥ 53 weeks deep regardless of arena age so the vs-SPY 52-week
     anchor (read by the screener at today − 52w) always exists.
  3. Upserts the benchmarks row, with inception_date/price anchored at the
     arena anchor (first close on/after it — NOT the deep-fetch start, so
     the leaderboard benchmark still starts alongside the agents) and
     latest_price/latest_price_date from the newest close.

Yahoo is used instead of EODHD because the project's EODHD plan doesn't
cover /api/eod/ for ETFs (403 Forbidden). The shape of the data is
identical; only the source changes.

Idempotent — re-running refreshes prices and re-anchors inception only
if necessary. Usage:

    python bootstrap_benchmarks.py                          # seed both
    python bootstrap_benchmarks.py --ticker SPY.US          # one only
    python bootstrap_benchmarks.py --dry-run                # compute only

Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests
from dotenv import load_dotenv

from db import SupabaseDB

# (storage_ticker, display_name). storage_ticker is the row key in
# the `benchmarks` table; yahoo_ticker_for() maps it to Yahoo's symbol.
DEFAULT_BENCHMARKS = [
    ("SPY.US", "S&P 500 (SPY)"),
    ("URTH.US", "MSCI World (URTH)"),
]


def yahoo_ticker_for(storage_ticker: str) -> str:
    """Translate our storage ticker (EODHD-style) to Yahoo's symbol.

    `.US` is dropped (Yahoo uses bare tickers for US listings). Other
    suffixes can be mapped here if we ever add non-US benchmarks.
    """
    if storage_ticker.endswith(".US"):
        return storage_ticker[:-3]
    return storage_ticker


def yahoo_daily(
    storage_ticker: str,
    from_date: date,
    to_date: date,
    logger: logging.Logger,
) -> list[dict[str, Any]] | None:
    """Fetch daily adjusted closes from Yahoo Finance between two dates.

    Returns a list of {"date": "YYYY-MM-DD", "adjusted_close": float}
    ordered ascending by date, or None on failure.
    """
    yticker = yahoo_ticker_for(storage_ticker)
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yticker}"
    # Pad period2 by one day so today's bar isn't excluded on boundary.
    period1 = int(datetime.combine(from_date, datetime.min.time(),
                                   tzinfo=timezone.utc).timestamp())
    period2 = int(datetime.combine(to_date + timedelta(days=1), datetime.min.time(),
                                   tzinfo=timezone.utc).timestamp())
    params = {"interval": "1d", "period1": period1, "period2": period2}
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/120.0.0.0 Safari/537.36",
    }

    for attempt in range(3):
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            result = data.get("chart", {}).get("result") or []
            if not result:
                logger.warning("Yahoo %s: empty result", yticker)
                return None
            ts = result[0].get("timestamp") or []
            adj = (
                result[0].get("indicators", {})
                .get("adjclose", [{}])[0]
                .get("adjclose", [])
            )
            if not ts or not adj:
                logger.warning("Yahoo %s: no timestamp / adjclose", yticker)
                return None

            rows = []
            for t, c in zip(ts, adj):
                if c is None:
                    continue
                d = datetime.fromtimestamp(t, tz=timezone.utc).date()
                rows.append({"date": d.isoformat(), "adjusted_close": float(c)})
            return rows if rows else None
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            wait = 2 ** (attempt + 1)
            logger.warning("Yahoo %s attempt %d/3 failed (%s), retrying in %ds",
                           yticker, attempt + 1, type(e).__name__, wait)
            time.sleep(wait)
        except Exception as e:
            logger.error("Yahoo fetch failed for %s: %s", yticker, e)
            return None
    return None


def get_anchor_date(db: SupabaseDB, logger: logging.Logger) -> date:
    """Earliest agent inception date, or today if no accounts exist yet."""
    resp = (
        db.client.table("agent_accounts")
        .select("inception_date")
        .order("inception_date", desc=False)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if rows and rows[0].get("inception_date"):
        anchor = date.fromisoformat(rows[0]["inception_date"])
        logger.info("Anchor date = %s (earliest agent inception)", anchor)
        return anchor
    logger.info("No agent accounts yet — anchoring to today")
    return date.today()


def seed_benchmark(
    db: SupabaseDB,
    ticker: str,
    display_name: str,
    anchor: date,
    dry_run: bool,
    logger: logging.Logger,
) -> bool:
    """Fetch prices and seed benchmarks + benchmark_prices. Returns True on success."""
    today = date.today()
    # Fetch the price series deep enough that the vs-SPY 52-week anchor always
    # exists — screen.py / query.ts read benchmark_prices at (today − 52w) to
    # compute each name's return vs SPY, so an 8-week-old series leaves vs-SPY
    # NULL universe-wide. We pull ≥ 53 weeks regardless of arena age. Inception,
    # though, stays anchored to the arena (MIN agent inception) so the
    # leaderboard benchmark still "runs alongside" the agents rather than
    # showing a full year of head start.
    fetch_start = min(anchor, today - timedelta(weeks=53))
    logger.info(
        "Seeding %s (%s): prices %s → %s, inception anchored at %s",
        ticker, display_name, fetch_start, today, anchor,
    )

    series = yahoo_daily(ticker, fetch_start, today, logger)
    if not series:
        logger.error("%s: no price data returned; skipping", ticker)
        return False

    series.sort(key=lambda r: r.get("date", ""))

    valid = [
        r for r in series
        if r.get("date") and r.get("adjusted_close") is not None
    ]
    if not valid:
        logger.error("%s: no valid close prices in response", ticker)
        return False

    last = valid[-1]
    # Inception baseline = first close on/after the arena anchor (NOT the
    # deep-fetch start), so the benchmark portfolio's starting value matches the
    # agents'. Falls back to the earliest available close if nothing is ≥ anchor.
    inception_row = next(
        (r for r in valid if date.fromisoformat(r["date"]) >= anchor),
        valid[0],
    )

    inception_date = date.fromisoformat(inception_row["date"])
    inception_price = float(inception_row["adjusted_close"])
    latest_date = date.fromisoformat(last["date"])
    latest_price = float(last["adjusted_close"])

    logger.info(
        "  inception=%s @ %.4f   last=%s @ %.4f   (%d rows from %s)",
        inception_date, inception_price, latest_date, latest_price,
        len(valid), valid[0]["date"],
    )

    if dry_run:
        logger.info("  dry-run — skipping writes")
        return True

    db.client.table("benchmarks").upsert(
        {
            "ticker": ticker,
            "display_name": display_name,
            "inception_date": inception_date.isoformat(),
            "inception_price": inception_price,
            "latest_price": latest_price,
            "latest_price_date": latest_date.isoformat(),
        },
        on_conflict="ticker",
    ).execute()

    rows = [
        {
            "ticker": ticker,
            "price_date": r["date"],
            "close": float(r["adjusted_close"]),
        }
        for r in series
        if r.get("date") and r.get("adjusted_close") is not None
    ]
    BATCH = 500
    for i in range(0, len(rows), BATCH):
        chunk = rows[i : i + BATCH]
        db.client.table("benchmark_prices").upsert(
            chunk, on_conflict="ticker,price_date"
        ).execute()
    logger.info("  wrote %d price rows", len(rows))
    return True


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ticker", type=str, default=None,
                        help="Seed only this ticker (e.g. SPY.US)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch + compute but don't write")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logger = logging.getLogger("bootstrap_benchmarks")

    db = SupabaseDB()
    anchor = get_anchor_date(db, logger)

    targets = DEFAULT_BENCHMARKS
    if args.ticker:
        targets = [(t, n) for (t, n) in DEFAULT_BENCHMARKS if t == args.ticker]
        if not targets:
            logger.error("Unknown ticker: %s (must be one of %s)",
                         args.ticker, [t for t, _ in DEFAULT_BENCHMARKS])
            return 1

    ok = 0
    for ticker, name in targets:
        if seed_benchmark(db, ticker, name, anchor, args.dry_run, logger):
            ok += 1

    logger.info("Done. %d/%d benchmarks seeded.", ok, len(targets))
    return 0 if ok == len(targets) else 1


if __name__ == "__main__":
    sys.exit(main())
