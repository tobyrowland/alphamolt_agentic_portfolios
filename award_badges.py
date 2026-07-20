#!/usr/bin/env python3
"""Badge awarding sweep — the DB-facing driver over ``badges.py``.

Two jobs share this script:

* **Nightly sweep** (default) — evaluates every phase-1, per-portfolio badge
  plus the cross-portfolio Dark Horse. Because each evaluator re-derives from
  the full history / trade tape, the sweep is inherently a backfill: the first
  run grants everything every portfolio has earned to date, and subsequent runs
  only add newly-earned badges. The unique (portfolio, badge, period) index
  makes it idempotent — re-running never double-grants.

* **Period champions** (``--periods``) — at period close, ranks eligible
  portfolios by alpha over each closed calendar month / quarter / year and
  grants the dated, permanent Champion + Podium badges. Periods that *ended
  before* ``--launch-date`` are skipped (the competition wasn't live), so
  champions are never retro-awarded.

Usage::

    python award_badges.py                 # nightly per-portfolio sweep
    python award_badges.py --periods       # also grant closed-period champions
    python award_badges.py --dry-run       # compute + log, write nothing
    python award_badges.py --launch-date 2026-07-01
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys
import time
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv

import badges
from badges import (
    PeriodStanding,
    PortfolioData,
    eval_dark_horse,
    evaluate_portfolio,
    period_bounds,
    rank_period,
)
from db import SupabaseDB

DEFAULT_LAUNCH_DATE = "2026-07-01"  # badges went live; no champions before this
DARK_HORSE_SAMPLE_DAYS = 7          # thin the rank series to weekly resolution


def setup_logging(today_str: str) -> logging.Logger:
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    logger = logging.getLogger("award_badges")
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    fh = logging.FileHandler(log_dir / f"award_badges_{today_str}.txt", encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)
    return logger


# --- parsing helpers --------------------------------------------------------


def _pdate(s) -> dt.date | None:
    """Parse a 'YYYY-MM-DD' (or ISO timestamp) into a date."""
    if s is None:
        return None
    if isinstance(s, dt.datetime):
        return s.date()
    if isinstance(s, dt.date):
        return s
    txt = str(s)
    try:
        return dt.date.fromisoformat(txt[:10])
    except ValueError:
        return None


def _is_rules_based(meta: dict | None) -> bool:
    if not meta:
        return False
    if (meta.get("strategy") or "") in badges.RULES_BASED_STRATEGIES:
        return True
    powered = (meta.get("powered_by") or "").lower()
    return "rules" in powered


# --- data assembly ----------------------------------------------------------


def build_portfolio_data(
    db: SupabaseDB,
    portfolios: list[dict],
    hist_by_pid: dict[str, list[dict]],
    trades_by_pid: dict[str, list[dict]],
    hb_by_pid: dict[str, list[dict]],
    spy_by_date: dict[dt.date, float],
    price_lookup,
) -> list[PortfolioData]:
    out: list[PortfolioData] = []
    for p in portfolios:
        pid = p["id"]
        out.append(
            PortfolioData(
                portfolio_id=pid,
                slug=p.get("slug"),
                created_at=_pdate(p.get("created_at")),
                is_public=bool(p.get("is_public")),
                history=hist_by_pid.get(pid, []),
                trades=trades_by_pid.get(pid, []),
                heartbeats=hb_by_pid.get(pid, []),
                spy_by_date=spy_by_date,
                price_lookup=price_lookup,
            )
        )
    return out


def make_price_lookup(db: SupabaseDB):
    """Lazy, cached ticker -> {date: adj_close} lookup off prices_daily."""
    cache: dict[str, dict[dt.date, float]] = {}

    def lookup(ticker: str) -> dict[dt.date, float]:
        if ticker not in cache:
            series: dict[dt.date, float] = {}
            for r in db.get_prices_daily(ticker):
                d = _pdate(r.get("date"))
                px = SupabaseDB.safe_float(r.get("adj_close"))
                if px is None:
                    px = SupabaseDB.safe_float(r.get("close"))
                if d is not None and px is not None and px > 0:
                    series[d] = px
            cache[ticker] = series
        return cache[ticker]

    return lookup


# --- Dark Horse -------------------------------------------------------------


def build_return_series(
    hist_by_pid: dict[str, list[dict]],
) -> dict[str, list[tuple[dt.date, float]]]:
    """portfolio_id -> weekly-sampled [(date, since-inception return)] ascending."""
    out: dict[str, list[tuple[dt.date, float]]] = {}
    for pid, rows in hist_by_pid.items():
        pts: list[tuple[dt.date, float]] = []
        base = None
        last_sampled: dt.date | None = None
        for r in rows:  # ascending
            d = _pdate(r.get("snapshot_date"))
            v = SupabaseDB.safe_float(r.get("total_value_usd"))
            if d is None or v is None or v <= 0:
                continue
            if base is None:
                base = v
            if base <= 0:
                continue
            if last_sampled is None or (d - last_sampled).days >= DARK_HORSE_SAMPLE_DAYS:
                pts.append((d, v / base - 1))
                last_sampled = d
        if len(pts) >= 2:
            out[pid] = pts
    return out


# --- period champions -------------------------------------------------------


def _median(vals: list[float]) -> float | None:
    s = sorted(v for v in vals if v is not None)
    n = len(s)
    if n == 0:
        return None
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


def _spy_on_or_before(sorted_spy: list[tuple[dt.date, float]], d: dt.date) -> float | None:
    lo, hi, ans = 0, len(sorted_spy) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if sorted_spy[mid][0] <= d:
            ans = sorted_spy[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1
    return ans


def iter_period_starts(kind: str, launch: dt.date, today: dt.date):
    """Yield the start date of every *closed* period of ``kind`` whose start is
    on/after ``launch`` (end < today)."""
    # Walk from the launch period forward.
    cur = launch
    seen: set[dt.date] = set()
    while cur <= today:
        start, end = period_bounds(kind, cur)
        if start >= launch and end < today and start not in seen:
            seen.add(start)
            yield start
        # advance to the day after this period's end
        cur = end + dt.timedelta(days=1)


def build_standing(
    pid: str,
    hist_rows: list[dict],
    start: dt.date,
    end: dt.date,
    sorted_spy: list[tuple[dt.date, float]],
    pmeta: dict,
) -> PeriodStanding | None:
    parsed = []
    for r in hist_rows:
        d = _pdate(r.get("snapshot_date"))
        if d is not None:
            parsed.append((d, r))
    parsed.sort(key=lambda x: x[0])

    in_period = [(d, r) for d, r in parsed if start <= d <= end]
    if len(in_period) < 2:
        return None
    before = [(d, r) for d, r in parsed if d < start]
    base_d, base_r = before[-1] if before else in_period[0]
    last_d, last_r = in_period[-1]

    base_v = SupabaseDB.safe_float(base_r.get("total_value_usd"))
    last_v = SupabaseDB.safe_float(last_r.get("total_value_usd"))
    if not base_v or base_v <= 0 or not last_v:
        return None
    port_ret = last_v / base_v - 1

    spy_base = _spy_on_or_before(sorted_spy, base_d)
    spy_last = _spy_on_or_before(sorted_spy, last_d)
    if not spy_base or spy_base <= 0 or not spy_last:
        return None
    alpha = port_ret - (spy_last / spy_base - 1)

    cash_fracs = []
    holds = []
    for _, r in in_period:
        tv = SupabaseDB.safe_float(r.get("total_value_usd"))
        cash = SupabaseDB.safe_float(r.get("cash_usd"))
        if tv and tv > 0 and cash is not None:
            cash_fracs.append(cash / tv)
        np = r.get("num_positions")
        if np is not None:
            holds.append(float(np))

    created = _pdate(pmeta.get("created_at"))
    existed_before = created is not None and created < start

    # NOTE: "public for the full period" is approximated by current is_public
    # (no per-day public-status history exists yet — same dependency that keeps
    # Public Autopsy in phase 2). The measurable guardrails below still apply.
    return PeriodStanding(
        portfolio_id=pid,
        alpha=alpha,
        existed_before_start=existed_before,
        public_all_period=bool(pmeta.get("is_public")),
        median_cash_frac=_median(cash_fracs),
        median_holdings=_median(holds),
    )


def compute_period_grants(
    portfolios_by_id: dict[str, dict],
    hist_by_pid: dict[str, list[dict]],
    sorted_spy: list[tuple[dt.date, float]],
    launch: dt.date,
    today: dt.date,
    logger: logging.Logger,
) -> list[tuple[str, badges.GrantSpec]]:
    grants: list[tuple[str, badges.GrantSpec]] = []
    for kind in ("month", "quarter", "year"):
        for start in iter_period_starts(kind, launch, today):
            _, end = period_bounds(kind, start)
            standings = []
            for pid, hist in hist_by_pid.items():
                pmeta = portfolios_by_id.get(pid)
                if not pmeta:
                    continue
                st = build_standing(pid, hist, start, end, sorted_spy, pmeta)
                if st is not None:
                    standings.append(st)
            period_grants = rank_period(kind, start, standings)
            if period_grants:
                logger.info(
                    "  %s %s: %d eligible -> %d grants",
                    kind, badges.period_id(kind, start),
                    sum(1 for s in standings if s.eligible()), len(period_grants),
                )
            grants.extend(period_grants)
    return grants


# --- main -------------------------------------------------------------------


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Compute and log, but write no grants.")
    parser.add_argument("--periods", action="store_true",
                        help="Also grant closed-period Champion / Podium badges.")
    parser.add_argument("--only-periods", action="store_true",
                        help="Skip the per-portfolio sweep; only run periods.")
    parser.add_argument("--launch-date", default=DEFAULT_LAUNCH_DATE,
                        help="No period champions for periods ending before this "
                             f"date (default {DEFAULT_LAUNCH_DATE}).")
    args = parser.parse_args()

    today = dt.date.today()
    logger = setup_logging(today.isoformat())
    logger.info(
        "=== award_badges started (dry_run=%s, periods=%s, only_periods=%s) ===",
        args.dry_run, args.periods or args.only_periods, args.only_periods,
    )
    started = time.time()
    db = SupabaseDB()

    # --- catalog + existing grants (idempotency diff) ---
    catalog = db.get_badges()
    slug_to_id = {b["slug"]: b["id"] for b in catalog}
    if not slug_to_id:
        logger.error("ABORT: badges catalog is empty — run migration 081 first.")
        return 1
    existing = {
        (g["portfolio_id"], g["badge_id"], g.get("period_id") or "")
        for g in db.get_all_badge_grants()
    }
    logger.info("Catalog: %d badges, %d existing grants", len(catalog), len(existing))

    # --- bulk reads (shared across all portfolios) ---
    portfolios = db.list_portfolios_for_badges()
    portfolios_by_id = {p["id"]: p for p in portfolios}
    agents_meta = db.get_agents_meta()
    spy_raw = db.get_benchmark_series(badges.SPY_TICKER)
    spy_by_date = {d: c for d, c in ((_pdate(k), v) for k, v in spy_raw.items()) if d}
    sorted_spy = sorted(spy_by_date.items())

    # Group history by portfolio.
    hist_by_pid: dict[str, list[dict]] = defaultdict(list)
    for r in db.get_all_portfolio_history():
        if r.get("portfolio_id") in portfolios_by_id:
            hist_by_pid[r["portfolio_id"]].append(r)

    # Group trades by portfolio, tagging rules-based / manual off agent metadata.
    trades_by_pid: dict[str, list[dict]] = defaultdict(list)
    for r in db.get_all_agent_trades():
        pid = r.get("portfolio_id")
        if pid not in portfolios_by_id:
            continue
        meta = agents_meta.get(r.get("agent_id"))
        trades_by_pid[pid].append({
            "ticker": r.get("ticker"),
            "side": r.get("side"),
            "quantity": r.get("quantity"),
            "price": r.get("price_usd"),
            "date": _pdate(r.get("executed_at")),
            "rules_based": _is_rules_based(meta),
            "manual": (meta or {}).get("handle") == "manual",
        })

    # Group heartbeats by portfolio (notes carries portfolio_id).
    hb_by_pid: dict[str, list[dict]] = defaultdict(list)
    for r in db.get_all_heartbeats():
        notes = r.get("notes") or {}
        pid = notes.get("portfolio_id") if isinstance(notes, dict) else None
        if pid in portfolios_by_id:
            hb_by_pid[pid].append({
                "date": _pdate(r.get("started_at")),
                "status": r.get("status"),
            })

    # --- per-portfolio history for the daily-history shape the evaluators want ---
    shaped_hist: dict[str, list[dict]] = {}
    for pid, rows in hist_by_pid.items():
        shaped = []
        for r in rows:
            d = _pdate(r.get("snapshot_date"))
            if d is None:
                continue
            shaped.append({
                "date": d,
                "total_value": SupabaseDB.safe_float(r.get("total_value_usd")),
                "cash": SupabaseDB.safe_float(r.get("cash_usd")),
                "holdings_value": SupabaseDB.safe_float(r.get("holdings_value_usd")),
                "num_positions": r.get("num_positions"),
            })
        shaped_hist[pid] = shaped

    price_lookup = make_price_lookup(db)

    desired: list[tuple[str, badges.GrantSpec]] = []

    # --- per-portfolio sweep ---
    if not args.only_periods:
        pdatas = build_portfolio_data(
            db, portfolios, shaped_hist, trades_by_pid, hb_by_pid,
            spy_by_date, price_lookup,
        )
        for pdata in pdatas:
            for spec in evaluate_portfolio(pdata):
                desired.append((pdata.portfolio_id, spec))

        # Dark Horse (cross-portfolio).
        for pid, spec in eval_dark_horse(build_return_series(hist_by_pid)).items():
            desired.append((pid, spec))
        logger.info("Per-portfolio sweep: %d badge specs", len(desired))

    # --- period champions ---
    if args.periods or args.only_periods:
        launch = _pdate(args.launch_date) or _pdate(DEFAULT_LAUNCH_DATE)
        logger.info("Period champions (launch >= %s):", launch.isoformat())
        desired.extend(compute_period_grants(
            portfolios_by_id, hist_by_pid, sorted_spy, launch, today, logger,
        ))

    # --- diff against existing, build rows ---
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    to_insert: list[dict] = []
    seen_keys: set[tuple] = set()
    for pid, spec in desired:
        badge_id = slug_to_id.get(spec.slug)
        if badge_id is None:
            logger.warning("Unknown badge slug %r — skipping", spec.slug)
            continue
        key = (pid, badge_id, spec.period_id or "")
        if key in existing or key in seen_keys:
            continue
        seen_keys.add(key)
        to_insert.append({
            "portfolio_id": pid,
            "badge_id": badge_id,
            "period_id": spec.period_id or "",
            "context": spec.context or {},
            "granted_at": now_iso,
        })

    logger.info("Newly-earned grants: %d", len(to_insert))
    for row in to_insert[:25]:
        slug = next((s for s, i in slug_to_id.items() if i == row["badge_id"]), "?")
        logger.info("  + %s -> %s %s", row["portfolio_id"][:8], slug,
                    row["period_id"] or "")

    if args.dry_run:
        logger.info("[dry-run] not writing %d grants", len(to_insert))
    elif to_insert:
        written = db.record_badge_grants(to_insert)
        logger.info("Wrote %d badge grants", written)

    duration = time.time() - started
    if not args.dry_run:
        db.log_run("award_badges", {
            "updated": len(to_insert),
            "skipped": len(existing),
            "errors": 0,
            "duration_secs": round(duration, 2),
            "details": {
                "portfolios": len(portfolios),
                "new_grants": len(to_insert),
                "ran_periods": bool(args.periods or args.only_periods),
            },
        })
    logger.info("=== done in %.1fs (%d new grants) ===", duration, len(to_insert))
    return 0


if __name__ == "__main__":
    sys.exit(main())
