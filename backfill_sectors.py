#!/usr/bin/env python3
"""
backfill_sectors.py — populate securities.gics_sector / gics_industry from EODHD.

universe_sync.py builds the Tier 0 `securities` table from EODHD's
exchange-symbol-list, which carries no sector — so gics_sector starts NULL for
every name (~71% of Tier 1 had no sector, leaving the screener's Sector column
and filter mostly empty). This fetches each security's General.Sector /
General.Industry from the EODHD `fundamentals` endpoint and writes them onto
`securities`, in ONE consistent EODHD taxonomy.

By default it re-fetches EVERY active Tier 1 name (uniform taxonomy across the
whole column); `--only-missing` fills just the NULLs (cheap — the weekly cron
mode, to pick up names universe_sync added). After writing it refreshes the
screen_facts materialized view so the screener shows the sectors immediately.

It never overwrites an existing sector with a blank: a name EODHD has no sector
for keeps whatever it already had.

    python backfill_sectors.py                  # all active Tier 1 (full re-fetch)
    python backfill_sectors.py --only-missing    # only rows with a NULL sector
    python backfill_sectors.py --tickers IAG GFI DRD
    python backfill_sectors.py --all-securities  # Tier 0 (every active security)
    python backfill_sectors.py --dry-run --limit 20

Env: EODHD_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone

from dotenv import load_dotenv

from db import SupabaseDB
from eodhd import EODHDClient, EODHDError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("backfill_sectors")

WRITE_BATCH = 200


def _clean(v: object) -> str | None:
    """EODHD sometimes returns '', 'NA' or None for an unclassified field."""
    if not isinstance(v, str):
        return None
    s = v.strip()
    if not s or s.upper() in {"NA", "N/A", "NONE", "NULL"}:
        return None
    return s


def select_targets(db: SupabaseDB, args: argparse.Namespace) -> list[dict]:
    """The securities to (re)fetch, honouring the scope flags."""
    rows = db.get_all_securities(
        columns="ticker,is_tier1,gics_sector", status="active"
    )
    if args.tickers:
        want = {t.upper() for t in args.tickers}
        rows = [r for r in rows if (r.get("ticker") or "").upper() in want]
    elif not args.all_securities:
        rows = [r for r in rows if r.get("is_tier1")]
    if args.only_missing:
        rows = [r for r in rows if not _clean(r.get("gics_sector"))]
    rows.sort(key=lambda r: r.get("ticker") or "")
    if args.limit:
        rows = rows[: args.limit]
    return rows


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(description="Backfill securities sectors from EODHD")
    ap.add_argument("--only-missing", action="store_true",
                    help="only rows whose gics_sector is NULL (cron mode)")
    ap.add_argument("--all-securities", action="store_true",
                    help="every active security (Tier 0), not just Tier 1")
    ap.add_argument("--tickers", nargs="+", default=None,
                    help="restrict to these bare tickers (e.g. IAG GFI)")
    ap.add_argument("--limit", type=int, default=None, help="cap rows (smoke test)")
    ap.add_argument("--dry-run", action="store_true", help="fetch but write nothing")
    ap.add_argument("--no-refresh", action="store_true",
                    help="skip the screen_facts matview refresh at the end")
    args = ap.parse_args()

    db = SupabaseDB()
    client = EODHDClient()

    targets = select_targets(db, args)
    logger.info("Backfilling sectors for %d securities%s%s",
                len(targets),
                " (only missing)" if args.only_missing else "",
                " [dry-run]" if args.dry_run else "")

    pending: list[dict] = []
    written = updated = missing = errors = 0
    now = datetime.now(timezone.utc).isoformat()

    def flush() -> None:
        nonlocal written
        if pending and not args.dry_run:
            db.upsert_securities_batch(pending)
            written += len(pending)
        pending.clear()

    for i, r in enumerate(targets, 1):
        ticker = r.get("ticker")
        if not ticker:
            continue
        try:
            fund = client.fundamentals(f"{ticker}.US")
        except EODHDError as e:
            errors += 1
            logger.warning("%s: fundamentals failed (%s)", ticker, e)
            continue

        general = (fund or {}).get("General") or {}
        sector = _clean(general.get("Sector"))
        industry = _clean(general.get("Industry"))
        if not sector and not industry:
            missing += 1
        else:
            # Only write the fields we actually got — never blank out an
            # existing sector when EODHD has no classification for the name.
            row: dict = {"ticker": ticker, "updated_at": now}
            if sector:
                row["gics_sector"] = sector
            if industry:
                row["gics_industry"] = industry
            pending.append(row)
            updated += 1

        if len(pending) >= WRITE_BATCH:
            flush()
        if i % 200 == 0:
            logger.info("  %d/%d  (updated=%d missing=%d errors=%d)",
                        i, len(targets), updated, missing, errors)

    flush()

    logger.info("Done. fetched=%d updated=%d written=%d missing=%d errors=%d",
                len(targets), updated, written, missing, errors)

    if not args.dry_run and not args.no_refresh and written:
        logger.info("Refreshing screen_facts matview so the screener picks up sectors…")
        try:
            db.refresh_screen_facts()
        except Exception as e:  # noqa: BLE001 — a refresh hiccup shouldn't fail the run
            logger.warning("matview refresh failed (%s) — daily price job will refresh", e)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
