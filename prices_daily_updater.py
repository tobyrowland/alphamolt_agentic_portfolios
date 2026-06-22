"""
prices_daily_updater.py — Level 0 daily price layer (the Pareto king).

Daily clock (spec §3). Maintains `prices_daily` for the Tier 1 set:

  * Daily increment — one `eod-bulk-last-day` call writes the latest trading
    day's OHLCV for every Tier 1 ticker (idempotent upsert on (ticker, date)).
  * Backfill — any Tier 1 ticker with no recent prices_daily row (a fresh
    promotion from the weekly gate) gets a full per-ticker history pull
    (``HISTORY_YEARS`` of daily history). 5 years is carried so long-horizon
    lenses work — notably the 200-week (~3.85y) moving average the
    ``ma_sniper`` strategy gates on; a 200wMA needs ~4y of weekly closes to
    even compute, so 2y was not enough.

`dollar_volume` (close * volume) is stored alongside so the affordability gate
and liquidity lenses don't recompute it. `adj_close` carries EODHD's
split/dividend-adjusted close so valuation-over-time stays consistent.

Usage:
    python prices_daily_updater.py                 # increment + backfill new names
    python prices_daily_updater.py --backfill      # force full 5y for all Tier 1
    python prices_daily_updater.py --tickers NVDA AAPL
    python prices_daily_updater.py --dry-run
"""

import argparse
import logging
import time
from datetime import date, timedelta

from db import SupabaseDB
from eodhd import EODHDClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("prices_daily")

HISTORY_YEARS = 5   # 5y of daily history → enough for a 200-week (~3.85y) MA
RECENT_WINDOW_DAYS = 7   # a Tier 1 ticker with a row newer than this is "current"


def _row(ticker: str, r: dict) -> dict | None:
    """Map one EODHD eod / bulk row to a prices_daily row."""
    d = r.get("date")
    close = r.get("close")
    vol = r.get("volume")
    if not d or close is None:
        return None
    dollar_volume = None
    if vol is not None:
        try:
            dollar_volume = float(close) * float(vol)
        except (TypeError, ValueError):
            dollar_volume = None
    return {
        "ticker": ticker,
        "date": d,
        "open": r.get("open"),
        "high": r.get("high"),
        "low": r.get("low"),
        "close": close,
        "adj_close": r.get("adjusted_close"),
        "volume": vol,
        "dollar_volume": dollar_volume,
    }


def backfill_ticker(db: SupabaseDB, client: EODHDClient, ticker: str,
                    years: int, dry_run: bool) -> int:
    """Pull `years` of daily history for one ticker into prices_daily."""
    from_date = (date.today() - timedelta(days=365 * years + 5)).isoformat()
    history = client.eod(f"{ticker}.US", from_date=from_date)
    rows = [r for r in (_row(ticker, h) for h in history) if r]
    if rows and not dry_run:
        db.upsert_prices_daily_batch(rows)
    return len(rows)


def daily_increment(db: SupabaseDB, client: EODHDClient, tier1: set[str],
                    dry_run: bool) -> int:
    """Write the latest trading day's OHLCV for every Tier 1 ticker."""
    bulk = client.bulk_last_day("US")
    rows = []
    for r in bulk:
        code = (r.get("code") or "").strip().upper()
        if code in tier1:
            mapped = _row(code, r)
            if mapped:
                rows.append(mapped)
    if rows and not dry_run:
        db.upsert_prices_daily_batch(rows)
        # Stamp the Level 0 "current price" canary (securities.price) from the
        # EOD close for the WHOLE Tier 1 set — so every name has a price even
        # when the 15-min intraday feed (which only returns the liquid subset)
        # doesn't. intraday_prices.py overlays that subset with fresher quotes
        # during market hours; here we guarantee full coverage at the daily close.
        sec_rows = [
            {"ticker": m["ticker"], "price": m["close"],
             "price_asof": f"{m['date']}T20:00:00+00:00"}
            for m in rows
        ]
        db.bulk_upsert_security_prices(sec_rows)
    logger.info("Daily increment: %d Tier 1 rows for %s",
                len(rows), bulk[0].get("date") if bulk else "?")
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description="Level 0 prices_daily updater")
    ap.add_argument("--backfill", action="store_true",
                    help="force full backfill for all Tier 1 (not just new names)")
    ap.add_argument("--tickers", nargs="+", help="limit to these tickers")
    ap.add_argument("--years", type=int, default=HISTORY_YEARS)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    started = time.time()
    db = SupabaseDB()
    client = EODHDClient()

    tier1 = db.get_tier1_tickers()
    if args.tickers:
        wanted = {t.upper() for t in args.tickers}
        tier1 = tier1 & wanted if not args.backfill else wanted
        logger.info("Restricted to %d requested ticker(s)", len(tier1))
    logger.info("Tier 1 universe: %d tickers", len(tier1))

    # Which names need a full backfill?
    if args.backfill or args.tickers:
        to_backfill = set(tier1)
    else:
        since = (date.today() - timedelta(days=RECENT_WINDOW_DAYS)).isoformat()
        current = db.get_tickers_with_recent_prices(since)
        to_backfill = tier1 - current
    logger.info("Backfilling %d ticker(s) (%dy history)", len(to_backfill), args.years)

    backfilled_rows = 0
    errors = 0
    for i, t in enumerate(sorted(to_backfill), 1):
        try:
            n = backfill_ticker(db, client, t, args.years, args.dry_run)
            backfilled_rows += n
            if i % 50 == 0:
                logger.info("  ... %d/%d backfilled", i, len(to_backfill))
        except Exception as e:  # one bad ticker must not abort the run
            errors += 1
            logger.warning("Backfill failed for %s: %s", t, e)

    inc_rows = 0
    if not args.tickers or not args.backfill:
        inc_rows = daily_increment(db, client, tier1, args.dry_run)

    stats = {
        "backfilled": len(to_backfill),
        "updated": inc_rows,
        "errors": errors,
        "duration_secs": round(time.time() - started, 1),
        "details": {
            "tier1": len(tier1),
            "backfill_rows": backfilled_rows,
            "increment_rows": inc_rows,
            "dry_run": args.dry_run,
        },
    }
    logger.info("Done: %s", stats["details"])
    if not args.dry_run:
        db.log_run("prices_daily", stats)
        # Rebuild the screener's materialized facts view (migration 044) so it
        # picks up today's fresh prices + any new fundamentals/valuation. The
        # screener reads screen_facts_mv, not the live LATERAL joins, so it must
        # be refreshed once the daily data has settled.
        try:
            db.refresh_screen_facts()
            logger.info("Refreshed screen_facts_mv")
        except Exception as exc:  # noqa: BLE001 — non-fatal
            logger.warning("Could not refresh screen_facts_mv: %s", exc)
        # NOTE: the screener base score now ranks each lens by its EMPIRICAL
        # PERCENTILE over the loaded universe (outlier-robust), so it no longer
        # needs materialized lens μ/σ — the old screen_lens_stats recompute was
        # removed here. The table is left in place (vestigial) for a later cleanup.


if __name__ == "__main__":
    main()
