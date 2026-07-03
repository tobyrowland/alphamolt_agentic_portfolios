"""
backfill_tier1_fundamentals.py — one-shot backfill of the Level 0 `fundamentals`
table for Tier 1 securities that have no fundamentals row yet.

Why this exists
---------------
The recurring `eodhd_updater.py` enriches only the legacy `companies` table.
The Level 0 `fundamentals` table was ever only *seeded* from `companies` by a
since-removed one-off migration (~1k rows, all `source='migrated:companies'`).
So the other Tier 1 names (currently ~2.3k) have daily prices but **no
fundamentals** — which makes them invisible to the screener, because
`screen_facts()` INNER JOINs `fundamentals` (a name can only be ranked if it has
a fundamentals row). This script closes that gap: it fetches EODHD fundamentals
for the missing Tier 1 names and writes them into `fundamentals` with
`source='eodhd'`.

It reuses `eodhd_updater.fetch_eodhd_data` for the EODHD parsing (revenue
growth, margins, FCF, Rule of 40, EPS, opex), so the metrics are computed
exactly the same way as the `companies` pipeline.

Scope / idempotency
-------------------
- Targets `securities` rows with `is_tier1 AND status='active'` that have **no**
  fundamentals row at all (re-running only fills genuinely-missing names; it
  never re-appends to names that already have data).
- `period_end` is stamped with the fetch date (the same synthetic-date
  convention the seed used). `screen_facts()` reads the latest `period_end`, so
  a freshly-stamped row is the one it picks up. A future recurring job should
  key `period_end` on the real filing date instead.
- This does NOT populate `valuation` (P/S) — that lens needs price×shares ÷
  revenue and is handled separately. Backfilled names rank on Quality +
  Momentum immediately; their Value component stays null until valuation is
  backfilled too.

Usage:
    python backfill_tier1_fundamentals.py                 # all missing Tier 1
    python backfill_tier1_fundamentals.py --dry-run        # fetch + log, no writes
    python backfill_tier1_fundamentals.py --limit 50       # first 50 missing
    python backfill_tier1_fundamentals.py --tickers NVDA AAPL
    python backfill_tier1_fundamentals.py --delay 0.5      # seconds between calls
"""

import argparse
import logging
import os
import time
from datetime import date

from db import SupabaseDB
from eodhd_updater import fetch_eodhd_data

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("backfill_tier1_fund")

# EODHD result key (from fetch_eodhd_data) -> Level 0 `fundamentals` column.
FUND_FIELDS = {
    "rev_growth_ttm": "rev_growth_ttm",
    "rev_growth_qoq": "rev_growth_qoq",
    "rev_cagr": "rev_cagr",
    "gross_margin": "gross_margin",
    "operating_margin": "operating_margin",
    "net_margin": "net_margin",
    "fcf_margin": "fcf_margin",
    "rule_of_40": "rule_of_40",
    "eps_only": "eps",
    "opex_pct_revenue": "opex_pct_rev",
}

# Per-period text-blob series (pipe-delimited, newest-first) stored verbatim —
# NOT floats, so they bypass the safe_float FUND_FIELDS loop. Power the
# company-page income chart (revenue + net income, annual + quarterly).
FUND_BLOBS = (
    "annual_revenue_5y",
    "quarterly_revenue",
    "annual_net_income_5y",
    "quarterly_net_income",
)

DEFAULT_DELAY = 1.0  # seconds between EODHD calls (rate-limit courtesy)
BATCH_SIZE = 200     # rows per upsert flush


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Backfill Level 0 fundamentals for Tier 1 names missing them",
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch + log, but write nothing")
    ap.add_argument("--limit", type=int,
                    help="only process the first N missing tickers")
    ap.add_argument("--tickers", nargs="+",
                    help="explicit ticker list (ignores the missing-only filter, "
                         "but still requires Tier 1 active)")
    ap.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                    help=f"seconds between EODHD calls (default {DEFAULT_DELAY})")
    args = ap.parse_args()

    key = os.environ.get("EODHD_API_KEY")
    if not key:
        logger.error("EODHD_API_KEY is not set — aborting")
        raise SystemExit(1)

    started = time.time()
    db = SupabaseDB()

    secs = db.get_all_securities(
        columns="ticker,name,exchange,is_tier1,status", status="active")
    tier1 = [s for s in secs if s.get("is_tier1")]

    if args.tickers:
        want = {t.upper() for t in args.tickers}
        targets = [s for s in tier1 if s["ticker"].upper() in want]
        missing = None
    else:
        have = db.get_fundamentals_tickers()
        targets = [s for s in tier1 if s["ticker"] not in have]
        missing = len(targets)

    targets.sort(key=lambda s: s["ticker"])
    if args.limit:
        targets = targets[:args.limit]

    logger.info("Tier 1 active=%d; %d to backfill%s",
                len(tier1), len(targets),
                f" (of {missing} missing)" if not args.tickers else "")

    fetch_date = date.today().isoformat()
    batch: list[dict] = []
    written = errors = no_data = 0

    for idx, s in enumerate(targets):
        ticker = s["ticker"]
        name = s.get("name") or ""
        # Level 0 is US-only — EODHD serves every US exchange (incl. OTC/PINK)
        # under the .US suffix, so resolve straight to "US" rather than letting
        # unmapped codes (PINK/OTCQX/…) 404 into the search fallback.
        try:
            data = fetch_eodhd_data(ticker, key, logger, exchange="US", company=name)
        except Exception as exc:  # noqa: BLE001 — log and keep going
            logger.error("fetch failed for %s: %s", ticker, exc)
            errors += 1
            data = None

        if data:
            row = {"ticker": ticker, "period_end": fetch_date, "source": "eodhd"}
            has_metric = False
            for src, dst in FUND_FIELDS.items():
                v = db.safe_float(data.get(src))
                if v is not None:
                    row[dst] = v
                    has_metric = True
            for blob in FUND_BLOBS:  # text series stored verbatim
                val = data.get(blob)
                if val:
                    row[blob] = val
                    has_metric = True
            if has_metric:
                batch.append(row)
                if args.dry_run:
                    logger.info("[DRY RUN] %s → %s", ticker,
                                {k: v for k, v in row.items()
                                 if k not in ("ticker", "period_end", "source")})
            else:
                no_data += 1
                logger.info("%s: fetched but no usable metrics", ticker)
        else:
            no_data += 1

        if not args.dry_run and len(batch) >= BATCH_SIZE:
            db.upsert_fundamentals_batch(batch)
            written += len(batch)
            batch = []

        if (idx + 1) % 100 == 0:
            logger.info("…%d/%d processed (written≈%d, no_data=%d, errors=%d)",
                        idx + 1, len(targets), written + len(batch),
                        no_data, errors)

        if idx < len(targets) - 1:
            time.sleep(args.delay)

    if not args.dry_run and batch:
        db.upsert_fundamentals_batch(batch)
        written += len(batch)
        batch = []

    stats = {
        "updated": written,
        "skipped": no_data,
        "errors": errors,
        "duration_secs": round(time.time() - started, 1),
        "details": {
            "tier1_active": len(tier1),
            "targeted": len(targets),
            "written": written,
            "no_data": no_data,
            "errors": errors,
            "dry_run": args.dry_run,
        },
    }
    logger.info("Done: %s", stats["details"])
    if not args.dry_run:
        db.log_run("backfill_tier1_fundamentals", stats)


if __name__ == "__main__":
    main()
