"""
universe_sync.py — Level 0 membership / identity + affordability gate.

Weekly clock (spec §3). Two jobs, both strategy-neutral:

  1. Tier 0 (identity) — ingest the full US exchange symbol list into
     `securities`: every US-listed common stock, ADR and REIT (units,
     warrants, preferreds, SPACs excluded). New listings are added,
     names no longer in the list are soft-deleted (status='delisted',
     never hard-deleted — delisted names keep their history).

  2. The affordability gate (spec §6) — the ONLY gate Level 0 applies, and it
     carries no strategy. A security is promoted to Tier 1 when:
        * liquidity:  trailing-30d avg daily dollar volume >= $5M AND
                      last close >= $1   (conservative, tunable)
        * has data:   enough recent daily prices to evaluate it
        * listing:    active, US exchange, included security type
     The trailing-30d ADDV for the WHOLE universe is computed from ~30
     `eod-bulk-last-day` calls (one per trading day) rather than thousands
     of per-ticker history pulls.

No margins / growth / valuation / sector views here — those are lenses
downstream. This script only decides WHO is liquid enough to enrich; the
enrichment itself (prices_daily backfill, fundamentals, valuation) is owned
by the daily/per-filing jobs.

Usage:
    python universe_sync.py                 # full weekly sync
    python universe_sync.py --dry-run       # compute, write nothing
    python universe_sync.py --skip-gate     # identity refresh only
    python universe_sync.py --limit 200     # cap symbols (smoke test)
"""

import argparse
import logging
import time
from collections import defaultdict
from datetime import date, datetime, timedelta

from db import SupabaseDB
from eodhd import EODHDClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("universe_sync")

# --- affordability gate constants (conservative starting values, tunable) ---
GATE_MIN_DOLLAR_VOLUME = 5_000_000   # trailing-30d avg daily $ volume
GATE_MIN_PRICE = 1.0                 # last close
GATE_MIN_DAYS = 15                   # min trading days of price data to judge
ADDV_WINDOW = 30                     # trailing trading days for ADDV
BULK_LOOKBACK_DAYS = 50              # calendar-day cap when collecting 30 days

# --- security-type classification (spec §4 / §12) ---
# EODHD's symbol-list `Type` labels ETFs, funds, preferreds, notes, units etc.
# distinctly; common stock, most ADRs and most REITs all arrive as
# "Common Stock". We include only "Common Stock" then drop warrants / units /
# rights / SPACs by name, and tag ADR / REIT for downstream lenses.
INCLUDE_TYPES = {"common stock"}
# Name keywords that mark a non-common-equity instrument to exclude even when
# EODHD typed it "Common Stock".
EXCLUDE_NAME_KEYWORDS = (
    "WARRANT", "RIGHTS", " RIGHT ", "UNIT", "DEPOSITARY SHARE",
    "PREFERRED", "ACQUISITION CORP", "ACQUISITION CO ", "ACQUISITION CO.",
)
ADR_KEYWORDS = ("ADR", "ADS", "AMERICAN DEPOSITARY")
REIT_KEYWORDS = ("REIT",)

# --- US-exchange listing gate (Tier 1 = US-exchange-listed only) ---
# EODHD's "US" symbol list spans every US-market venue: the real exchanges
# (NYSE / NASDAQ / NYSE MKT (=AMEX) / NYSE ARCA / BATS) PLUS the OTC tiers
# (OTCQX / OTCQB / Pink / Grey / OTCBB / OTCMKTS). A name quoted only on an OTC
# tier is NOT an exchange listing, so we drop it — Tier 1 carries only
# exchange-listed US equities (which still includes NYSE/NASDAQ-listed ADRs of
# foreign companies, e.g. TSM / ING; it excludes pink-sheet ADRs like RYCEY /
# SCBFY). Matched as substrings so every OTC label variant is caught; no real
# exchange label contains any of these, so this can never drop a listed name.
OTC_EXCHANGE_MARKERS = ("OTC", "PINK", "GREY", "GRAY", "NMFQS", "EXPM")


