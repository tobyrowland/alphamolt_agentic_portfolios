#!/usr/bin/env python3
"""
Shared TradingView screening logic.

Extracted from nightly_current_update.py so both nightly_screen.py and
score_ai_analysis.py can reuse the same screening pass without duplication.
"""

import math
import re

from tradingview_screener import Query, col

# TradingView screener fields
TV_SELECT_FIELDS = [
    "name", "exchange", "description", "country", "sector",
    "close", "market_cap_basic", "price_revenue_ttm",
    "total_revenue_ttm", "total_revenue_yoy_growth_ttm",
    "gross_profit_margin_fy", "after_tax_margin",
    "free_cash_flow_margin_ttm", "Perf.Y",
    "recommendation_mark",
    "net_income_ttm",
]

# Countries to exclude
EXCLUDED_COUNTRIES = {"China", "Hong Kong", "Taiwan"}

# Sectors to exclude
EXCLUDED_SECTORS = {
    "Real Estate", "REIT", "Real Estate Investment Trusts",
    "Non-Energy Minerals", "Finance", "Utilities",
}

# Markets to screen. TradingView's "america" market nominally covers
# NYSE/NASDAQ/AMEX but in practice also returns OTC pink-sheet ADRs and
# some primary foreign listings. We post-filter on `exchange ∈
# US_EXCHANGES` so only NYSE/NASDAQ/AMEX (incl. NYSEARCA/BATS/ARCA)
# names — and US-listed ADRs of foreign companies — survive. Non-US
# markets are excluded because PortfolioManager treats every
# companies.price as USD; until we add FX, agents can only safely trade
# US-listed names.
MARKETS = ["america"]

# US exchange codes accepted by the screener — same set as
# agent_strategies.US_EXCHANGES (kept inline rather than imported to
# keep tv_screen.py importable without the strategies module).
US_EXCHANGES = {"NYSE", "NASDAQ", "AMEX", "NYSEARCA", "BATS", "ARCA"}


def clean_ticker(raw_name: str) -> str:
    """Clean ticker from TradingView name field."""
    return re.sub(r"^\d(?=\D)", "", raw_name)


def safe_divide_100(val):
    """If value looks like a whole-number percentage (>1 or <-1), divide by 100."""
    if val is None:
        return None
    try:
        v = float(val)
    except (ValueError, TypeError):
        return None
    if abs(v) > 1.0:
        return v / 100.0
    return v


def _get_spy_perf_y(logger) -> float:
    """Fetch SPY's Perf.Y from TradingView."""
    try:
        _, df = (
            Query()
            .set_tickers("AMEX:SPY")
            .select("Perf.Y")
            .get_scanner_data()
        )
        if len(df) > 0:
            spy_val = df.iloc[0]["Perf.Y"]
            logger.info("SPY Perf.Y = %.4f", spy_val)
            return float(spy_val)
    except Exception as e:
        logger.warning("Failed to fetch SPY Perf.Y: %s — defaulting to 0", e)
    return 0.0


