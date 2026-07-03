"""
ma_sniper.py — the "200-week average sniper" conviction engine.

A version of Charlie Munger's patience discipline: wait, fully prepared, for a
*quality* business to trade down to its long-run trend, then strike. Here the
long-run trend is the **200-week moving average** (~3.85 years of weekly
closes) and "quality" is already supplied upstream — the candidate set is the
top N of the portfolio's screen (quality-weighted; see screen.py), so this
module only has to answer one question per candidate: *is it on sale relative
to its own 200-week average right now?*

It is a **conviction provider**, not a rebalance strategy. The portfolio swarm
(agent_heartbeat._run_portfolio_swarm) drafts names by per-buyer conviction;
a normal buyer's conviction is the deterministic screen-rank baseline
(swarm.rank_to_conviction). A sniper replaces that baseline: it expresses
conviction ONLY for names trading at/below their 200-week MA (within a small
band), and stays silent — passes its draft turn, accumulating cash — for
everything else. Most heartbeats it buys nothing; it strikes only on the dip.

The core (weekly resampling, the MA, the price→conviction mapping) is pure and
unit-tested in tests/test_ma_sniper.py — no DB, no LLM. `sniper_convictions` is the
thin DB-facing wrapper the heartbeat calls.
"""

from __future__ import annotations

import logging
from datetime import date as _date
from typing import Any

logger = logging.getLogger("ma_sniper")

# A 200-week MA needs 200 weekly closes (~3.85y). We allow a name to be sniped
# with somewhat less than a full window so a name with ~3y of history still
# gets a (slightly shorter) trend rather than being silently un-tradeable —
# but below MIN_WEEKS there isn't enough of a long-run trend to call it one.
WINDOW_WEEKS = 200
MIN_WEEKS = 150

# Default proximity band: a name counts as "at its 200-week average" when its
# price is no more than this fraction above the MA. Above the band → the sniper
# waits (no conviction). Tunable per instance via the agent's `band_pct` param.
DEFAULT_BAND = 0.05


# ---------------------------------------------------------------------------
# Pure core
# ---------------------------------------------------------------------------


def _adj(row: dict) -> float | None:
    """Preferred close for a prices_daily row: adj_close, falling back to close."""
    for key in ("adj_close", "close"):
        v = row.get(key)
        if v is None:
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f == f and f > 0:  # finite, positive
            return f
    return None


def weekly_closes(prices: list[dict]) -> list[float]:
    """Resample ascending daily prices_daily rows to one close per ISO week.

    Takes the LAST available close within each ISO (year, week) bucket — the
    week's settling price — preserving chronological order. Rows must be sorted
    ascending by date (``db.get_prices_daily`` returns them that way). Rows with
    no usable close or unparseable date are skipped.
    """
    by_week: dict[tuple[int, int], float] = {}
    order: list[tuple[int, int]] = []
    for row in prices:
        d = row.get("date")
        close = _adj(row)
        if not d or close is None:
            continue
        try:
            y, w, _ = _date.fromisoformat(str(d)[:10]).isocalendar()
        except ValueError:
            continue
        key = (y, w)
        if key not in by_week:
            order.append(key)
        by_week[key] = close  # last write wins → the week's final close
    return [by_week[k] for k in order]


def two_hundred_week_ma(
    prices: list[dict],
    *,
    window: int = WINDOW_WEEKS,
    min_weeks: int = MIN_WEEKS,
) -> float | None:
    """The mean of the last ``window`` weekly closes, or None if too short.

    Returns None when fewer than ``min_weeks`` weekly closes are available — a
    name without a long-run trend can't be sniped against one.
    """
    closes = weekly_closes(prices)
    if len(closes) < min_weeks:
        return None
    tail = closes[-window:]
    return sum(tail) / len(tail)


def sniper_conviction(price: float, ma: float, band: float = DEFAULT_BAND) -> int:
    """Map a price's discount-to-200wMA to a 0..5 conviction.

    0  → above the band: the sniper waits (won't draft this name).
    1  → within the band but above the MA (a marginal pitch).
    3  → at or below the MA (on trend / on sale).
    4  → ~5%+ below the MA.
    5  → ~10%+ below the MA (a deep, fat-pitch discount).

    Graduated so the swarm's snake draft strikes the deepest discount first.
    """
    if ma <= 0 or price <= 0:
        return 0
    if price > ma * (1.0 + band):
        return 0
    if price <= ma * 0.90:
        return 5
    if price <= ma * 0.95:
        return 4
    if price <= ma:
        return 3
    if price <= ma * (1.0 + band / 2.0):
        return 2
    return 1


# ---------------------------------------------------------------------------
# DB-facing wrapper
# ---------------------------------------------------------------------------


def sniper_convictions(
    db: Any,
    candidates: list[str],
    current_prices: dict[str, float],
    *,
    band: float = DEFAULT_BAND,
    details: dict[str, dict] | None = None,
) -> dict[str, int]:
    """Per-candidate sniper conviction for the swarm's convictions map.

    For each candidate with a current price, computes its 200-week MA from
    ``prices_daily`` and maps the price's proximity to it onto a 0..5
    conviction (see ``sniper_conviction``). Names above the band — or without
    enough history for a 200-week MA — are simply absent from the result, so
    the swarm never drafts them (the sniper waits).

    ``details`` (optional) is populated with ``{ticker: {ma, price, discount_pct,
    conviction}}`` for the names that cleared, so the heartbeat can journal /
    note *why* each strike fired.
    """
    out: dict[str, int] = {}
    for ticker in candidates:
        price = current_prices.get(ticker)
        if not price or price <= 0:
            continue
        try:
            rows = db.get_prices_daily(ticker)
        except Exception as exc:  # noqa: BLE001 — a bad read just skips the name
            logger.warning("ma_sniper: price read failed for %s: %s", ticker, exc)
            continue
        ma = two_hundred_week_ma(rows)
        if ma is None:
            continue
        conv = sniper_conviction(price, ma, band)
        if conv <= 0:
            continue
        out[ticker] = conv
        if details is not None:
            details[ticker] = {
                "ma_200w": round(ma, 4),
                "price": round(price, 4),
                "discount_pct": round((price / ma - 1.0) * 100, 1),
                "conviction": conv,
            }
    return out
