"""
migrate_companies_to_level0.py — one-off seed of Level 0 enrichment from the
existing pipeline (spec §11 step 4: "you already have ~1k enriched — reuse it").

Copies the scalar fundamentals already in `companies` and the P/S series in
`price_sales` onto the Level 0 `fundamentals` / `valuation` tables, for the
tickers that exist in `securities` (the FK target). This is a SEED, not a
historical reconstruction: each ticker gets one latest fundamentals row (keyed
by the company's `data_updated_at` as a synthetic period_end) and one latest
valuation row. The Level 0 fundamentals/valuation jobs take over from here on
their own cadence, appending real period_end rows as filings land.

Only scalar metrics that map cleanly are copied; revenue/cash/debt/shares_out
(stored as JSON snapshots in `companies`, not scalars) are left for the real
EODHD fundamentals pull to populate.

Usage:
    python migrate_companies_to_level0.py            # seed all overlapping tickers
    python migrate_companies_to_level0.py --dry-run
    python migrate_companies_to_level0.py --tier1-only
"""

import argparse
import logging
import time
from datetime import date

from db import SupabaseDB

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("migrate_level0")

# companies column -> fundamentals column (scalar metrics only)
FUND_MAP = {
    "rev_growth_ttm_pct": "rev_growth_ttm",
    "rev_growth_qoq_pct": "rev_growth_qoq",
    "rev_cagr_pct": "rev_cagr",
    "gross_margin_pct": "gross_margin",
    "operating_margin_pct": "operating_margin",
    "net_margin_pct": "net_margin",
    "fcf_margin_pct": "fcf_margin",
    "rule_of_40": "rule_of_40",
    "eps_only": "eps",
    "opex_pct_revenue": "opex_pct_rev",
}


def _as_date(val) -> str:
    """Coerce a timestamp/date string to YYYY-MM-DD, defaulting to today."""
    if not val:
        return date.today().isoformat()
    return str(val)[:10]


def main() -> None:
    ap = argparse.ArgumentParser(description="Seed Level 0 from companies/price_sales")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--tier1-only", action="store_true",
                    help="only seed tickers already flagged is_tier1")
    args = ap.parse_args()

    started = time.time()
    db = SupabaseDB()

    securities = db.get_all_securities(columns="ticker,is_tier1")
    sec_set = {s["ticker"] for s in securities}
    tier1_set = {s["ticker"] for s in securities if s.get("is_tier1")}
    target = tier1_set if args.tier1_only else sec_set
    logger.info("Level 0 has %d securities (%d Tier 1); seeding into %d",
                len(sec_set), len(tier1_set), len(target))

    companies = db.get_all_companies()
    price_sales = db.get_all_price_sales()

    fund_rows: list[dict] = []
    val_rows: list[dict] = []
    skipped = 0
    for c in companies:
        ticker = c.get("ticker")
        if ticker not in target:
            skipped += 1
            continue

        period_end = _as_date(c.get("data_updated_at"))
        fund = {"ticker": ticker, "period_end": period_end, "source": "migrated:companies"}
        has_fund = False
        for src, dst in FUND_MAP.items():
            v = db.safe_float(c.get(src))
            if v is not None:
                fund[dst] = v
                has_fund = True
        if has_fund:
            fund_rows.append(fund)

        ps = price_sales.get(ticker)
        ps_now = db.safe_float((ps or {}).get("ps_now") if ps else c.get("ps_now"))
        if ps_now is not None or ps:
            val = {
                "ticker": ticker,
                "date": _as_date((ps or {}).get("last_updated")),
                "ps": ps_now,
                "source": "migrated:price_sales",
            }
            if ps:
                val.update({
                    "ps_high_52w": db.safe_float(ps.get("high_52w")),
                    "ps_low_52w": db.safe_float(ps.get("low_52w")),
                    "ps_median_12m": db.safe_float(ps.get("median_12m")),
                    "ps_ath": db.safe_float(ps.get("ath")),
                    "ps_pct_of_ath": db.safe_float(ps.get("pct_of_ath")),
                    "history_json": ps.get("history_json"),
                })
            val_rows.append(val)

    logger.info("Prepared %d fundamentals + %d valuation rows (%d companies skipped)",
                len(fund_rows), len(val_rows), skipped)

    if not args.dry_run:
        for i in range(0, len(fund_rows), 500):
            db.upsert_fundamentals_batch(fund_rows[i:i + 500])
        for i in range(0, len(val_rows), 500):
            db.upsert_valuation_batch(val_rows[i:i + 500])

    stats = {
        "updated": len(fund_rows) + len(val_rows),
        "skipped": skipped,
        "errors": 0,
        "duration_secs": round(time.time() - started, 1),
        "details": {"fundamentals": len(fund_rows), "valuation": len(val_rows),
                    "dry_run": args.dry_run},
    }
    logger.info("Done: %s", stats["details"])
    if not args.dry_run:
        db.log_run("migrate_companies_to_level0", stats)


if __name__ == "__main__":
    main()
