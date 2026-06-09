#!/usr/bin/env python3
"""
backfill_sectors.py — populate securities.gics_sector from TradingView.

universe_sync builds `securities` from EODHD's exchange-symbol-list, which
carries no sector, so gics_sector starts NULL. The screener reads it (via the
screen_facts matview) for the Sector column + filter, so most of the Tier 1
universe — gold miners, banks, ADRs — shows "—".

Source: TradingView (`tv_screen.fetch_sector_data`, the same helper
nightly_screen uses). Chosen over EODHD because it (a) covers every US-listed
name, including the miners / financials / ADRs EODHD classifies poorly or not at
all, and (b) uses the SAME sector taxonomy already shown on the screener
("Technology Services", "Non-Energy Minerals", "Finance", …), so the Sector
filter / dropdown stay coherent. EODHD's different taxonomy would fragment them.

Writes ONLY gics_sector, in a UNIFORM single-column payload. This matters: the
previous EODHD version mixed sector-only and industry-only rows in one batch, and
PostgREST's upsert pads the column union with NULLs — which UPDATE-on-conflict
then wrote back, wiping existing sectors. Every row here carries exactly
{ticker, gics_sector, updated_at}, so a batch can never null another column.

Idempotent and additive: a name TradingView can't resolve keeps whatever sector
it already had (we never write a blank). Re-running therefore RESTORES sectors a
bad run cleared, and fills the names that never had one. Refreshes the
screen_facts matview at the end so the screener shows sectors immediately.

    python backfill_sectors.py                   # all active Tier 1
    python backfill_sectors.py --only-missing     # only NULL sectors (cron mode)
    python backfill_sectors.py --tickers IAG GFI DRD
    python backfill_sectors.py --all-securities   # Tier 0 (every active security)
    python backfill_sectors.py --dry-run --limit 50

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (TradingView needs no API key).
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone

from dotenv import load_dotenv

from db import SupabaseDB
from tv_screen import fetch_sector_data

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("backfill_sectors")

WRITE_BATCH = 500


def _clean(v: object) -> str | None:
    """Treat blank / NA / None placeholders as 'no sector'."""
    if not isinstance(v, str):
        return None
    s = v.strip()
    if not s or s.upper() in {"NA", "N/A", "NONE", "NULL", "NAN"}:
        return None
    return s


def select_targets(db: SupabaseDB, args: argparse.Namespace) -> list[dict]:
    """The securities to (re)fetch, honouring the scope flags."""
    rows = db.get_all_securities(
        columns="ticker,exchange,is_tier1,gics_sector", status="active"
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
    ap = argparse.ArgumentParser(description="Backfill securities sectors from TradingView")
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
    targets = select_targets(db, args)
    logger.info("Resolving sectors for %d securities%s%s",
                len(targets),
                " (only missing)" if args.only_missing else "",
                " [dry-run]" if args.dry_run else "")
    if not targets:
        logger.info("Nothing to do.")
        return 0

    # One batched, no-filter TradingView pull. Pass the stored exchange so
    # NYSE:/NASDAQ: names resolve on the first pass; fetch_sector_data retries the
    # rest across common exchanges.
    pairs = [(r["ticker"], r.get("exchange") or "") for r in targets]
    sectors = fetch_sector_data(pairs, logger)
    logger.info("TradingView returned a sector for %d/%d tickers", len(sectors), len(targets))

    now = datetime.now(timezone.utc).isoformat()
    pending: list[dict] = []
    written = updated = missing = 0

    def flush() -> None:
        nonlocal written
        if pending and not args.dry_run:
            db.upsert_securities_batch(pending)
            written += len(pending)
        pending.clear()

    for r in targets:
        ticker = r.get("ticker")
        if not ticker:
            continue
        sector = _clean(sectors.get(ticker.upper()))
        if not sector:
            missing += 1
            continue
        # Uniform single-field payload — never null another column on conflict.
        pending.append({"ticker": ticker, "gics_sector": sector, "updated_at": now})
        updated += 1
        if len(pending) >= WRITE_BATCH:
            flush()
    flush()

    logger.info("Done. resolved=%d updated=%d written=%d unresolved=%d",
                len(sectors), updated, written, missing)

    if not args.dry_run and not args.no_refresh and written:
        logger.info("Refreshing screen_facts matview so the screener picks up sectors…")
        try:
            db.refresh_screen_facts()
        except Exception as e:  # noqa: BLE001 — a refresh hiccup shouldn't fail the run
            logger.warning("matview refresh failed (%s) — daily price job will refresh", e)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