def is_us_exchange_listed(exchange: str | None) -> bool:
    """False for OTC / pink-sheet / grey-market quotations, True otherwise.

    An empty/unknown exchange is treated as listed (fail-open) — EODHD reliably
    labels the OTC tiers, so the only effect of a missing value would be a rare
    false-keep, never a false-delist of a real exchange listing.
    """
    e = (exchange or "").strip().upper()
    if not e:
        return True
    return not any(marker in e for marker in OTC_EXCHANGE_MARKERS)



def classify_security(row: dict) -> tuple[str, str | None] | None:
    """Map one EODHD symbol-list row to (security_type, share_class), or None
    to drop it from Tier 0.

    Strategy-neutral: this is a security-*kind* filter (keep equities, drop
    derivatives/funds), never a quality/strategy filter.
    """
    sec_type = (row.get("Type") or "").strip().lower()
    if sec_type not in INCLUDE_TYPES:
        return None

    name = (row.get("Name") or "").upper()
    if any(kw in name for kw in EXCLUDE_NAME_KEYWORDS):
        return None

    code = (row.get("Code") or "").strip().upper()
    # Dual-class tickers use a hyphen (BRK-A / BRK-B); the part after the
    # hyphen is the share class. (Preferreds arrive as Type "Preferred Stock"
    # and are already excluded above, so a hyphen here means dual-class.)
    share_class = code.split("-")[-1] if "-" in code else None

    if any(kw in name for kw in ADR_KEYWORDS):
        kind = "ADR"
    elif any(kw in name for kw in REIT_KEYWORDS):
        kind = "REIT"
    else:
        kind = "Common Stock"
    return kind, share_class


def passes_gate(addv_30d: float | None, last_close: float | None,
                days: int) -> bool:
    """The strategy-neutral affordability gate (spec §6).

    Pure decision over a security's liquidity stats: enough trading days to
    judge it, price >= $1, and trailing-30d ADDV >= $5M. No margins / growth /
    valuation / sector views — those are lenses downstream.
    """
    return bool(
        days >= GATE_MIN_DAYS
        and last_close is not None and last_close >= GATE_MIN_PRICE
        and addv_30d is not None and addv_30d >= GATE_MIN_DOLLAR_VOLUME
    )


def ingest_tier0(db: SupabaseDB, client: EODHDClient, limit: int | None,
                 dry_run: bool) -> dict:
    """Ingest the US symbol list into `securities`; soft-delete delistings."""
    raw = client.exchange_symbol_list("US")
    logger.info("EODHD returned %d raw US symbols", len(raw))
    if limit:
        raw = raw[:limit]

    today = date.today().isoformat()
    seen: set[str] = set()
    rows: list[dict] = []
    dropped = 0
    dropped_otc = 0
    for r in raw:
        code = (r.get("Code") or "").strip().upper()
        if not code:
            continue
        classified = classify_security(r)
        if classified is None:
            dropped += 1
            continue
        # US-exchange-listed only: drop OTC / pink-sheet quotations. Done after
        # classify so `dropped` stays the type/name count and OTC is reported
        # separately. A previously-active OTC name absent from `seen` here is
        # then soft-delisted below, so it leaves Tier 1 on this run.
        if not is_us_exchange_listed(r.get("Exchange")):
            dropped_otc += 1
            continue
        kind, share_class = classified
        seen.add(code)
        rows.append({
            "ticker": code,
            "name": r.get("Name"),
            "exchange": r.get("Exchange"),
            "isin": r.get("Isin"),
            "country": r.get("Country") or "USA",
            "security_type": kind,
            "share_class": share_class,
            "status": "active",
            "last_seen": today,
        })

    # Soft-delete: anything previously active but absent from the fresh list.
    existing = db.get_all_securities(columns="ticker,status")
    existing_active = {s["ticker"] for s in existing if s.get("status") == "active"}
    delisted = sorted(existing_active - seen)
    delist_rows = [{"ticker": t, "status": "delisted", "is_tier1": False}
                   for t in delisted]

    logger.info(
        "Tier 0: %d kept, %d dropped (type/name), %d dropped (OTC/pink), "
        "%d newly delisted",
        len(rows), dropped, dropped_otc, len(delist_rows),
    )

    if not dry_run:
        for i in range(0, len(rows), 500):
            db.upsert_securities_batch(rows[i:i + 500])
        if delist_rows:
            db.upsert_securities_batch(delist_rows)

    return {"kept": len(rows), "dropped": dropped, "dropped_otc": dropped_otc,
            "delisted": len(delist_rows)}