def _screen_markets(markets: list[str], spy_perf_y: float, logger) -> list[dict]:
    """Run TradingView screener for a set of markets and return equity dicts."""
    try:
        total_count, df = (
            Query()
            .set_markets(*markets)
            .select(*TV_SELECT_FIELDS)
            .where(
                col("market_cap_basic").between(500_000_000, 500_000_000_000),
                col("gross_profit_margin_fy") > 25,
                col("total_revenue_yoy_growth_ttm").between(0, 500),
                col("total_revenue_ttm") > 100_000_000,
                col("price_revenue_ttm") < 15,
                col("recommendation_mark") <= 2.5,
                col("sector").not_in(["Finance", "Utilities", "Non-Energy Minerals"]),
            )
            .limit(5000)
            .get_scanner_data()
        )
        logger.info("Screener returned %d results (total available: %d)", len(df), total_count)
    except Exception as e:
        logger.error("TradingView screener error: %s", e)
        return []

    unique_sectors = df["sector"].dropna().unique() if "sector" in df.columns else []
    logger.info("Unique sectors in results (%d): %s", len(unique_sectors), sorted(unique_sectors))

    equities = []
    dropped_exchange_count = 0
    for _, row in df.iterrows():
        raw_name = str(row.get("name", ""))
        ticker = clean_ticker(raw_name)
        if not ticker:
            continue

        country = str(row.get("country", ""))
        sector = str(row.get("sector", ""))
        exchange = str(row.get("exchange", "")).strip().upper()

        if country in EXCLUDED_COUNTRIES:
            continue
        if sector in EXCLUDED_SECTORS:
            continue
        if exchange not in US_EXCHANGES:
            dropped_exchange_count += 1
            continue

        company_name = str(row.get("description", ""))
        price = row.get("close")

        # Relative performance vs SPY
        perf_y = row.get("Perf.Y")
        if perf_y is not None:
            perf_52w_vs_spy = safe_divide_100(perf_y) - safe_divide_100(spy_perf_y)
        else:
            perf_52w_vs_spy = None

        # Rating: recommendation_mark score (1-5 scale)
        rec_mark = row.get("recommendation_mark")
        try:
            mark_f = float(rec_mark) if rec_mark is not None else None
            if mark_f is not None and math.isnan(mark_f):
                mark_f = None
        except (ValueError, TypeError):
            mark_f = None
        rating = f"{mark_f:.1f}" if mark_f is not None else ""

        equities.append({
            "ticker": ticker,
            "exchange": exchange,
            "company_name": company_name,
            "country": country,
            "sector": sector,
            "price": price,
            "perf_52w_vs_spy": perf_52w_vs_spy,
            "rating": rating,
        })

    if dropped_exchange_count:
        logger.info(
            "Dropped %d non-US-exchange rows (OTC pinks, foreign primaries)",
            dropped_exchange_count,
        )

    return equities


def run_tradingview_screen(logger) -> list[dict]:
    """Screen TradingView's US market and return list of equity dicts."""
    logger.info("=" * 60)
    logger.info("TradingView Screening (US only)")
    logger.info("=" * 60)

    spy_perf_y = _get_spy_perf_y(logger)

    equities = _screen_markets(MARKETS, spy_perf_y, logger)
    deduped: dict[str, dict] = {}
    for eq in equities:
        ticker = eq["ticker"]
        if ticker not in deduped:
            deduped[ticker] = eq

    logger.info("TradingView screening complete: %d unique equities", len(deduped))
    return list(deduped.values())


