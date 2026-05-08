#!/usr/bin/env python3
"""
One-off cleanup: delete companies whose `exchange` is not in the
canonical US set (NYSE/NASDAQ/AMEX/NYSEARCA/BATS/ARCA).

Background: TradingView's `america` market sometimes returns OTC
pink-sheet ADRs (e.g. UCBJY, CCOEF, RYKKY) and even primary foreign
listings (9697 Tokyo, ADYEN Amsterdam). Until the post-filter in
`tv_screen.py` was added, those rows were ingested by
`nightly_screen.py` and now need cleaning out.

Safety:
- Skips any ticker referenced by `agent_holdings` or `agent_trades`
  (FK ON DELETE RESTRICT / NO ACTION). `price_sales` and
  `consensus_snapshots` cascade.
- `--dry-run` just prints the deletion plan.

Usage:
    python delete_non_us_companies.py --dry-run
    python delete_non_us_companies.py
"""

import argparse
import logging
import sys
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

from db import SupabaseDB
from tv_screen import US_EXCHANGES

load_dotenv()


def setup_logging() -> logging.Logger:
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"delete_non_us_companies_{date.today().isoformat()}.txt"

    logger = logging.getLogger("delete_non_us_companies")
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


def _referenced_tickers(db: SupabaseDB, table: str, candidates: set[str]) -> set[str]:
    """Return the subset of `candidates` referenced by rows in `table`."""
    if not candidates:
        return set()
    referenced = set()
    # Supabase PostgREST `in` filter accepts a list — chunk to stay under URL limits.
    chunk = 100
    candidates_list = sorted(candidates)
    for i in range(0, len(candidates_list), chunk):
        batch = candidates_list[i:i + chunk]
        resp = (
            db.client.table(table)
            .select("ticker")
            .in_("ticker", batch)
            .execute()
        )
        for row in resp.data or []:
            referenced.add(row["ticker"])
    return referenced


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="Print plan without deleting")
    args = parser.parse_args()

    logger = setup_logging()
    logger.info("=" * 60)
    logger.info("Delete non-US companies — %s", date.today().isoformat())
    logger.info("US_EXCHANGES = %s", sorted(US_EXCHANGES))
    logger.info("=" * 60)

    db = SupabaseDB()

    rows = db.get_all_companies(columns="ticker, exchange, country, company_name")
    logger.info("Loaded %d companies", len(rows))

    # Bucket: non-US (incl. blank exchange) candidates
    non_us = []
    for row in rows:
        ex = str(row.get("exchange") or "").strip().upper()
        if ex not in US_EXCHANGES:
            non_us.append(row)

    logger.info("Found %d rows with exchange ∉ US_EXCHANGES", len(non_us))
    if not non_us:
        logger.info("Nothing to delete.")
        return

    candidate_tickers = {r["ticker"] for r in non_us}

    # FK guard: any ticker referenced by holdings or trades is preserved.
    held = _referenced_tickers(db, "agent_holdings", candidate_tickers)
    traded = _referenced_tickers(db, "agent_trades", candidate_tickers)
    protected = held | traded

    if protected:
        logger.warning(
            "%d tickers protected by FK references "
            "(agent_holdings=%d, agent_trades=%d): %s",
            len(protected), len(held), len(traded), sorted(protected),
        )

    deletable = [r for r in non_us if r["ticker"] not in protected]
    logger.info("Deletable: %d / %d", len(deletable), len(non_us))

    # Sample preview
    for r in sorted(deletable, key=lambda x: x["ticker"])[:50]:
        logger.info(
            "  DELETE %s (%s, %s) — %s",
            r["ticker"], r.get("exchange") or "—",
            r.get("country") or "—", r.get("company_name") or "",
        )
    if len(deletable) > 50:
        logger.info("  … and %d more", len(deletable) - 50)

    if args.dry_run:
        logger.info("Dry run — no changes written.")
        return

    if not deletable:
        logger.info("Nothing deletable after FK guard.")
        return

    # Delete in chunks via PostgREST `in_` filter.
    chunk = 100
    deletable_tickers = sorted({r["ticker"] for r in deletable})
    deleted = 0
    for i in range(0, len(deletable_tickers), chunk):
        batch = deletable_tickers[i:i + chunk]
        db.client.table("companies").delete().in_("ticker", batch).execute()
        deleted += len(batch)
        logger.info("Deleted batch %d (%d rows)", i // chunk + 1, len(batch))

    logger.info("Deleted %d non-US companies. Done.", deleted)


if __name__ == "__main__":
    main()
