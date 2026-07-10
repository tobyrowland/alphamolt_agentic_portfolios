#!/usr/bin/env python3
"""
EODHD Financial Data Updater.

Reads tickers from the companies table (Supabase), fetches fundamental financial
data from the EODHD API, calculates key metrics (including r40_score and
fundamentals_snapshot), and writes results back to the database.
"""

import argparse
import logging
import os
import statistics as _stats
import sys
import time
from datetime import date, datetime
from pathlib import Path

import requests
from dotenv import load_dotenv

from db import SupabaseDB
from exchanges import resolve_eodhd_exchange, EXCHANGE_FALLBACKS

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

EODHD_BASE_URL = "https://eodhd.com/api/fundamentals"
DELAY_BETWEEN_CALLS = 1  # seconds between EODHD API calls
BATCH_SIZE = 5
STALENESS_DAYS = 7  # re-fetch if data older than this

NULL_VALUE = "\u2014"  # em-dash — consistent placeholder for missing data

# Column name mapping: fetch_eodhd_data() keys -> DB column names
EODHD_TO_DB = {
    "rev_growth_ttm": "rev_growth_ttm_pct",
    "rev_growth_qoq": "rev_growth_qoq_pct",
    "rev_cagr": "rev_cagr_pct",
    "gross_margin": "gross_margin_pct",
    "operating_margin": "operating_margin_pct",
    "net_margin": "net_margin_pct",
    "net_margin_yoy": "net_margin_yoy_pct",
    "fcf_margin": "fcf_margin_pct",
    "eps_yoy": "eps_yoy_pct",
    "data": "data_updated_at",
}

# Metrics that can carry red/yellow/green flags from criteria evaluation
FLAGGABLE_METRICS = [
    "rev_growth_ttm", "rev_growth_qoq", "rev_cagr",
    "gross_margin", "operating_margin", "net_margin",
    "net_margin_yoy", "fcf_margin",
    "opex_pct_revenue", "sm_rd_pct_revenue",
    "rule_of_40", "eps_yoy",
    "rev_consistency_score",
]

# Default screening criteria (previously stored in a Criteria sheet)
DEFAULT_CRITERIA = [
    {"metric": "gross_margin", "operator": "<", "red": 30.0, "yellow": 45.0, "green": None},
    {"metric": "rev_growth_ttm", "operator": "<", "red": 0.0, "yellow": 15.0, "green": None},
    {"metric": "fcf_margin", "operator": "<", "red": -10.0, "yellow": 0.0, "green": None},
    {"metric": "net_margin", "operator": "<", "red": -30.0, "yellow": -10.0, "green": None},
    {"metric": "rule_of_40", "operator": "<", "red": 10.0, "yellow": 20.0, "green": None},
]

# Columns populated by EODHD (keys as returned by fetch_eodhd_data)
EODHD_COLUMNS = [
    "annual_revenue_5y", "quarterly_revenue",
    "rev_growth_ttm", "rev_growth_qoq", "rev_cagr", "rev_consistency_score",
    "gross_margin", "gm_trend",
    "operating_margin", "net_margin", "net_margin_yoy",
    "fcf_margin",
    "opex_pct_revenue", "sm_rd_pct_revenue",
    "rule_of_40", "qrtrs_to_profitability",
    "eps_only", "eps_yoy",
    "one_time_events",
    "r40_score", "fundamentals_snapshot", "data",
]


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def setup_logging() -> logging.Logger:
    today_str = date.today().isoformat()
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"eodhd_update_{today_str}.txt"

    logger = logging.getLogger("eodhd_updater")
    logger.setLevel(logging.INFO)

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s",
                            datefmt="%Y-%m-%d %H:%M:%S")

    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    return logger


# ---------------------------------------------------------------------------
# EODHD API helpers & business logic
# ---------------------------------------------------------------------------

def _has_financials(data: dict) -> bool:
    """Check whether an EODHD response contains usable financial data.

    Some tickers return 200 OK but have empty Financials / Earnings
    sections, which produces all-None metrics.  We consider the data
    usable if there is at least one yearly or quarterly income statement
    entry, or at least one earnings history entry.
    """
    financials = data.get("Financials") or {}
    income = financials.get("Income_Statement") or {}
    yearly = income.get("yearly") or {}
    quarterly = income.get("quarterly") or {}
    earnings = (data.get("Earnings") or {}).get("History") or {}
    return bool(yearly or quarterly or earnings)