def fetch_market_data(tickers_with_exchange: list[tuple[str, str]], logger) -> dict[str, dict]:
    """
    Fetch price, rating, and 52-week performance for specific tickers from
    TradingView (no screening filters). Returns {TICKER: {price, rating,
    perf_52w_vs_spy}}.

    tickers_with_exchange: list of (ticker, exchange) tuples.
    """
    if not tickers_with_exchange:
        return {}

    spy_perf_y = _get_spy_perf_y(logger)

    # Build EXCHANGE:TICKER identifiers for TradingView
    tv_ids = []
    ticker_map = {}  # tv_id → clean ticker
    for ticker, exchange in tickers_with_exchange:
        tv_id = f"{exchange}:{ticker}" if exchange else ticker
        tv_ids.append(tv_id)
        ticker_map[tv_id] = ticker

    # TradingView limits queries — batch in chunks of 500
    BATCH_SIZE = 500
    results = {}

    for i in range(0, len(tv_ids), BATCH_SIZE):
        batch = tv_ids[i:i + BATCH_SIZE]
        try:
            _, df = (
                Query()
                .set_tickers(*batch)
                .select("name", "close", "Perf.Y", "recommendation_mark")
                .limit(len(batch))
                .get_scanner_data()
            )
            logger.info("TradingView market data batch %d: got %d/%d",
                        i // BATCH_SIZE + 1, len(df), len(batch))
        except Exception as e:
            logger.warning("TradingView market data batch failed: %s", e)
            continue

        for _, row in df.iterrows():
            raw_name = str(row.get("name", ""))
            ticker = clean_ticker(raw_name)
            if not ticker:
                continue

            price = row.get("close")
            perf_y = row.get("Perf.Y")
            if perf_y is not None:
                perf_52w_vs_spy = safe_divide_100(perf_y) - safe_divide_100(spy_perf_y)
            else:
                perf_52w_vs_spy = None

            rec_mark = row.get("recommendation_mark")
            try:
                mark_f = float(rec_mark) if rec_mark is not None else None
                if mark_f is not None and math.isnan(mark_f):
                    mark_f = None
            except (ValueError, TypeError):
                mark_f = None
            rating = f"{mark_f:.1f}" if mark_f is not None else ""

            results[ticker.upper()] = {
                "price": price,
                "perf_52w_vs_spy": perf_52w_vs_spy,
                "rating": rating,
            }

    logger.info("Fetched market data for %d/%d tickers",
                len(results), len(tickers_with_exchange))
    return results


def _clean_tv_value(v: object) -> str | None:
    """TradingView cell → clean string or None (drops nan/none/blank)."""
    if v is None:
        return None
    s = str(v).strip()
    return s if s and s.lower() not in ("nan", "none", "") else None


def _fetch_classification_batch(symbols: list[str], logger) -> dict[str, dict]:
    """Query TradingView's **america** market for the given bare symbols, matched by
    name. Returns {SYMBOL: {"sector": str|None, "industry": str|None}}.

    Using an `isin(name)` filter on the america market (rather than per-id
    `set_tickers`) matters: (a) it confines matches to US listings, so a same-symbol
    FOREIGN company can never be matched (the old foreign-exchange fallback was what
    corrupted ADR/miner sectors, e.g. ARIS → "Technology Services"); and (b) it finds
    ADRs (type 'dr', e.g. RIO / SMFG) that the default scanner — and per-id
    set_tickers — silently omit.
    """
    BATCH_SIZE = 400
    results: dict[str, dict] = {}
    for i in range(0, len(symbols), BATCH_SIZE):
        chunk = symbols[i:i + BATCH_SIZE]
        try:
            _, df = (
                Query()
                .set_markets("america")
                .select("name", "sector", "industry")
                .where(col("name").isin(chunk))
                .limit(len(chunk) * 2)  # headroom for the rare dual-listed symbol
                .get_scanner_data()
            )
            logger.info("TradingView classification batch: got %d for %d symbols",
                        len(df), len(chunk))
        except Exception as e:
            logger.warning("TradingView classification batch failed: %s", e)
            continue

        for _, row in df.iterrows():
            sym = str(row.get("name", "")).strip().upper()
            if not sym or sym in results:  # first US row wins on the rare collision
                continue
            sector = _clean_tv_value(row.get("sector"))
            industry = _clean_tv_value(row.get("industry"))
            if sector or industry:
                results[sym] = {"sector": sector, "industry": industry}
    return results


def fetch_classification_data(
    tickers_with_exchange: list[tuple[str, str]], logger
) -> dict[str, dict]:
    """Fetch {TICKER: {"sector", "industry"}} from TradingView's america market.

    The exchange in each pair is ignored — the america-market name filter resolves
    every US listing (including ADRs) without per-exchange guessing, and is immune
    to the foreign same-symbol collisions that corrupted the previous approach.
    """
    if not tickers_with_exchange:
        return {}
    symbols = sorted({t.upper() for t, _ in tickers_with_exchange if t})
    logger.info("Fetching classification for %d symbols (america market)...",
                len(symbols))
    results = _fetch_classification_batch(symbols, logger)
    logger.info("Fetched classification for %d/%d symbols", len(results), len(symbols))
    return results


def fetch_sector_data(tickers_with_exchange: list[tuple[str, str]], logger) -> dict[str, str]:
    """Back-compat shim: {TICKER: sector_string}. Used by nightly_screen.py
    (sector only). Derives from fetch_classification_data."""
    return {
        t: c["sector"]
        for t, c in fetch_classification_data(tickers_with_exchange, logger).items()
        if c.get("sector")
    }

