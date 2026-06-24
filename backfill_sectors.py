#!/usr/bin/env python3
"""
backfill_sectors.py — populate securities.gics_sector + gics_industry from TradingView.

universe_sync builds `securities` from EODHD's exchange-symbol-list, which carries
no classification, so gics_sector / gics_industry start NULL. The screener reads
them (via the screen_facts matview) for the Sector column + filter and the P/S
peer grouping.

Source: TradingView (`tv_screen.fetch_classification_data`). Chosen over EODHD
because it (a) covers every US-listed name, including the miners / financials /
ADRs EODHD classifies poorly, and (b) uses the SAME taxonomy shown on the screener
("Technology Services", "Non-Energy Minerals", …), so the Sector filter / dropdown
stay coherent. The fetch matches symbols against TradingView's **america** market
(an isin(name) filter), which resolves ADRs the default scanner hides (RIO, SMFG)
and is immune to the foreign same-symbol collisions that corrupted the previous
per-exchange approach (e.g. ARIS → "Technology Services" from a German "ARIS").

Writes BOTH gics_sector AND gics_industry in a UNIFORM payload
({ticker, gics_sector, gics_industry, updated_at}) — uniform columns so PostgREST's
upsert can never null-pad a column that another row omitted.

Idempotent: a name TradingView can't resolve keeps whatever it already had (we
never write a blank for a field). Refreshes the screen_facts matview at the end so
the screener picks the changes up immediately.

    python backfill_sectors.py                   # all active Tier 1 (overwrite)
    python backfill_sectors.py --only-missing     # only rows missing sector OR industry
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
from tv_screen import fetch_classification_data

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
        columns="ticker,exchange,is_tier1,gics_sector,gics_industry", status="active"
    )
    if args.tickers:
        want = {t.upper() for t in args.tickers}
        rows = [r for r in rows if (r.get("ticker") or "").upper() in want]
    elif not args.all_securities:
        rows = [r for r in rows if r.get("is_tier1")]
    if args.only_missing:
        rows = [
            r for r in rows
            if not _clean(r.get("gics_sector")) or not _clean(r.get("gics_industry"))
        ]
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

    # One batched, no-filter TradingView pull. Pass the stored exchange so each
    # name resolves on its OWN exchange first; the fallback retries US exchanges
    # only (a foreign same-symbol match is always the wrong company).
    pairs = [(r["ticker"], r.get("exchange") or "") for r in targets]
    classes = fetch_classification_data(pairs, logger)
    logger.info("TradingView returned a classification for %d/%d tickers",
                len(classes), len(targets))

    now = datetime.now(timezone.utc).isoformat()
    # Two UNIFORM payloads — one per classification column. Each batch carries
    # exactly one of {gics_sector, gics_industry}, so PostgREST's upsert can never
    # null-pad (and clobber) the column a row happens to omit. We also never write
    # a blank, so an unresolved field keeps whatever it already had.
    sector_rows: list[dict] = []
    industry_rows: list[dict] = []
    written = updated = missing = 0

    def flush() -> None:
        nonlocal written
        if not args.dry_run:
            if sector_rows:
                db.upsert_securities_batch(sector_rows)
                written += len(sector_rows)
            if industry_rows:
                db.upsert_securities_batch(industry_rows)
                written += len(industry_rows)
        sector_rows.clear()
        industry_rows.clear()

    for r in targets:
        ticker = r.get("ticker")
        if not ticker:
            continue
        cls = classes.get(ticker.upper()) or {}
        sector = _clean(cls.get("sector"))
        industry = _clean(cls.get("industry"))
        if not sector and not industry:
            missing += 1
            continue
        if sector:
            sector_rows.append({"ticker": ticker, "gics_sector": sector, "updated_at": now})
        if industry:
            industry_rows.append({"ticker": ticker, "gics_industry": industry, "updated_at": now})
        updated += 1
        if len(sector_rows) >= WRITE_BATCH or len(industry_rows) >= WRITE_BATCH:
            flush()
    flush()

    logger.info("Done. resolved=%d updated=%d rows_written=%d unresolved=%d",
                len(classes), updated, written, missing)

    if not args.dry_run and not args.no_refresh and written:
        logger.info("Refreshing screen_facts matview so the screener picks up classifications…")
        try:
            db.refresh_screen_facts()
        except Exception as e:  # noqa: BLE001 — a refresh hiccup shouldn't fail the run
            logger.warning("matview refresh failed (%s) — daily price job will refresh", e)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