def _try_fetch_one(ticker: str, exchange: str, api_key: str,
                   timeout: int = 30) -> tuple[dict | None, int]:
    """Attempt a single EODHD fundamentals fetch.

    Returns (json_data, http_status).  json_data is None on any failure
    or if the response lacks usable financial data.
    http_status is 0 for non-HTTP errors, -1 if fetched OK but empty.
    """
    symbol = f"{ticker}.{exchange}"
    url = f"{EODHD_BASE_URL}/{symbol}"
    params = {"api_token": api_key, "fmt": "json"}
    try:
        resp = requests.get(url, params=params, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        if not _has_financials(data):
            return None, -1  # 200 OK but no usable data
        return data, resp.status_code
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 0
        return None, status
    except Exception:
        return None, 0


def _search_eodhd(query: str, api_key: str, logger: logging.Logger,
                  original_ticker: str = "") -> tuple[str, str] | None:
    """Use the EODHD search API to find the best (ticker, exchange) for a query.

    *query* can be a ticker code or a company name.
    Returns (ticker_code, exchange_code) or None.
    """
    url = "https://eodhd.com/api/search/" + query
    params = {"api_token": api_key, "fmt": "json", "limit": 10}
    try:
        resp = requests.get(url, params=params, timeout=15)
        resp.raise_for_status()
        results = resp.json()
        if not results:
            return None
        # Prefer results whose Code matches the original ticker exactly
        check_code = original_ticker.upper() or query.upper()
        for r in results:
            if r.get("Code", "").upper() == check_code:
                ex = r.get("Exchange", "")
                if ex:
                    logger.info("Search API exact match %s → %s.%s",
                                query, r["Code"], ex)
                    return (r["Code"], ex)
        # Otherwise take the first result that has fundamentals-friendly
        # exchange (prefer US, then major exchanges)
        preferred = ["US", "LSE", "NSE", "BSE", "TSE", "XETRA", "TO",
                     "AS", "PA", "SW", "HK", "F", "MI", "MC"]
        for pref in preferred:
            for r in results:
                if r.get("Exchange", "") == pref:
                    logger.info("Search API preferred match %s → %s.%s",
                                query, r["Code"], r["Exchange"])
                    return (r["Code"], r["Exchange"])
        # Fall back to first result
        r = results[0]
        ex = r.get("Exchange", "")
        code = r.get("Code", "")
        if ex and code:
            logger.info("Search API best guess for %s → %s.%s", query, code, ex)
            return (code, ex)
    except Exception as exc:
        logger.debug("EODHD search failed for '%s': %s", query, exc)
    return None


def fetch_fundamentals_with_fallbacks(ticker: str, api_key: str, logger: logging.Logger,
                            exchange: str = "US",
                            company: str = "") -> dict | None:
    """Fetch full fundamental data from EODHD for a ticker.

    Tries the primary exchange first, then walks through
    EXCHANGE_FALLBACKS, and finally falls back to the EODHD search API
    (searching by both ticker code and company name).
    """
    primary = resolve_eodhd_exchange(exchange)
    logger.info("Fetching fundamentals for %s (exchange: %s → %s)", ticker, exchange, primary)

    # Retryable status codes: 404 (not found), 0 (network error),
    # -1 (200 OK but no usable financial data)
    RETRYABLE = (404, 0, -1)
    tried = {primary}

    # 1. Try primary exchange
    data, status = _try_fetch_one(ticker, primary, api_key)
    if data is not None:
        return data
    if status == -1:
        logger.info("  %s.%s returned data but no financials — trying fallbacks", ticker, primary)
    if status not in RETRYABLE:
        logger.warning("EODHD HTTP %d for %s.%s, not retrying", status, ticker, primary)
        return None

    # 2. Try fallback exchanges (same ticker code, different exchange)
    fallbacks = EXCHANGE_FALLBACKS.get(primary, [])
    for alt in fallbacks:
        if alt in tried:
            continue
        tried.add(alt)
        logger.info("  Trying fallback %s.%s", ticker, alt)
        time.sleep(0.3)
        data, status = _try_fetch_one(ticker, alt, api_key)
        if data is not None:
            logger.info("  Found %s on %s (fallback from %s)", ticker, alt, primary)
            return data
        if status not in RETRYABLE:
            logger.warning("EODHD HTTP %d for %s.%s, stopping fallback chain",
                           status, ticker, alt)
            return None

    # 3. Search API — try by ticker code first
    logger.info("  All fallbacks exhausted for %s, trying search API", ticker)
    result = _search_eodhd(ticker, api_key, logger, original_ticker=ticker)
    if result:
        search_ticker, search_exchange = result
        if search_exchange not in tried or search_ticker.upper() != ticker.upper():
            time.sleep(0.3)
            data, status = _try_fetch_one(search_ticker, search_exchange, api_key)
            if data is not None:
                logger.info("  Found %s.%s via search (ticker query)",
                            search_ticker, search_exchange)
                return data
            tried.add(search_exchange)

    # 3b. For OTC foreign tickers (ending in F or Y), strip suffix and
    #     search for the underlying ticker — e.g. ADYYF → ADYY → Adyen
    if primary == "US" and len(ticker) > 2 and ticker[-1] in ("F", "Y"):
        base_ticker = ticker[:-1]
        if base_ticker.upper() != ticker.upper():
            logger.info("  Trying OTC base ticker search: %s", base_ticker)
            time.sleep(0.3)
            result = _search_eodhd(base_ticker, api_key, logger, original_ticker=ticker)
            if result:
                search_ticker, search_exchange = result
                if search_exchange not in tried or search_ticker.upper() != ticker.upper():
                    time.sleep(0.3)
                    data, status = _try_fetch_one(search_ticker, search_exchange, api_key)
                    if data is not None:
                        logger.info("  Found %s.%s via OTC base ticker search",
                                    search_ticker, search_exchange)
                        return data
                    tried.add(search_exchange)

    # 4. Search API — try by company name (handles cases like
    #    TSE code 7974 → US ADR "NTDOY" for Nintendo,
    #    GETTEX 49G → ONON.US for On Holding)
    if company:
        # Use first few words to avoid overly specific queries
        search_name = " ".join(company.split()[:3])
        logger.info("  Searching by company name: '%s'", search_name)
        time.sleep(0.3)
        result = _search_eodhd(search_name, api_key, logger, original_ticker=ticker)
        if result:
            search_ticker, search_exchange = result
            if search_exchange not in tried or search_ticker.upper() != ticker.upper():
                time.sleep(0.3)
                data, status = _try_fetch_one(search_ticker, search_exchange, api_key)
                if data is not None:
                    logger.info("  Found %s.%s via company name search '%s'",
                                search_ticker, search_exchange, search_name)
                    return data

    logger.warning("Could not find fundamentals for %s on any exchange "
                   "(tried %s + search)", ticker, tried)
    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def safe_float(value) -> float | None:
    if value is None:
        return None
    try:
        v = float(value)
        return v if v == v else None
    except (ValueError, TypeError):
        return None


def fmt_revenue(value: float | None) -> str:
    if value is None:
        return ""
    v = abs(value)
    sign = "-" if value < 0 else ""
    if v >= 1e9:
        return f"{sign}${v / 1e9:.1f}B"
    if v >= 1e6:
        return f"{sign}${v / 1e6:.0f}M"
    if v >= 1e3:
        return f"{sign}${v / 1e3:.0f}K"
    return f"{sign}${v:.0f}"


def _sorted_entries(section: dict) -> list[tuple[str, dict]]:
    """Sort financial entries by date descending."""
    if not section:
        return []
    entries = [(k, v) for k, v in section.items() if isinstance(v, dict)]
    entries.sort(key=lambda x: x[0], reverse=True)
    return entries


# ---------------------------------------------------------------------------
# Turnaround facts — quarterly inflection + balance-sheet survivability
# (migration 074). Pure derivations of the statements already fetched, written
# to the Level 0 `fundamentals` row via FUND_FIELDS. The turnaround screener
# filters/weights on these; they carry no strategy themselves.
# ---------------------------------------------------------------------------

# "Two consecutive quarters of improvement" — the inflection gate's bar.
INFLECTION_STREAK_QTRS = 2
# Quarters of history the streaks look back over.
_INFLECTION_LOOKBACK = 8
# Interest coverage ceiling — a profitable business with zero interest expense
# has infinite coverage; stored as this sentinel so a ≥-filter still passes it.
INTEREST_COVERAGE_CAP = 999.0


def _q_gross_margin(entry: dict) -> float | None:
    """One quarter's gross margin %, with the same costOfRevenue fallback and
    ±100% plausibility guard the TTM computation uses."""
    gp = safe_float(entry.get("grossProfit"))
    rev = safe_float(entry.get("totalRevenue"))
    if gp is None and rev is not None:
        cor = safe_float(entry.get("costOfRevenue"))
        if cor is not None:
            gp = rev - cor
    if gp is None or not rev or rev <= 0:
        return None
    m = (gp / rev) * 100
    return m if -100 <= m <= 100 else None


def _improvement_streak(series: list[float | None]) -> int | None:
    """Consecutive improving steps from the newest value backwards.

    `series` is newest-first; a step counts when value[i] > value[i+1]. Returns
    None when the latest step can't even be assessed (fewer than 2 leading
    values) — distinguishing "no data" from a genuine 0 (not improving).
    """
    if len(series) < 2 or series[0] is None or series[1] is None:
        return None
    n = 0
    for cur, prev in zip(series, series[1:]):
        if cur is None or prev is None or cur <= prev:
            break
        n += 1
    return n


def compute_inflection(quarterly: list[tuple[str, dict]],
                       cf_quarterly: list[tuple[str, dict]]) -> dict:
    """Quarter-over-quarter inflection facts from the income + cash-flow series
    (newest-first, as produced by _sorted_entries).

    Three signals, each a latest-step delta (pp) plus a consecutive-improvement
    streak: gross margin expanding, QoQ revenue growth improving (works while
    still negative YoY), FCF margin trending toward breakeven.
    `inflection_signals` counts how many streaks clear INFLECTION_STREAK_QTRS.
    """
    # Gross margin per quarter.
    gm_series = [_q_gross_margin(e) for _, e in quarterly[:_INFLECTION_LOOKBACK]]

    # QoQ revenue growth per quarter: g[i] = rev[i] vs rev[i+1].
    revs = [safe_float(e.get("totalRevenue"))
            for _, e in quarterly[:_INFLECTION_LOOKBACK + 1]]
    qoq_series: list[float | None] = []
    for cur, prev in zip(revs, revs[1:]):
        if cur is None or not prev or prev <= 0:
            qoq_series.append(None)
        else:
            qoq_series.append((cur - prev) / prev * 100)

    # FCF margin per quarter — cash-flow quarters matched to income-statement
    # revenue by period date (the two statements can drift a period apart).
    rev_by_date = {d: safe_float(e.get("totalRevenue")) for d, e in quarterly}
    fcf_series: list[float | None] = []
    for d, e in cf_quarterly[:_INFLECTION_LOOKBACK]:
        fcf = safe_float(e.get("freeCashFlow"))
        rev = rev_by_date.get(d)
        if fcf is None or not rev or rev <= 0:
            fcf_series.append(None)
        else:
            fcf_series.append(fcf / rev * 100)

    def _delta(series: list[float | None]) -> float | None:
        if len(series) < 2 or series[0] is None or series[1] is None:
            return None
        return round(series[0] - series[1], 1)

    gm_streak = _improvement_streak(gm_series)
    rev_streak = _improvement_streak(qoq_series)
    fcf_streak = _improvement_streak(fcf_series)

    streaks = [gm_streak, rev_streak, fcf_streak]
    if all(s is None for s in streaks):
        signals = None
    else:
        signals = sum(1 for s in streaks
                      if s is not None and s >= INFLECTION_STREAK_QTRS)

    return {
        "gm_delta_qoq": _delta(gm_series),
        "gm_expansion_qtrs": gm_streak,
        "rev_qoq_accel": _delta(qoq_series),
        "rev_accel_qtrs": rev_streak,
        "fcf_delta_qoq": _delta(fcf_series),
        "fcf_improving_qtrs": fcf_streak,
        "inflection_signals": signals,
    }


# Quarters of history stored in fundamentals.quarterly_metrics (3 years). The
# screener's filter TRANSFORMS (streaks / deltas / slopes / own-history
# percentiles — screen.py + web/lib/screen/transforms.ts) compute over this
# series at read time, so any new time-series filter idea needs NO new column.
SERIES_LOOKBACK_QTRS = 12


def compute_quarterly_series(quarterly: list[tuple[str, dict]],
                             cf_quarterly: list[tuple[str, dict]]) -> dict | None:
    """Per-quarter metric series (newest-first, up to SERIES_LOOKBACK_QTRS) for
    fundamentals.quarterly_metrics — the raw material the screener's generic
    filter transforms compute over.

    Object-of-arrays keyed by metric, every array aligned to `period_ends`
    (missing quarter values stay None so positions never shift). Values are
    rounded to 2dp — both scorers read the same JSON, so parity is trivial.
    Returns None when there is no quarterly history at all.
    """
    qs = quarterly[:SERIES_LOOKBACK_QTRS]
    if not qs:
        return None

    def _margin(entry: dict, key: str) -> float | None:
        num = safe_float(entry.get(key))
        rev = safe_float(entry.get("totalRevenue"))
        if num is None or not rev or rev <= 0:
            return None
        return round(num / rev * 100, 2)

    period_ends = [d for d, _ in qs]
    revenue = [safe_float(e.get("totalRevenue")) for _, e in qs]

    # QoQ revenue growth per quarter: g[i] = rev[i] vs rev[i+1] (one extra
    # quarter fetched so the oldest stored quarter still gets a value).
    revs_ext = [safe_float(e.get("totalRevenue"))
                for _, e in quarterly[:SERIES_LOOKBACK_QTRS + 1]]
    rev_growth_qoq: list[float | None] = []
    for i in range(len(qs)):
        cur = revs_ext[i]
        prev = revs_ext[i + 1] if i + 1 < len(revs_ext) else None
        if cur is None or not prev or prev <= 0:
            rev_growth_qoq.append(None)
        else:
            rev_growth_qoq.append(round((cur - prev) / prev * 100, 2))

    # FCF margin matched to the income-statement quarter by period date (the
    # two statements can drift a period apart — same matching as
    # compute_inflection).
    fcf_by_date = {d: safe_float(e.get("freeCashFlow")) for d, e in cf_quarterly}
    fcf_margin: list[float | None] = []
    for d, e in qs:
        fcf = fcf_by_date.get(d)
        rev = safe_float(e.get("totalRevenue"))
        if fcf is None or not rev or rev <= 0:
            fcf_margin.append(None)
        else:
            fcf_margin.append(round(fcf / rev * 100, 2))

    return {
        "period_ends": period_ends,
        "revenue": revenue,
        "rev_growth_qoq": rev_growth_qoq,
        "gross_margin": [
            (None if (m := _q_gross_margin(e)) is None else round(m, 2))
            for _, e in qs
        ],
        "operating_margin": [_margin(e, "operatingIncome") for _, e in qs],
        "net_margin": [_margin(e, "netIncome") for _, e in qs],
        "fcf_margin": fcf_margin,
    }


def compute_survivability(raw: dict, quarterly: list[tuple[str, dict]]) -> dict:
    """Balance-sheet survivability facts: cash / debt / shares outstanding from
    the latest quarterly balance sheet, TTM EBITDA / EBIT / interest expense
    from the income statements, and the two hard-gate ratios."""
    financials = raw.get("Financials") or {}
    bs_q = _sorted_entries((financials.get("Balance_Sheet") or {}).get("quarterly") or {})
    latest_bs = bs_q[0][1] if bs_q else {}

    cash = safe_float(latest_bs.get("cashAndShortTermInvestments"))
    if cash is None:
        c = safe_float(latest_bs.get("cash"))
        sti = safe_float(latest_bs.get("shortTermInvestments"))
        if c is not None:
            cash = c + (sti or 0)

    debt = safe_float(latest_bs.get("shortLongTermDebtTotal"))
    if debt is None:
        st = safe_float(latest_bs.get("shortTermDebt"))
        lt = safe_float(latest_bs.get("longTermDebtTotal"))
        if lt is None:
            lt = safe_float(latest_bs.get("longTermDebt"))
        if st is not None or lt is not None:
            debt = (st or 0) + (lt or 0)

    net_debt = safe_float(latest_bs.get("netDebt"))
    if net_debt is None and debt is not None and cash is not None:
        net_debt = debt - cash

    shares_out = safe_float(latest_bs.get("commonStockSharesOutstanding"))
    if shares_out is None:
        shares_out = safe_float((raw.get("SharesStats") or {}).get("SharesOutstanding"))

    def _ttm(key: str) -> float | None:
        vals = [safe_float(e.get(key)) for _, e in quarterly[:4]]
        present = [v for v in vals if v is not None]
        # Require a full 4 quarters — a partial sum understates TTM and would
        # make the survivability ratios look artificially safe/unsafe.
        if len(quarterly) < 4 or len(present) < 4:
            return None
        return sum(present)

    ebitda_ttm = _ttm("ebitda")
    ebit_ttm = _ttm("operatingIncome")
    interest_vals = [safe_float(e.get("interestExpense")) for _, e in quarterly[:4]]
    interest_present = [abs(v) for v in interest_vals if v is not None]
    # Interest lines are frequently null for debt-free names; treat "4 quarters
    # of statements, no interest line" as zero interest rather than unknown.
    interest_ttm = sum(interest_present) if len(quarterly) >= 4 else None

    net_debt_ebitda = None
    if net_debt is not None and ebitda_ttm is not None and ebitda_ttm > 0:
        net_debt_ebitda = round(net_debt / ebitda_ttm, 2)

    interest_coverage = None
    if ebit_ttm is not None and interest_ttm is not None:
        if interest_ttm > 0:
            interest_coverage = round(
                min(ebit_ttm / interest_ttm, INTEREST_COVERAGE_CAP), 1)
        elif ebit_ttm > 0:
            # No interest expense and profitable — coverage is effectively
            # infinite; store the cap so a ≥-filter keeps these names.
            interest_coverage = INTEREST_COVERAGE_CAP

    return {
        "cash": cash,
        "debt": debt,
        "shares_out": shares_out,
        "ebitda_ttm": ebitda_ttm,
        "interest_expense_ttm": interest_ttm,
        "net_debt_ebitda": net_debt_ebitda,
        "interest_coverage": interest_coverage,
    }


# ---------------------------------------------------------------------------
# Screening criteria — read from "Criteria" sheet
# ---------------------------------------------------------------------------

# Dot characters for screening flags
DOT_RED = "\U0001f534"     # 🔴
DOT_YELLOW = "\U0001f7e1"  # 🟡
DOT_GREEN = "\U0001f7e2"   # 🟢

# Supported operators for criteria rules
_CRITERIA_OPS = {
    "<":  lambda val, thresh: val < thresh,
    "<=": lambda val, thresh: val <= thresh,
    ">":  lambda val, thresh: val > thresh,
    ">=": lambda val, thresh: val >= thresh,
}


def evaluate_criteria(value: float | None, metric: str,
                      criteria: list[dict]) -> str | None:
    """Evaluate a metric value against screening criteria.

    Returns DOT_RED, DOT_YELLOW, DOT_GREEN, or None (no matching rule).
    """
    if value is None:
        return None

    for rule in criteria:
        if rule["metric"] != metric:
            continue

        op = _CRITERIA_OPS[rule["operator"]]

        # Check thresholds in order: red (worst), yellow, green (best)
        if rule["red"] is not None and op(value, rule["red"]):
            return DOT_RED
        if rule["yellow"] is not None and op(value, rule["yellow"]):
            return DOT_YELLOW
        # If green threshold is defined and we pass it, show green dot
        if rule["green"] is not None and op(value, rule["green"]):
            return DOT_GREEN
        # Value exists and a rule was found but didn't trigger any threshold
        return DOT_GREEN

    return None  # no rule for this metric


# ---------------------------------------------------------------------------
# Core: fetch_eodhd_data — calculates all metrics for one ticker
# ---------------------------------------------------------------------------


def fetch_eodhd_data(ticker: str, api_key: str, logger: logging.Logger,
                     exchange: str = "US", company: str = "") -> dict | None:
    """Fetch EODHD fundamentals and compute all financial metrics.

    Returns a dict keyed by EODHD_COLUMNS column keys, or None on failure.
    """
    raw = fetch_fundamentals_with_fallbacks(ticker, api_key, logger, exchange=exchange,
                                  company=company)
    if raw is None:
        return None

    financials = raw.get("Financials", {})
    income_yearly = financials.get("Income_Statement", {}).get("yearly", {})
    income_quarterly = financials.get("Income_Statement", {}).get("quarterly", {})
    cashflow_quarterly = financials.get("Cash_Flow", {}).get("quarterly", {})
    earnings = raw.get("Earnings", {})

    yearly = _sorted_entries(income_yearly)
    quarterly = _sorted_entries(income_quarterly)
    cf_quarterly = _sorted_entries(cashflow_quarterly)
    eps_entries = _sorted_entries(earnings.get("History", {}))

    result = {}

    # ── Annual Revenue (5Y) ───────────────────────────────────────────
    annual_revs = []
    for date_str, entry in yearly[:5]:
        rev = safe_float(entry.get("totalRevenue"))
        if rev is not None:
            year = date_str[:4]
            annual_revs.append(f"{year}: {fmt_revenue(rev)}")
    result["annual_revenue_5y"] = " | ".join(annual_revs) if annual_revs else None

    # ── Quarterly Revenue (last 5 quarters) ────────────────────────────
    if quarterly:
        parts = []
        for entry in quarterly[:5]:
            rev = safe_float(entry[1].get("totalRevenue"))
            q_date = entry[0]
            if rev is not None:
                parts.append(f"{fmt_revenue(rev)} ({q_date})")
        result["quarterly_revenue"] = " | ".join(parts) if parts else None
    else:
        result["quarterly_revenue"] = None

    # ── Annual Net Income (5Y) ────────────────────────────────────────
    # Mirrors annual_revenue_5y from the same yearly income statements (EODHD
    # already in hand). fmt_revenue renders losses as "-$X" so net income can
    # go negative. Same string shape, so the web parser is reused.
    annual_ni = []
    for date_str, entry in yearly[:5]:
        ni = safe_float(entry.get("netIncome"))
        if ni is not None:
            year = date_str[:4]
            annual_ni.append(f"{year}: {fmt_revenue(ni)}")
    result["annual_net_income_5y"] = " | ".join(annual_ni) if annual_ni else None

    # ── Quarterly Net Income (last 5 quarters) ─────────────────────────
    if quarterly:
        ni_parts = []
        for entry in quarterly[:5]:
            ni = safe_float(entry[1].get("netIncome"))
            q_date = entry[0]
            if ni is not None:
                ni_parts.append(f"{fmt_revenue(ni)} ({q_date})")
        result["quarterly_net_income"] = " | ".join(ni_parts) if ni_parts else None
    else:
        result["quarterly_net_income"] = None

    # ── Rev Growth TTM % ──────────────────────────────────────────────
    rev_growth_ttm = None
    if len(quarterly) >= 8:
        recent_4 = sum(safe_float(e[1].get("totalRevenue")) or 0 for e in quarterly[:4])
        prior_4 = sum(safe_float(e[1].get("totalRevenue")) or 0 for e in quarterly[4:8])
        if prior_4 > 0:
            rev_growth_ttm = ((recent_4 - prior_4) / prior_4) * 100
    result["rev_growth_ttm"] = round(rev_growth_ttm, 1) if rev_growth_ttm is not None else None

    # ── Rev Growth QoQ % ──────────────────────────────────────────────
    if len(quarterly) >= 2:
        curr = safe_float(quarterly[0][1].get("totalRevenue"))
        prev = safe_float(quarterly[1][1].get("totalRevenue"))
        if curr is not None and prev and prev > 0:
            result["rev_growth_qoq"] = round(((curr - prev) / prev) * 100, 1)
        else:
            result["rev_growth_qoq"] = None
    else:
        result["rev_growth_qoq"] = None

    # ── Rev CAGR % ─────────────────────────────────────────────────
    if len(yearly) >= 4:
        recent_rev = safe_float(yearly[0][1].get("totalRevenue"))
        base_rev = safe_float(yearly[3][1].get("totalRevenue"))
        if recent_rev and base_rev and base_rev > 0 and recent_rev > 0:
            cagr = ((recent_rev / base_rev) ** (1 / 3) - 1) * 100
            result["rev_cagr"] = round(cagr, 1)
        else:
            result["rev_cagr"] = None
    else:
        result["rev_cagr"] = None

    # ── Rev Consistency Score (0–10) ──────────────────────────────────
    # Always scored out of 10 (need 11 quarters). Show as "X/10".
    if len(quarterly) >= 11:
        growth_count = 0
        for i in range(10):
            c = safe_float(quarterly[i][1].get("totalRevenue"))
            p = safe_float(quarterly[i + 1][1].get("totalRevenue"))
            if c is not None and p is not None and c > p:
                growth_count += 1
        result["rev_consistency_score"] = f"{growth_count}/10"
    elif len(quarterly) >= 2:
        # Fewer than 11 quarters — normalize to /10 scale
        n = len(quarterly) - 1
        growth_count = 0
        for i in range(n):
            c = safe_float(quarterly[i][1].get("totalRevenue"))
            p = safe_float(quarterly[i + 1][1].get("totalRevenue"))
            if c is not None and p is not None and c > p:
                growth_count += 1
        scaled = round(growth_count / n * 10)
        result["rev_consistency_score"] = f"{scaled}/10"
    else:
        result["rev_consistency_score"] = None

    # ── Gross Margin TTM % ────────────────────────────────────────────
    gross_margin_val = None
    if len(quarterly) >= 4:
        gp_sum = 0
        rev_sum = 0
        for e in quarterly[:4]:
            gp = safe_float(e[1].get("grossProfit"))
            rev = safe_float(e[1].get("totalRevenue"))
            # Fallback: derive grossProfit from totalRevenue - costOfRevenue
            if gp is None and rev is not None:
                cor = safe_float(e[1].get("costOfRevenue"))
                if cor is not None:
                    gp = rev - cor
            gp_sum += gp or 0
            rev_sum += rev or 0
        if rev_sum > 0 and gp_sum != 0:
            gross_margin_val = (gp_sum / rev_sum) * 100
    elif quarterly:
        gp = safe_float(quarterly[0][1].get("grossProfit"))
        rev = safe_float(quarterly[0][1].get("totalRevenue"))
        if gp is None and rev is not None:
            cor = safe_float(quarterly[0][1].get("costOfRevenue"))
            if cor is not None:
                gp = rev - cor
        if gp is not None and rev and rev > 0:
            gross_margin_val = (gp / rev) * 100
    # Reject impossible values (>100%, <-100%). EODHD occasionally
    # publishes a restated quarter where grossProfit briefly exceeds
    # revenue (one-time GAAP adjustments, currency translation, etc.).
    # Better to surface no value than a 106% GM that the UI would
    # render literally.
    if gross_margin_val is not None and (
        gross_margin_val > 100 or gross_margin_val < -100
    ):
        logging.getLogger().warning(
            "%s: discarding implausible gross_margin %.1f%% — "
            "likely a restated quarter where grossProfit > revenue.",
            ticker, gross_margin_val,
        )
        gross_margin_val = None
    result["gross_margin"] = round(gross_margin_val, 1) if gross_margin_val is not None else None

    # ── GM Trend (Qtly) ──────────────────────────────────────────────
    # Shows per-quarter gross margins (oldest→newest) plus the overall
    # pp change with a directional arrow, e.g. "45%→47%→49%→52% ↑7pp"
    gm_trend_val = None
    if len(quarterly) >= 4:
        margins = []
        for entry in quarterly[:4]:
            gp = safe_float(entry[1].get("grossProfit"))
            rev = safe_float(entry[1].get("totalRevenue"))
            # Fallback: derive grossProfit from totalRevenue - costOfRevenue
            if gp is None and rev is not None:
                cor = safe_float(entry[1].get("costOfRevenue"))
                if cor is not None:
                    gp = rev - cor
            if gp is not None and rev and rev > 0:
                m = (gp / rev) * 100
                # Skip impossible quarters (>100% / <-100%) — usually
                # a one-time restatement where grossProfit briefly
                # exceeds revenue. Rendering "106%" in the trend
                # string is misleading.
                if -100 <= m <= 100:
                    margins.append(m)
                else:
                    logging.getLogger().warning(
                        "%s: skipping implausible quarterly GM %.1f%% "
                        "in gm_trend (entry: %s).",
                        ticker, m, entry[0],
                    )
        if len(margins) >= 2:
            gm_trend_val = margins[0] - margins[-1]  # pp change newest vs oldest
            arrow = "↑" if gm_trend_val > 1 else ("↓" if gm_trend_val < -1 else "→")
            margin_strs = [f"{m:.0f}%" for m in reversed(margins)]
            pp = f"{abs(gm_trend_val):.0f}pp"
            result["gm_trend"] = f"{'→'.join(margin_strs)} {arrow}{pp}"
        else:
            result["gm_trend"] = None
    else:
        result["gm_trend"] = None

    # ── Operating Margin TTM % ────────────────────────────────────────
    if len(quarterly) >= 4:
        oi_sum = sum(safe_float(e[1].get("operatingIncome")) or 0 for e in quarterly[:4])
        rev_sum = sum(safe_float(e[1].get("totalRevenue")) or 0 for e in quarterly[:4])
        if rev_sum > 0:
            result["operating_margin"] = round((oi_sum / rev_sum) * 100, 1)
        else:
            result["operating_margin"] = None
    else:
        result["operating_margin"] = None

    # ── Net Margin TTM % ──────────────────────────────────────────────
    net_margin_val = None
    if len(quarterly) >= 4:
        ni_sum = sum(safe_float(e[1].get("netIncome")) or 0 for e in quarterly[:4])
        rev_sum = sum(safe_float(e[1].get("totalRevenue")) or 0 for e in quarterly[:4])
        if rev_sum > 0:
            net_margin_val = (ni_sum / rev_sum) * 100
    result["net_margin"] = round(net_margin_val, 1) if net_margin_val is not None else None

    # ── Net Margin YoY Δ ──────────────────────────────────────────────
    if len(quarterly) >= 5:
        def _nm(entry):
            ni = safe_float(entry.get("netIncome"))
            rev = safe_float(entry.get("totalRevenue"))
            if ni is not None and rev and rev > 0:
                return (ni / rev) * 100
            return None
        curr_nm = _nm(quarterly[0][1])
        yoy_nm = _nm(quarterly[4][1])
        if curr_nm is not None and yoy_nm is not None:
            result["net_margin_yoy"] = round(curr_nm - yoy_nm, 1)
        else:
            result["net_margin_yoy"] = None
    else:
        result["net_margin_yoy"] = None

    # ── FCF Margin TTM % ──────────────────────────────────────────────
    fcf_margin_val = None
    if len(cf_quarterly) >= 4 and len(quarterly) >= 4:
        fcf_sum = sum(safe_float(e[1].get("freeCashFlow")) or 0 for e in cf_quarterly[:4])
        rev_sum = sum(safe_float(e[1].get("totalRevenue")) or 0 for e in quarterly[:4])
        if rev_sum > 0:
            fcf_margin_val = (fcf_sum / rev_sum) * 100
    elif cf_quarterly and quarterly:
        fcf = safe_float(cf_quarterly[0][1].get("freeCashFlow"))
        rev = safe_float(quarterly[0][1].get("totalRevenue"))
        if fcf is not None and rev and rev > 0:
            fcf_margin_val = (fcf / rev) * 100
    result["fcf_margin"] = round(fcf_margin_val, 1) if fcf_margin_val is not None else None

    # ── Opex % of Revenue ─────────────────────────────────────────────
    if quarterly:
        opex = safe_float(quarterly[0][1].get("totalOperatingExpenses"))
        rev = safe_float(quarterly[0][1].get("totalRevenue"))
        if opex is not None and rev and rev > 0:
            result["opex_pct_revenue"] = round((opex / rev) * 100, 1)
        else:
            result["opex_pct_revenue"] = None
    else:
        result["opex_pct_revenue"] = None

    # ── S&M+R&D % of Revenue ─────────────────────────────────────────
    if quarterly:
        latest = quarterly[0][1]
        sm = safe_float(latest.get("sellingAndMarketingExpenses")) or 0
        sga = safe_float(latest.get("sellingGeneralAdministrative")) or 0
        rd = safe_float(latest.get("researchDevelopment")) or 0
        sm_total = sm if sm else sga
        combined = sm_total + rd
        rev = safe_float(latest.get("totalRevenue"))
        if combined > 0 and rev and rev > 0:
            result["sm_rd_pct_revenue"] = round((combined / rev) * 100, 1)
        else:
            result["sm_rd_pct_revenue"] = None
    else:
        result["sm_rd_pct_revenue"] = None

    # ── Rule of 40 ────────────────────────────────────────────────────
    r40 = None
    if rev_growth_ttm is not None and net_margin_val is not None:
        r40 = rev_growth_ttm + net_margin_val
    result["rule_of_40"] = round(r40, 1) if r40 is not None else None

    # ── Qtrs to Profitability ─────────────────────────────────────────
    # Uses TTM (4-quarter) net income to judge profitability, then
    # projects quarters to breakeven from the net-margin improvement
    # trend over the last 8 quarters.
    qtrs_to_prof = None
    if len(quarterly) >= 4:
        # Check TTM profitability (sum of last 4 quarters)
        ttm_ni = sum(safe_float(e[1].get("netIncome")) or 0 for e in quarterly[:4])
        ttm_rev = sum(safe_float(e[1].get("totalRevenue")) or 0 for e in quarterly[:4])

        if ttm_rev > 0 and ttm_ni >= 0:
            result["qrtrs_to_profitability"] = "Profitable"
            qtrs_to_prof = 0
        elif ttm_rev > 0:
            # Unprofitable — estimate quarters to breakeven
            ttm_margin = (ttm_ni / ttm_rev) * 100
            # Build per-quarter net margin series (newest first)
            margins = []
            for entry in quarterly[:8]:
                ni = safe_float(entry[1].get("netIncome"))
                rev = safe_float(entry[1].get("totalRevenue"))
                if ni is not None and rev and rev > 0:
                    margins.append((ni / rev) * 100)
            if len(margins) >= 4:
                # Average per-quarter improvement (positive = getting better)
                improvements = [margins[i] - margins[i + 1] for i in range(len(margins) - 1)]
                avg_improvement = sum(improvements) / len(improvements)
                if avg_improvement > 0.5:
                    # Project from current TTM margin to zero
                    qtrs_to_prof = max(1, int(-ttm_margin / avg_improvement) + 1)
                    if qtrs_to_prof > 20:
                        result["qrtrs_to_profitability"] = ">20"
                    else:
                        result["qrtrs_to_profitability"] = str(qtrs_to_prof)
                else:
                    result["qrtrs_to_profitability"] = "Not converging"
            else:
                result["qrtrs_to_profitability"] = None
        else:
            result["qrtrs_to_profitability"] = None
    elif quarterly:
        # Fewer than 4 quarters — check latest only
        latest_ni = safe_float(quarterly[0][1].get("netIncome"))
        if latest_ni is not None and latest_ni >= 0:
            result["qrtrs_to_profitability"] = "Profitable"
            qtrs_to_prof = 0
        else:
            result["qrtrs_to_profitability"] = None
    else:
        result["qrtrs_to_profitability"] = None

    # ── EPS Quarterly ─────────────────────────────────────────────────
    if eps_entries:
        eps_val = safe_float(eps_entries[0][1].get("epsActual"))
        result["eps_only"] = eps_val
    else:
        result["eps_only"] = None

    # ── EPS YoY % ─────────────────────────────────────────────────────
    if len(eps_entries) >= 5:
        curr_eps = safe_float(eps_entries[0][1].get("epsActual"))
        yoy_eps = safe_float(eps_entries[4][1].get("epsActual"))
        if curr_eps is not None and yoy_eps is not None and yoy_eps != 0:
            result["eps_yoy"] = round(((curr_eps - yoy_eps) / abs(yoy_eps)) * 100, 1)
        else:
            result["eps_yoy"] = None
    else:
        result["eps_yoy"] = None

    # ── One-Time Events Detection ──────────────────────────────────────
    # Compare recent 4 quarters against a baseline (Q-4 to Q-11) to detect
    # anomalous items.  Only flag when a metric is BOTH >2× the company's
    # own historical norm AND exceeds an absolute floor (15% of revenue or
    # 15pp margin deviation).  This avoids false positives on large caps
    # with structurally high investment income (GOOG, MSFT) and companies
    # with consistent margin trends (PLTR transitioning to profit).
    #
    # Direction: ⬆ = gain flatters results, ⬇ = charge depresses, ⬆⬇ = mixed.
    one_time_items = []  # list of (signed_pct, description)

    if len(quarterly) >= 5:
        # Build baseline from quarters 4–11 (prior 2 years)
        bl_oi_ni_gaps = []
        bl_toi_pcts = []
        bl_margins = []
        for _, entry in quarterly[4:12]:
            rev = safe_float(entry.get("totalRevenue"))
            oi = safe_float(entry.get("operatingIncome"))
            ni = safe_float(entry.get("netIncome"))
            toi = safe_float(entry.get("totalOtherIncomeExpenseNet"))
            if rev and rev > 0:
                if oi is not None and ni is not None:
                    bl_oi_ni_gaps.append(abs(ni - oi) / rev * 100)
                if toi is not None:
                    bl_toi_pcts.append(abs(toi) / rev * 100)
                if ni is not None:
                    bl_margins.append(ni / rev * 100)

        avg_gap = _stats.mean(bl_oi_ni_gaps) if bl_oi_ni_gaps else 0
        avg_toi = _stats.mean(bl_toi_pcts) if bl_toi_pcts else 0
        avg_margin = _stats.mean(bl_margins) if bl_margins else 0
        std_margin = (_stats.stdev(bl_margins)
                      if len(bl_margins) >= 2 else 0)

        # Detect consistent margin trend (all recent quarters deviate in
        # the same direction) — this is growth/decline, not one-time.
        margin_devs = []
        for q_date, entry in quarterly[:4]:
            rev = safe_float(entry.get("totalRevenue"))
            ni = safe_float(entry.get("netIncome"))
            if rev and rev > 0 and ni is not None:
                margin_devs.append(ni / rev * 100 - avg_margin)
        is_margin_trend = (len(margin_devs) >= 3
                           and (all(d > 0 for d in margin_devs)
                                or all(d < 0 for d in margin_devs)))

        for i, (q_date, entry) in enumerate(quarterly[:4]):
            rev = safe_float(entry.get("totalRevenue"))
            oi = safe_float(entry.get("operatingIncome"))
            ni = safe_float(entry.get("netIncome"))
            nr = safe_float(entry.get("nonRecurring"))
            ei = safe_float(entry.get("extraordinaryItems"))
            dc = safe_float(entry.get("discontinuedOperations"))
            toi = safe_float(entry.get("totalOtherIncomeExpenseNet"))
            if not rev or rev <= 0:
                continue
            q_label = q_date[:7]  # YYYY-MM

            # Explicit non-recurring items (>5% of revenue — always flag)
            if nr and abs(nr) / rev > 0.05:
                pct = nr / rev * 100
                sign = "+" if pct > 0 else ""
                one_time_items.append(
                    (pct, f"nonRecurring {sign}{pct:.0f}% of rev ({q_label})"))

            # Extraordinary items (>3% of revenue — always flag)
            if ei and abs(ei) / rev > 0.03:
                pct = ei / rev * 100
                sign = "+" if pct > 0 else ""
                one_time_items.append(
                    (pct, f"extraordinary {sign}{pct:.0f}% of rev ({q_label})"))

            # Discontinued operations (>3% of revenue — always flag)
            if dc and abs(dc) / rev > 0.03:
                pct = dc / rev * 100
                sign = "+" if pct > 0 else ""
                one_time_items.append(
                    (pct, f"discontinued ops {sign}{pct:.0f}% of rev ({q_label})"))

            # OI→NI gap: >2× baseline AND >15% absolute
            if oi is not None and ni is not None:
                gap_pct = (ni - oi) / rev * 100
                if abs(gap_pct) > 15 and (avg_gap == 0
                                           or abs(gap_pct) > avg_gap * 2):
                    sign = "+" if gap_pct > 0 else ""
                    one_time_items.append(
                        (gap_pct,
                         f"OI\u2192NI gap {sign}{gap_pct:.0f}% of rev ({q_label})"))

            # Other inc/exp: >2× baseline AND >15% absolute
            if toi:
                toi_pct = toi / rev * 100
                if (abs(toi_pct) > 15
                        and (avg_toi == 0 or abs(toi_pct) > avg_toi * 2)):
                    sign = "+" if toi_pct > 0 else ""
                    one_time_items.append(
                        (toi_pct,
                         f"other inc/exp {sign}{toi_pct:.0f}% of rev ({q_label})"))

            # Margin swing: >2× stdev AND >15pp — skip if consistent trend
            if ni is not None and std_margin > 0 and not is_margin_trend:
                margin = ni / rev * 100
                margin_dev = margin - avg_margin
                if abs(margin_dev) > max(std_margin * 2, 15):
                    sign = "+" if margin_dev > 0 else ""
                    one_time_items.append(
                        (margin_dev,
                         f"margin swing {sign}{margin_dev:.0f}pp vs norm ({q_label})"))

    if one_time_items:
        has_gain = any(v > 0 for v, _ in one_time_items)
        has_charge = any(v < 0 for v, _ in one_time_items)
        if has_gain and has_charge:
            arrow = "\u2b06\u2b07"  # ⬆⬇
        elif has_gain:
            arrow = "\u2b06"        # ⬆
        else:
            arrow = "\u2b07"        # ⬇
        details = " | ".join(desc for _, desc in one_time_items)
        result["one_time_events"] = f"{arrow} {details}"
    else:
        result["one_time_events"] = None

    # ── R40 Score ─────────────────────────────────────────────────────
    # Format: 💎💎 R40: 54 | FCF +27% | ⏳ ~12 qtrs GAAP
    #
    # Gem scale calibrated to screened universe (GM>45%, RevGr>20%):
    #   no gems  = R40 < 20  (weakest in this universe)
    #   💎       = R40 20–39
    #   💎💎     = R40 40–59
    #   💎💎💎   = R40 60+
    r40 = result.get("rule_of_40")
    if r40 is not None:
        if r40 >= 60:
            gem_str = "\U0001f48e\U0001f48e\U0001f48e"   # 💎💎💎
        elif r40 >= 40:
            gem_str = "\U0001f48e\U0001f48e"              # 💎💎
        elif r40 >= 20:
            gem_str = "\U0001f48e"                        # 💎
        else:
            gem_str = ""                                  # no gems

        # FCF segment
        fcf = result.get("fcf_margin")
        fcf_str = f"FCF {'+' if fcf >= 0 else ''}{fcf:.0f}%" if fcf is not None else None

        # Profitability status segment
        nm = result.get("net_margin")
        qtrs = qtrs_to_prof
        if nm is not None and nm >= 0:
            profit_str = "\u2705"                          # ✅
        elif qtrs is not None:
            profit_str = f"\u23f3 ~{qtrs:.0f} qtrs GAAP"  # ⏳
        else:
            profit_str = "\u2753 path unclear"             # ❓

        r40_parts = [f"{gem_str} R40: {r40:.0f}".strip()]
        if fcf_str:
            r40_parts.append(fcf_str)
        r40_parts.append(profit_str)
        result["r40_score"] = " | ".join(r40_parts)

    # ── Fundamentals Snapshot ─────────────────────────────────────────
    # Format: Rev +27% YoY | 3Y CAGR +44% | GM 88% ↑ | Net -5% ⚡ FCF +27% | ⏳ ~12 qtrs GAAP
    #
    # Rules:
    # - All % values show explicit + or - sign
    # - GM trend arrow: ↑ if gm_trend_val > 1pp, ↓ if < -1pp, → otherwise
    # - ⚡ appears between Net and FCF only when FCF exceeds Net margin by >15pp
    #   (signals: "accounting loss but cash-generative")
    # - Profitability segment reuses same logic as r40_score above
    snapshot_parts = []

    # Rev YoY
    if rev_growth_ttm is not None:
        sign = "+" if rev_growth_ttm >= 0 else ""
        snapshot_parts.append(f"Rev {sign}{rev_growth_ttm:.0f}% YoY")

    # 3Y CAGR
    cagr = result.get("rev_cagr")
    if cagr is not None:
        sign = "+" if cagr >= 0 else ""
        snapshot_parts.append(f"3Y CAGR {sign}{cagr:.0f}%")

    # GM + trend arrow
    gm = result.get("gross_margin")
    gm_trend = gm_trend_val  # raw pp change
    if gm is not None:
        if gm_trend is not None:
            if gm_trend > 1:
                arrow = " \u2191"    # ↑
            elif gm_trend < -1:
                arrow = " \u2193"    # ↓
            else:
                arrow = " \u2192"    # →
        else:
            arrow = ""
        snapshot_parts.append(f"GM {gm:.0f}%{arrow}")

    # Net margin + optional ⚡ + FCF margin
    nm = result.get("net_margin")
    fcf = result.get("fcf_margin")
    if nm is not None and fcf is not None:
        nm_sign = "+" if nm >= 0 else ""
        fcf_sign = "+" if fcf >= 0 else ""
        gap = fcf - nm
        if gap > 15:
            # FCF materially better than net margin — flag it
            snapshot_parts.append(
                f"Net {nm_sign}{nm:.0f}% \u26a1 FCF {fcf_sign}{fcf:.0f}%"  # ⚡
            )
        else:
            snapshot_parts.append(f"Net {nm_sign}{nm:.0f}% | FCF {fcf_sign}{fcf:.0f}%")
    elif nm is not None:
        nm_sign = "+" if nm >= 0 else ""
        snapshot_parts.append(f"Net {nm_sign}{nm:.0f}%")
    elif fcf is not None:
        fcf_sign = "+" if fcf >= 0 else ""
        snapshot_parts.append(f"FCF {fcf_sign}{fcf:.0f}%")

    # Profitability status (same logic as r40_score)
    if nm is not None and nm >= 0:
        snapshot_parts.append("\u2705")                           # ✅
    elif qtrs_to_prof is not None:
        snapshot_parts.append(f"\u23f3 ~{qtrs_to_prof:.0f} qtrs GAAP")  # ⏳
    else:
        snapshot_parts.append("\u2753 path unclear")              # ❓

    if snapshot_parts:
        result["fundamentals_snapshot"] = " | ".join(snapshot_parts)

    # ── Turnaround facts (migration 074) ──────────────────────────────
    # Quarterly inflection + balance-sheet survivability, from the same
    # statements already in hand. These keys are NOT in EODHD_COLUMNS (the
    # legacy companies table has no such columns) — only the Level 0
    # fundamentals writers pick them up via FUND_FIELDS.
    result.update(compute_inflection(quarterly, cf_quarterly))
    result.update(compute_survivability(raw, quarterly))
    # Full per-quarter series (migration 075) — the screener's generic filter
    # transforms (streak / delta / slope / own-percentile) compute over this.
    result["quarterly_metrics"] = compute_quarterly_series(quarterly, cf_quarterly)

    result["data"] = datetime.now().strftime("%Y-%m-%d")

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    load_dotenv()

    parser = argparse.ArgumentParser(description="EODHD Financial Data Updater")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch and calculate but don't write to DB")
    parser.add_argument("--ticker", type=str, default=None,
                        help="Process only this ticker (for testing)")
    parser.add_argument("--force", action="store_true",
                        help="Update all tickers even if data is recent")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most N tickers (useful with --dry-run)")
    args = parser.parse_args()

    logger = setup_logging()
    logger.info("=== EODHD Updater started (dry_run=%s) ===", args.dry_run)
    start_time = time.time()

    # Validate EODHD key
    eodhd_key = os.environ.get("EODHD_API_KEY")
    if not eodhd_key:
        logger.error("EODHD_API_KEY env var is not set")
        sys.exit(1)

    db = SupabaseDB()

    # Load screening criteria
    criteria = DEFAULT_CRITERIA

    # Get tickers to process
    if args.force:
        all_companies = db.get_all_companies()
    else:
        all_companies = db.get_stale_companies("data_updated_at", STALENESS_DAYS)

    logger.info("Found %d companies to consider", len(all_companies))

    # Filter by --ticker if specified
    if args.ticker:
        all_companies = [c for c in all_companies
                         if c["ticker"].upper() == args.ticker.upper()]

    # Apply --limit
    if args.limit:
        all_companies = all_companies[:args.limit]

    logger.info("Will process %d tickers", len(all_companies))

    if not all_companies:
        logger.info("Nothing to do.")
        return

    # Process each ticker
    total_written = 0
    errors = 0

    for idx, company in enumerate(all_companies):
        ticker = company["ticker"]
        exchange = company.get("exchange", "") or "US"
        company_name = company.get("company_name", "")

        try:
            eodhd_data = fetch_eodhd_data(ticker, eodhd_key, logger,
                                          exchange=exchange, company=company_name)
            if eodhd_data is None:
                errors += 1
                continue

            if args.dry_run:
                logger.info("[DRY RUN] %s.%s (%s):", ticker, exchange, company_name)
                for key in EODHD_COLUMNS:
                    val = eodhd_data.get(key)
                    if val is not None:
                        logger.info("  %-25s %s", key, val)
                continue

            # Map EODHD keys to DB column names and build update dict
            update = {}
            flags = {}
            for key in EODHD_COLUMNS:
                val = eodhd_data.get(key)
                db_col = EODHD_TO_DB.get(key, key)

                if val is None:
                    update[db_col] = None
                else:
                    update[db_col] = val

                # Evaluate criteria for flaggable metrics
                if key in FLAGGABLE_METRICS and val is not None:
                    numeric_val = val
                    if isinstance(val, str):
                        # For string values like "8/10", extract numeric part
                        try:
                            numeric_val = float(val.split("/")[0]) if "/" in val else float(val)
                        except (ValueError, TypeError):
                            numeric_val = None
                    if numeric_val is not None:
                        dot = evaluate_criteria(numeric_val, key, criteria)
                        if dot == DOT_RED:
                            flags[db_col] = "red"
                        elif dot == DOT_YELLOW:
                            flags[db_col] = "yellow"

            update["flags"] = flags

            db.upsert_company(ticker, update)
            total_written += 1
            logger.info("Updated %d metrics for %s", len(update), ticker)

        except Exception as exc:
            logger.error("Error processing %s: %s", ticker, exc, exc_info=True)
            errors += 1

        # Delay between API calls
        if idx < len(all_companies) - 1:
            time.sleep(DELAY_BETWEEN_CALLS)

    elapsed = time.time() - start_time
    if args.dry_run:
        logger.info("=== DRY RUN complete. %d tickers processed in %.1fs ===",
                     len(all_companies), elapsed)
    else:
        logger.info(
            "=== Updated %d tickers. Skipped %d due to errors. (%.1fs) ===",
            total_written, errors, elapsed,
        )


if __name__ == "__main__":
    main()
