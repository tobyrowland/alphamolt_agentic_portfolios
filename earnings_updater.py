"""
earnings_updater.py — Level 0 earnings-date ingest (fills the `events` table).

The `events` table (migration 039) has always had an `earnings` slot and a read
path (`level0.FactStore.get_facts` returns the recent/upcoming events), but no
job ever wrote to it — earnings dates were pure scaffolding. This script is that
missing writer: it pulls the EODHD earnings calendar for the Tier 1 universe and
upserts one `type='earnings'` row per scheduled release, giving the arena real
visibility on *when each name next reports* (and its most recent report).

Source: EODHD `/calendar/earnings` — the forward-looking earnings calendar. We
query it scoped to the Tier 1 codes (chunked to keep URLs short) over a window
that reaches a little into the past (so "last reported" is captured) and out to
`--days` ahead (default 90 — roughly the quarterly cadence, so every active name
has an upcoming date). `report_date` is the announcement date we store as the
event date; the upsert is idempotent on the `(ticker, 'earnings', date)` PK, so
re-runs only touch changed/added dates.

**Earnings trigger a fundamentals refresh.** A name that just reported has fresh
financials at EODHD, so after ingest this script re-pulls fundamentals for every
name whose earnings landed in the last `--refresh-back` days (default 3 — EODHD
posts the new numbers a day or two after the release), reusing
`fundamentals_updater.refresh_fundamentals`. That jumps a fresh reporter to the
front of the ~universe/150-day rotation instead of waiting for it to come round.

Usage:
    python earnings_updater.py                 # Tier 1, next 90d + last 14d
    python earnings_updater.py --days 120       # look further ahead
    python earnings_updater.py --back 0         # upcoming only
    python earnings_updater.py --no-fundamentals-refresh   # ingest dates only
    python earnings_updater.py --tickers NVDA AAPL
    python earnings_updater.py --dry-run
"""

import argparse
import logging
import os
import time
from datetime import date, timedelta

from db import SupabaseDB
from eodhd import EODHDClient
from fundamentals_updater import refresh_fundamentals

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("earnings")

FORWARD_DAYS = 90    # how far ahead to fetch scheduled earnings
BACK_DAYS = 14       # small trailing window so "last reported" is captured
CHUNK = 100          # EODHD codes per /calendar/earnings call (URL-length safe)
REFRESH_BACK = 3     # a name reporting within this many days triggers a
                     # fundamentals refresh (EODHD posts the new numbers ~1-2d
                     # after the release, so re-pulling for a few days catches it)


def _event_row(row: dict, tier1: set[str]) -> dict | None:
    """Map one EODHD earnings-calendar row to an `events` row.

    Keeps only US-listed Tier 1 names, uses `report_date` (the announcement
    date) — falling back to `date` (period end) only when it is absent — and
    stamps `type='earnings'`. Returns None for anything outside the universe or
    without a usable date.
    """
    code = (row.get("code") or "").strip().upper()
    if not code.endswith(".US"):
        return None
    ticker = code[:-len(".US")]
    if ticker not in tier1:
        return None
    event_date = (row.get("report_date") or row.get("date") or "").strip()
    if not event_date:
        return None
    return {
        "ticker": ticker,
        "type": "earnings",
        "date": event_date,
        "source": "eodhd",
    }


def recent_reporters(rows: list[dict], since: str, until: str) -> list[str]:
    """Unique tickers with an earnings event in [since, until] (ISO date strings).

    These names just reported (or report today), so fresh fundamentals should
    now be available at EODHD — the trigger for a fundamentals refresh. Pure +
    unit-tested (ISO dates sort/compare lexically, so the string bound check is
    correct).
    """
    out = {
        r["ticker"] for r in rows
        if r.get("type") == "earnings" and since <= (r.get("date") or "") <= until
    }
    return sorted(out)


