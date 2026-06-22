"""
backfill_tier1_valuation.py — one-shot backfill of the Level 0 `valuation`
(P/S) table for Tier 1 securities that have no valuation row yet.

Why this exists
---------------
The screener's **Value** lens reads `valuation.ps` and `valuation.ps_median_12m`
(inverse P/S ÷ its own 12-month median). Like fundamentals, the Level 0
`valuation` table was only ever seeded from the legacy `price_sales` table by
a since-removed one-off migration (~936 rows), so the rest of Tier 1 has no P/S
and ranks with a null Value component. This is the companion to
`backfill_tier1_fundamentals.py`.

How
---
Per missing Tier 1 ticker:
  1. Fetch EODHD fundamentals (reusing `eodhd_updater.fetch_fundamentals_with_fallbacks`)
     to get market cap + trailing-12-month revenue (the same `get_market_cap` /
     `get_revenue_ttm` helpers `price_sales_updater` uses).
  2. `ps_now = market_cap / revenue_ttm`.
  3. Build the 52-week P/S history from **Level 0 `prices_daily`** (which already
     holds 2y of daily closes for every Tier 1 name — no Yahoo round-trip),
     resampled to one point per ISO week, via the same price-ratio method
     `price_sales_updater` uses: `ps_week = ps_now × (week_close / latest_close)`.
  4. Derive `ps_high_52w` / `ps_low_52w` / `ps_median_12m` / `ps_ath` /
     `ps_pct_of_ath` / `ps_trend_pct` (trailing-quarter direction of the
     multiple — migration 058) and write a `valuation` row (`source='eodhd'`).

Scope / idempotency
-------------------
- Targets `securities` with `is_tier1 AND status='active'` that have **no**
  valuation row (re-runs only fill genuinely-missing names).
- `date` is stamped with the run date (PK is (ticker, date)); `screen_facts()`
  reads the latest valuation row.

Usage:
    python backfill_tier1_valuation.py                 # all missing Tier 1
    python backfill_tier1_valuation.py --dry-run
    python backfill_tier1_valuation.py --limit 50
    python backfill_tier1_valuation.py --tickers NVDA AAPL
    python backfill_tier1_valuation.py --delay 0.5
"""

import argparse
import logging
import os
import statistics
import time
from datetime import date, timedelta

from db import SupabaseDB
from eodhd_updater import fetch_fundamentals_with_fallbacks
from price_sales_updater import get_market_cap, get_revenue_ttm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("backfill_tier1_val")

DEFAULT_DELAY = 1.0
BATCH_SIZE = 200
WEEKS = 52
TREND_WEEKS = 13  # trailing-quarter window for the P/S direction signal


def ps_trend_from_history(history: list, weeks: int = TREND_WEEKS) -> float | None:
    """Trailing-`weeks` % change of the P/S multiple from a `[[date, ps], …]`
    series (migration 058). Positive ⇒ the multiple is expanding (re-rating up),
    negative ⇒ compressing (de-rating). Returns None when the series is too
    short or the reference point is non-positive.

    Robust to ordering: the series is sorted by date, the latest point is
    compared against the point ~`weeks` entries earlier.
    """
    pts = [p for p in (history or []) if isinstance(p, (list, tuple)) and len(p) >= 2]
    if len(pts) < weeks + 1:
        return None
    pts = sorted(pts, key=lambda p: p[0])
    try:
        latest = float(pts[-1][1])
        prior = float(pts[-(weeks + 1)][1])
    except (TypeError, ValueError):
        return None
    if prior <= 0:
        return None
    return round((latest / prior - 1) * 100, 2)


