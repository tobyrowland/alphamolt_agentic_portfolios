"""
fundamentals_updater.py — daily ROTATING refresher for the Level 0
`fundamentals` table (closes the "fundamentals frozen, no refresher" gap the
freshness audit found).

The legacy `eodhd_updater.py` refreshed only the (now-retired) `companies`
table; Level 0 `fundamentals` was ever only seeded/backfilled once, so its
metrics — and therefore the screener's Quality/Value lenses — went stale. This
script keeps them fresh on a rotation, exactly like the bull/bear/research
evaluators: each daily run refreshes the N **stalest** Tier-1 names (oldest
`fundamentals.fetched_at` first, never-fetched names ahead of those), so the
whole universe cycles every `ceil(universe / batch)` days while daily EODHD
cost stays flat and bounded.

It reuses `eodhd_updater.fetch_eodhd_data` (same revenue-growth / margin / FCF /
Rule-of-40 / EPS / opex computation as the legacy pipeline) and the
`backfill_tier1_fundamentals.FUND_FIELDS` mapping, and writes via
`db.upsert_fundamentals_batch` (which stamps `fetched_at` — the freshness
contract). `period_end` uses the synthetic fetch-date convention the seed +
backfill use, so `screen_facts()` (latest period_end) picks up the fresh row.

Usage:
    python fundamentals_updater.py                 # refresh the 150 stalest
    python fundamentals_updater.py --batch 300     # refresh more per run
    python fundamentals_updater.py --tickers NVDA AAPL
    python fundamentals_updater.py --dry-run
    python fundamentals_updater.py --delay 0.5
"""

import argparse
import logging
import os
import time
from datetime import date

from db import SupabaseDB
from eodhd_updater import fetch_eodhd_data
from backfill_tier1_fundamentals import FUND_FIELDS, FUND_BLOBS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("fundamentals_updater")

DEFAULT_BATCH = 150   # stalest names refreshed per run (rotation)
DEFAULT_DELAY = 1.0   # seconds between EODHD calls
UPSERT_FLUSH = 200    # rows per upsert flush


def select_stale_batch(
    tier1_tickers: list[str],
    freshness: dict[str, str],
    limit: int,
) -> list[str]:
    """Rotation selection (pure, unit-tested): the `limit` stalest tickers.

    Names with no fundamentals row at all sort first; the rest by ascending
    `fetched_at` (oldest refreshed first). ISO timestamps sort lexically, so a
    plain string compare is correct.
    """
    def key(t: str):
        f = freshness.get(t)
        return (0, "") if f is None else (1, f)

    return sorted(tier1_tickers, key=key)[: max(0, limit)]


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Daily rotating refresher for Level 0 fundamentals",
    )
    ap.add_argument("--batch", type=int, default=DEFAULT_BATCH,
                    help=f"stalest names to refresh this run (default {DEFAULT_BATCH})")
    ap.add_argument("--tickers", nargs="+",
                    help="explicit ticker list (still requires Tier 1 active); "
                         "bypasses the rotation selection")
    ap.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                    help=f"seconds between EODHD calls (default {DEFAULT_DELAY})")
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch + log, but write nothing")
    args = ap.parse_args()

    key = os.environ.get("EODHD_API_KEY")
    if not key:
        logger.error("EODHD_API_KEY is not set — aborting")
        raise SystemExit(1)

    started = time.time()
    db = SupabaseDB()

    secs = db.get_all_securities(
        columns="ticker,name,exchange,is_tier1,status", status="active")
    tier1 = {s["ticker"]: s for s in secs if s.get("is_tier1")}

    if args.tickers:
        want = {t.upper() for t in args.tickers}
        target_tickers = [t for t in tier1 if t.upper() in want]
    else:
        freshness = db.get_fundamentals_freshness()
        target_tickers = select_stale_batch(list(tier1), freshness, args.batch)

    logger.info("Tier 1 active=%d; refreshing %d stalest this run",
                len(tier1), len(target_tickers))

    fetch_date = date.today().isoformat()
    batch: list[dict] = []
    written = errors = no_data = 0

    for idx, ticker in enumerate(target_tickers):
        name = (tier1.get(ticker) or {}).get("name") or ""
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

        if not args.dry_run and len(batch) >= UPSERT_FLUSH:
            db.upsert_fundamentals_batch(batch)
            written += len(batch)
            batch = []

        if (idx + 1) % 100 == 0:
            logger.info("…%d/%d processed (written≈%d, no_data=%d, errors=%d)",
                        idx + 1, len(target_tickers), written + len(batch),
                        no_data, errors)

        if idx < len(target_tickers) - 1:
            time.sleep(args.delay)

    if not args.dry_run and batch:
        db.upsert_fundamentals_batch(batch)
        written += len(batch)

    stats = {
        "updated": written,
        "skipped": no_data,
        "errors": errors,
        "duration_secs": round(time.time() - started, 1),
        "details": {
            "tier1_active": len(tier1),
            "targeted": len(target_tickers),
            "written": written,
            "no_data": no_data,
            "errors": errors,
            "dry_run": args.dry_run,
        },
    }
    logger.info("Done: %s", stats["details"])
    if not args.dry_run:
        db.log_run("fundamentals_updater", stats)


if __name__ == "__main__":
    main()
