#!/usr/bin/env python3
"""
Intraday 15-min delayed price refresher.

Hits EODHD's /real-time bulk endpoint and writes (price, price_asof) back
to `companies` for every ticker in the active TV screen. Scheduled every
15 min during US market hours via .github/workflows/intraday-prices.yml.

Only touches the price-related columns — fundamentals, R40, AI narrative,
flags, sort_order etc. all keep their daily/weekly refresh cadence. The
05:30 UTC portfolio_valuation.py snapshot still picks up close-of-business
because the last intraday tick of the day runs around 21:45 UTC and
markets have been closed since ~22:00 UTC by the time MTM runs.

Usage:
    python intraday_prices.py
    python intraday_prices.py --dry-run
    python intraday_prices.py --tickers NVDA AAPL META

Env:
    EODHD_API_KEY
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

from db import SupabaseDB
from exchanges import resolve_eodhd_exchange

load_dotenv()

EODHD_REALTIME_BASE = "https://eodhd.com/api/real-time"
# EODHD's `s=` bulk param is documented as supporting "multiple tickers" without
# a hard cap. 50 is conservative — keeps individual responses small and means
# ~20 calls cover a ~1000-ticker universe in one tick.
BATCH_SIZE = 50
DELAY_BETWEEN_BATCHES = 0.3  # seconds; conservative — well under the per-minute limit
TIMEOUT = 20


def setup_logging() -> logging.Logger:
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    log_file = log_dir / f"intraday_prices_{stamp}.txt"

    logger = logging.getLogger("intraday_prices")
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


def fetch_batch_prices(
    symbols: list[str], api_key: str, logger: logging.Logger
) -> dict[str, dict]:
    """Fetch up to BATCH_SIZE symbols from EODHD's /real-time endpoint.

    Symbols are full EODHD codes ("AAPL.US", "ARGX.NASDAQ"). The first
    symbol goes in the URL path; the rest piggy-back via `?s=`. The
    endpoint returns a dict for single-ticker calls and a list for bulk —
    we normalise to a {SYMBOL_UPPER: row_dict} map.
    """
    if not symbols:
        return {}
    head, *rest = symbols
    url = f"{EODHD_REALTIME_BASE}/{head}"
    params: dict[str, str] = {"api_token": api_key, "fmt": "json"}
    if rest:
        params["s"] = ",".join(rest)

    try:
        resp = requests.get(url, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning(
            "EODHD batch fetch failed (%d symbols, starting %s): %s",
            len(symbols),
            head,
            exc,
        )
        return {}

    rows = data if isinstance(data, list) else [data]
    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = row.get("code")
        if not isinstance(code, str) or not code:
            continue
        out[code.upper()] = row
    return out


def extract_price(row: dict) -> tuple[float, datetime] | None:
    """Pull (price, asof_utc) out of an EODHD /real-time row, or None.

    EODHD returns the string "NA" for tickers it can't price (delisted,
    suspended, brand-new IPOs that aren't covered, etc.). We treat any
    non-positive value as missing and let the caller skip.
    """
    close = row.get("close")
    if close in (None, "NA", "-"):
        return None
    try:
        price = float(close)
    except (TypeError, ValueError):
        return None
    if not (price > 0):
        return None

    ts = row.get("timestamp")
    if isinstance(ts, (int, float)) and ts > 0:
        asof = datetime.fromtimestamp(int(ts), tz=timezone.utc)
    else:
        # No timestamp from EODHD (rare) — stamp with our fetch time so
        # the UI still has something fresh to display.
        asof = datetime.now(timezone.utc)
    return price, asof


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Intraday 15-min delayed price refresher (EODHD /real-time)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch + log, but skip the DB write",
    )
    parser.add_argument(
        "--tickers",
        nargs="+",
        help="restrict to these tickers (still must be in_tv_screen)",
    )
    args = parser.parse_args()

    logger = setup_logging()
    logger.info("=" * 60)
    logger.info(
        "Intraday prices — %s UTC",
        datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    logger.info("=" * 60)

    api_key = os.environ.get("EODHD_API_KEY")
    if not api_key:
        logger.error("EODHD_API_KEY env var is not set")
        return 1

    db = SupabaseDB()
    # Universe = active Tier 1 securities (Level 0). The legacy companies table
    # (and its in_tv_screen flag) is retired.
    securities = db.get_all_securities(
        columns="ticker, exchange, is_tier1", status="active"
    )
    eligible = [s for s in securities if s.get("is_tier1")]
    if args.tickers:
        wanted = {t.upper() for t in args.tickers}
        eligible = [s for s in eligible if s["ticker"].upper() in wanted]
    if not eligible:
        logger.warning("No eligible Tier 1 tickers after filtering")
        return 0

    logger.info(
        "Fetching prices for %d eligible tickers (batch=%d)",
        len(eligible),
        BATCH_SIZE,
    )

    # Build (alphamolt_ticker, eodhd_symbol) pairs so we can look up
    # responses by EODHD code and route them back to the right row.
    pairs: list[tuple[str, str]] = []
    for c in eligible:
        eodhd_ex = resolve_eodhd_exchange(c.get("exchange", "")) or "US"
        pairs.append((c["ticker"], f"{c['ticker']}.{eodhd_ex}"))

    updates: list[dict] = []
    skipped: list[str] = []
    fail_batches = 0

    for i in range(0, len(pairs), BATCH_SIZE):
        batch = pairs[i : i + BATCH_SIZE]
        symbols = [sym for _, sym in batch]
        rows = fetch_batch_prices(symbols, api_key, logger)
        if not rows:
            fail_batches += 1
            for ticker, _ in batch:
                skipped.append(ticker)
        else:
            for ticker, sym in batch:
                row = rows.get(sym.upper())
                if not row:
                    skipped.append(ticker)
                    continue
                res = extract_price(row)
                if not res:
                    skipped.append(ticker)
                    continue
                price, asof = res
                updates.append(
                    {
                        "ticker": ticker,
                        "price": round(price, 4),
                        "price_asof": asof.isoformat(),
                    }
                )
        time.sleep(DELAY_BETWEEN_BATCHES)

    logger.info(
        "Fetched: %d updates / %d skipped / %d failed batches",
        len(updates),
        len(skipped),
        fail_batches,
    )
    if skipped:
        logger.info("Skipped tickers (first 20): %s", skipped[:20])

    if args.dry_run:
        logger.info("--dry-run — not writing. Sample updates:")
        for row in updates[:10]:
            logger.info(
                "  %s  $%s  asof=%s",
                row["ticker"],
                row["price"],
                row["price_asof"],
            )
        return 0

    if not updates:
        logger.warning("No updates to write")
        return 0

    # Write the live quote to the Level 0 home (securities.price) — the single
    # source MTM/trading read now that companies is retired.
    db.bulk_upsert_security_prices(updates)
    logger.info("Wrote %d price updates to securities", len(updates))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