def collect_addv(client: EODHDClient) -> dict[str, dict]:
    """Walk `eod-bulk-last-day` back over trading days, returning per-ticker
    {addv_30d, last_close, days} from up to ADDV_WINDOW trading days."""
    per_ticker_dv: dict[str, list[float]] = defaultdict(list)
    last_close: dict[str, float] = {}
    last_close_date: dict[str, str] = {}
    trading_days: set[str] = set()

    cursor = date.today() - timedelta(days=1)
    checked = 0
    while len(trading_days) < ADDV_WINDOW and checked < BULK_LOOKBACK_DAYS:
        checked += 1
        if cursor.weekday() >= 5:               # skip Sat/Sun
            cursor -= timedelta(days=1)
            continue
        day = cursor.isoformat()
        cursor -= timedelta(days=1)
        rows = client.bulk_last_day("US", date=day)
        if not rows:
            continue
        actual = rows[0].get("date", day)        # holiday → EODHD returns prior day
        if actual in trading_days:
            continue
        trading_days.add(actual)
        for r in rows:
            code = (r.get("code") or "").strip().upper()
            close = r.get("close")
            vol = r.get("volume")
            if not code or close is None or vol is None:
                continue
            try:
                dv = float(close) * float(vol)
            except (TypeError, ValueError):
                continue
            per_ticker_dv[code].append(dv)
            if actual >= last_close_date.get(code, ""):
                last_close_date[code] = actual
                last_close[code] = float(close)

    logger.info("Collected %d trading days of bulk EOD for ADDV", len(trading_days))
    out: dict[str, dict] = {}
    for code, dvs in per_ticker_dv.items():
        out[code] = {
            "addv_30d": sum(dvs) / len(dvs),
            "last_close": last_close.get(code),
            "days": len(dvs),
        }
    return out


def apply_gate(db: SupabaseDB, client: EODHDClient, dry_run: bool) -> dict:
    """Compute the affordability gate over active securities and set is_tier1."""
    addv = collect_addv(client)
    active = db.get_all_securities(columns="ticker,security_type,status", status="active")
    now = datetime.utcnow().isoformat()

    updates: list[dict] = []
    promoted = 0
    for s in active:
        t = s["ticker"]
        stats = addv.get(t)
        addv_30d = stats["addv_30d"] if stats else None
        last_close = stats["last_close"] if stats else None
        days = stats["days"] if stats else 0
        is_tier1 = passes_gate(addv_30d, last_close, days)
        if is_tier1:
            promoted += 1
        updates.append({
            "ticker": t,
            "addv_30d": addv_30d,
            "last_close": last_close,
            "is_tier1": is_tier1,
            "tier1_evaluated_at": now,
        })

    logger.info("Affordability gate: %d / %d active securities promoted to Tier 1",
                promoted, len(active))
    if not dry_run:
        for i in range(0, len(updates), 500):
            db.upsert_securities_batch(updates[i:i + 500])
    return {"evaluated": len(active), "tier1": promoted}


def main() -> None:
    ap = argparse.ArgumentParser(description="Level 0 universe sync + affordability gate")
    ap.add_argument("--dry-run", action="store_true", help="compute but write nothing")
    ap.add_argument("--skip-gate", action="store_true", help="identity refresh only")
    ap.add_argument("--limit", type=int, default=None, help="cap symbols (smoke test)")
    args = ap.parse_args()

    started = time.time()
    db = SupabaseDB()
    client = EODHDClient()

    tier0 = ingest_tier0(db, client, args.limit, args.dry_run)
    gate = {"evaluated": 0, "tier1": 0}
    if not args.skip_gate:
        gate = apply_gate(db, client, args.dry_run)

    stats = {
        "updated": tier0["kept"],
        "skipped": tier0["dropped"],
        "errors": 0,
        "duration_secs": round(time.time() - started, 1),
        "details": {**tier0, **gate, "dry_run": args.dry_run},
    }
    logger.info("Done: %s", stats["details"])
    if not args.dry_run:
        db.log_run("universe_sync", stats)


if __name__ == "__main__":
    main()