def _chunks(items: list[str], size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def fetch_earnings(client: EODHDClient, tier1: set[str],
                   from_date: str, to_date: str) -> list[dict]:
    """Fetch + map earnings rows for the whole Tier 1 set (chunked calls)."""
    codes = sorted(f"{t}.US" for t in tier1)
    rows: dict[tuple[str, str], dict] = {}
    for n, batch in enumerate(_chunks(codes, CHUNK), 1):
        raw = client.earnings_calendar(from_date=from_date, to_date=to_date,
                                       symbols=batch)
        for r in raw:
            mapped = _event_row(r, tier1)
            if mapped:
                rows[(mapped["ticker"], mapped["date"])] = mapped
        logger.info("  ... chunk %d (%d codes) → %d events so far",
                    n, len(batch), len(rows))
    return list(rows.values())


def main() -> None:
    ap = argparse.ArgumentParser(description="Level 0 earnings-date ingest")
    ap.add_argument("--days", type=int, default=FORWARD_DAYS,
                    help="how many days ahead to fetch (default 90)")
    ap.add_argument("--back", type=int, default=BACK_DAYS,
                    help="how many days of recent releases to also fetch (default 14)")
    ap.add_argument("--tickers", nargs="+", help="limit to these tickers")
    ap.add_argument("--refresh-back", type=int, default=REFRESH_BACK,
                    help="names reporting within this many days get a fundamentals "
                         f"refresh (default {REFRESH_BACK}); 0 = same-day only, "
                         "negative disables")
    ap.add_argument("--no-fundamentals-refresh", action="store_true",
                    help="skip the earnings-triggered fundamentals refresh")
    ap.add_argument("--delay", type=float, default=1.0,
                    help="seconds between EODHD fundamentals calls (default 1.0)")
    ap.add_argument("--dry-run", action="store_true", help="fetch but write nothing")
    args = ap.parse_args()

    started = time.time()
    db = SupabaseDB()
    client = EODHDClient()

    tier1 = db.get_tier1_tickers()
    if args.tickers:
        wanted = {t.upper() for t in args.tickers}
        tier1 = tier1 & wanted if tier1 & wanted else wanted
        logger.info("Restricted to %d requested ticker(s)", len(tier1))
    logger.info("Tier 1 universe: %d tickers", len(tier1))

    from_date = (date.today() - timedelta(days=args.back)).isoformat()
    to_date = (date.today() + timedelta(days=args.days)).isoformat()
    logger.info("Fetching earnings calendar %s → %s", from_date, to_date)

    rows = fetch_earnings(client, tier1, from_date, to_date)
    upcoming = sum(1 for r in rows if r["date"] >= date.today().isoformat())
    logger.info("Mapped %d earnings events (%d upcoming) for %d names",
                len(rows), upcoming, len({r["ticker"] for r in rows}))

    if rows and not args.dry_run:
        db.upsert_events_batch(rows)

    # A name that just reported has fresh fundamentals available at EODHD — pull
    # them now instead of waiting for the ~universe/150-day rotation to reach it.
    reporters: list[str] = []
    fund_res = {"written": 0, "no_data": 0, "errors": 0}
    if not args.no_fundamentals_refresh and args.refresh_back >= 0:
        since = (date.today() - timedelta(days=args.refresh_back)).isoformat()
        until = date.today().isoformat()
        reporters = recent_reporters(rows, since, until)
        logger.info("%d name(s) reported in [%s, %s] → refreshing fundamentals",
                    len(reporters), since, until)
        if reporters:
            key = os.environ.get("EODHD_API_KEY", "")
            fund_res = refresh_fundamentals(db, reporters, key, log=logger,
                                            delay=args.delay, dry_run=args.dry_run)
            logger.info("Fundamentals refresh: %s", fund_res)

    stats = {
        "backfilled": 0,
        "updated": len(rows),
        "errors": fund_res["errors"],
        "duration_secs": round(time.time() - started, 1),
        "details": {
            "tier1": len(tier1),
            "events": len(rows),
            "upcoming": upcoming,
            "names": len({r["ticker"] for r in rows}),
            "from": from_date,
            "to": to_date,
            "reporters_refreshed": len(reporters),
            "fundamentals_written": fund_res["written"],
            "dry_run": args.dry_run,
        },
    }
    logger.info("Done: %s", stats["details"])
    if not args.dry_run:
        db.log_run("earnings_calendar", stats)


if __name__ == "__main__":
    main()