def _weekly_points(rows: list[dict], db: SupabaseDB) -> list[tuple[str, float]]:
    """Resample ascending daily price rows to one (date, close) per ISO week.

    Prefers adj_close; the last trading day of each week wins (rows ascending).
    """
    by_week: dict[tuple[int, int], tuple[str, float]] = {}
    for r in rows:
        d = r.get("date")
        close = db.safe_float(r.get("adj_close")) or db.safe_float(r.get("close"))
        if not d or close is None or close <= 0:
            continue
        try:
            y, w, _ = date.fromisoformat(str(d)[:10]).isocalendar()
        except ValueError:
            continue
        by_week[(y, w)] = (str(d)[:10], close)  # ascending → last day of week wins
    return [by_week[k] for k in sorted(by_week)]


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Backfill Level 0 valuation (P/S) for Tier 1 names missing it",
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch + compute + log, but write nothing")
    ap.add_argument("--limit", type=int,
                    help="only process the first N missing tickers")
    ap.add_argument("--tickers", nargs="+",
                    help="explicit ticker list (still requires Tier 1 active)")
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
        have = db.get_valuation_tickers()
        targets = [s for s in tier1 if s["ticker"] not in have]
        missing = len(targets)

    targets.sort(key=lambda s: s["ticker"])
    if args.limit:
        targets = targets[:args.limit]

    logger.info("Tier 1 active=%d; %d to backfill%s",
                len(tier1), len(targets),
                f" (of {missing} missing)" if not args.tickers else "")

    run_date = date.today().isoformat()
    cutoff = (date.today() - timedelta(weeks=WEEKS)).isoformat()
    batch: list[dict] = []
    written = errors = no_data = 0

    for idx, s in enumerate(targets):
        ticker = s["ticker"]
        name = s.get("name") or ""
        # Level 0 is US-only — resolve straight to the .US suffix.
        try:
            raw = fetch_fundamentals_with_fallbacks(
                ticker, key, logger, exchange="US", company=name)
        except Exception as exc:  # noqa: BLE001 — log and keep going
            logger.error("fetch failed for %s: %s", ticker, exc)
            errors += 1
            raw = None

        if not raw:
            no_data += 1
        else:
            revenue_ttm = get_revenue_ttm(raw)
            market_cap = get_market_cap(raw)
            if not revenue_ttm or revenue_ttm <= 0 or not market_cap or market_cap <= 0:
                logger.info("%s: no usable mcap/revenue (mcap=%s rev=%s)",
                            ticker, market_cap, revenue_ttm)
                no_data += 1
            else:
                ps_now = round(market_cap / revenue_ttm, 2)
                pts = _weekly_points(db.get_prices_daily(ticker, since=cutoff), db)
                history: list[list] = []
                if pts:
                    latest_close = pts[-1][1]
                    if latest_close and latest_close > 0:
                        for d, close in pts[-WEEKS:]:
                            ps_val = round(ps_now * (close / latest_close), 2)
                            if ps_val > 0:
                                history.append([d, ps_val])
                if not history:
                    history = [[run_date, ps_now]]

                values = [h[1] for h in history]
                ps_high = round(max(values), 2)
                ps_low = round(min(values), 2)
                ps_med = round(statistics.median(values), 2)
                ps_ath = round(max(ps_high, ps_now), 2)
                pct_of_ath = round(ps_now / ps_ath, 2) if ps_ath > 0 else 0

                row = {
                    "ticker": ticker,
                    "date": run_date,
                    "ps": ps_now,
                    "ps_high_52w": ps_high,
                    "ps_low_52w": ps_low,
                    "ps_median_12m": ps_med,
                    "ps_ath": ps_ath,
                    "ps_pct_of_ath": pct_of_ath,
                    "ps_trend_pct": ps_trend_from_history(history),
                    "history_json": history,
                    "source": "eodhd",
                }
                batch.append(row)
                if args.dry_run:
                    logger.info("[DRY RUN] %s → ps=%.2f med=%.2f (%d wk pts)",
                                ticker, ps_now, ps_med, len(history))

        if not args.dry_run and len(batch) >= BATCH_SIZE:
            db.upsert_valuation_batch(batch)
            written += len(batch)
            batch = []

        if (idx + 1) % 100 == 0:
            logger.info("…%d/%d processed (written≈%d, no_data=%d, errors=%d)",
                        idx + 1, len(targets), written + len(batch),
                        no_data, errors)

        if idx < len(targets) - 1:
            time.sleep(args.delay)

    if not args.dry_run and batch:
        db.upsert_valuation_batch(batch)
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
        db.log_run("backfill_tier1_valuation", stats)


if __name__ == "__main__":
    main()
