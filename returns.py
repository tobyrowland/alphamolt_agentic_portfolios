"""Time-weighted return — the only return that survives a deposit.

``agent_portfolio_history.pnl_pct`` has always been
``(value − starting_cash) / starting_cash``. On a paper book funded once at
creation that is exactly right and this module changes nothing. On a live
sleeve, which is funded in tranches, it is wrong in a way that has no fix
inside the formula: it compares today's value against every dollar ever
contributed, as though the last tranche had been invested since inception.

The Scrappy Fightback live sleeve on 2026-09-02 is the worked example. It
reported **+0.80%** against the paper book's **+6.28%** — a gap that read as
catastrophic execution and was almost entirely arithmetic:

* different windows (the paper book earned +2.46% before the sleeve existed),
* and $29,600 of the sleeve's $39,600 baseline arrived on 26-27 August, six
  days before the measurement.

Chaining daily returns with the day's external flow removed gives +3.12% for
the sleeve against +3.74% for the paper book over the same window — a real but
ordinary 0.6pp of cash drag and one bad marking day, which is the truth.

**Two questions, two numbers.** This module does not replace the dollar figure:
"you contributed $39,600.61 and hold $39,916.27" stays exactly as it is, and
``starting_cash`` remains the sum of contributions. What changes is that the
PERCENTAGE stops sharing that denominator, because "how much have I made" and
"how good is this strategy" are different questions and only the first one is
answerable from a cost basis.

Pure: no DB, no clock (``tests/test_returns.py``).
"""
from __future__ import annotations

from typing import Iterable, NamedTuple, Optional

# The index every series starts at. 1.0 = 0% return, and it is what the FIRST
# snapshot always gets: there is no prior value to measure against, so the
# funding that created the portfolio is not a return.
BASE_INDEX = 1.0


class Point(NamedTuple):
    """One day: the portfolio's closing value and the external flow into it."""

    value: float
    flow: float = 0.0


def daily_return(prev_value: float, value: float, flow: float = 0.0) -> Optional[float]:
    """The day's return with ``flow`` removed, or None when it is undefined.

    ``(V_t − F_t) / V_{t−1} − 1``. The flow is subtracted from the CLOSING
    value, i.e. treated as arriving at the end of the day.

    That convention is a choice and it is the conservative one. Flows land
    intraday but snapshots are daily closes, so nothing we store can say
    whether a deposit was before or after the day's move; assuming end-of-day
    credits the day's return to the capital that was already there, which
    understates the deposit day slightly and washes out immediately. Every
    retail platform does the same. The alternative — dividing by
    ``V_{t−1} + F_t`` — assumes the money worked all day, which for a deposit
    that lands at 16:00 is simply false.

    Returns None rather than 0.0 when there is nothing to divide by: a
    portfolio with no value yesterday has no return today, and reporting one as
    flat would silently blend "no data" into the series.
    """
    if prev_value is None or prev_value <= 0:
        return None
    return (value - flow) / prev_value - 1.0


def twr_index(points: Iterable[Point]) -> list[float]:
    """The cumulative index for a chronological series, starting at 1.0.

    One index per input point. A day whose return is undefined (see
    :func:`daily_return`) carries the index forward unchanged rather than
    breaking the chain — the series resumes cleanly once the portfolio has
    value again, which is what a book that was emptied and refunded should do.
    """
    out: list[float] = []
    index = BASE_INDEX
    prev_value: Optional[float] = None
    for p in points:
        if prev_value is not None:
            r = daily_return(prev_value, p.value, p.flow)
            if r is not None:
                index = _advance(index, r)
        out.append(index)
        prev_value = p.value
    return out


def advance_index(
    prev_index: Optional[float],
    prev_value: Optional[float],
    value: float,
    flow: float = 0.0,
) -> float:
    """One step of :func:`twr_index`, for the daily writer.

    The snapshot job computes today's row and must not re-read a portfolio's
    whole history to do it, so the recurrence is exposed on its own. Passing
    ``prev_index=None`` (no snapshot yesterday) starts a fresh series at
    :data:`BASE_INDEX` — which is also what a portfolio's very first snapshot
    gets, so a brand-new book and a resumed one are handled by the same call.

    Only a MISSING prior index starts fresh. An index of exactly 0 is a book
    that went to zero, and it is carried forward as 0 rather than reset: a
    reset would quietly erase a -100% from the record and redraw a wiped-out
    portfolio as flat. It also has to match :func:`twr_index`, which keeps
    multiplying through the zero — the two paths write the same column, so a
    disagreement means a portfolio's reported return depends on whether the
    daily job or the backfill touched it last.
    """
    if prev_index is None:
        return BASE_INDEX
    if prev_value is None or prev_value <= 0:
        return prev_index
    r = daily_return(prev_value, value, flow)
    return prev_index if r is None else _advance(prev_index, r)


def pct_from_index(index: Optional[float]) -> Optional[float]:
    """The index as a percentage return, or None when it is unknown."""
    if index is None or index <= 0:
        return None
    return round((index - BASE_INDEX) * 100.0, 4)


def _advance(index: float, r: float) -> float:
    """Apply one day's return, floored at total loss.

    ``r <= -1`` means the book went to zero or the data is wrong; either way
    the index cannot go negative — a negative index would render as a return
    below -100%, which is not a thing a long-only book can do.
    """
    return max(0.0, index * (1.0 + r))
