#!/usr/bin/env python3
"""
Sleeves — several live portfolios sharing one broker account.

The model (migration 083). The broker holds **one pot**: one cash balance and one
set of positions. On top of that, AlphaMolt runs N live portfolios ("sleeves"),
each of which owns:

  * its **own recorded holdings** (``portfolio_holdings``) — of the broker's 15
    Nvidia shares, 10 are sleeve A's and 5 are sleeve B's, and only AlphaMolt
    knows that;
  * its **own allowance** (``portfolio_accounts.cash_usd``) — the cash the owner
    has credited to it, and the most it may spend.

Two invariants tie the two views together:

    SUM over sleeves of holdings[symbol]  ==  broker position for symbol
    SUM over sleeves of allowance         <=  broker cash

The first must hold exactly (modulo fractional-share float noise): if it
doesn't, AlphaMolt's idea of who owns what has diverged from reality and no
sleeve can safely compute an order. The second is an inequality because the
difference is **unallocated** cash — dividends, interest, fees and fresh
deposits all land in the broker's pot and belong to nobody until the owner
credits them to a sleeve. That is deliberate: attributing dividends per sleeve
is a large amount of machinery for amounts that are immaterial on a
growth-equity book.

Everything here is pure — plain numbers and dicts in, verdicts out. No DB, no
broker, no network (unit-tested in ``tests/test_sleeves.py``). The DB-facing
callers are ``alpaca_mirror`` (plans against a sleeve's own book),
``broker_sync`` (refuses to overwrite a shared account) and ``live_cash``
(moves allowances).
"""

from __future__ import annotations

from dataclasses import dataclass

#: Quantity equality tolerance. The mirror rounds share deltas to 4dp, and
#: fractional-share brokers report quantities with more precision than that, so
#: differences below this are float noise rather than real divergence.
QTY_TOLERANCE = 1e-4

#: Cash equality tolerance, in dollars — sub-cent differences are rounding.
CASH_TOLERANCE = 0.01


@dataclass(frozen=True)
class PositionDrift:
    """One symbol where the sleeves' records disagree with the broker."""

    ticker: str
    recorded: float   # what the sleeves' books add up to
    actual: float     # what the broker reports

    @property
    def delta(self) -> float:
        """Broker minus records. Positive = broker holds more than we think."""
        return round(self.actual - self.recorded, 6)

    def describe(self) -> str:
        return (
            f"{self.ticker}: records={self.recorded:g} "
            f"broker={self.actual:g} delta={self.delta:+g}"
        )


def recorded_positions(books: dict[str, dict]) -> dict[str, float]:
    """Sum each symbol's quantity across sleeve books.

    ``books`` maps portfolio_id -> a ``PortfolioManager.get_portfolio_book``
    result. Symbols summing to zero are dropped, so a fully-exited name doesn't
    linger and compare against a broker position that no longer exists either.
    """
    totals: dict[str, float] = {}
    for book in books.values():
        for holding in book.get("holdings", []):
            ticker = holding["ticker"]
            totals[ticker] = totals.get(ticker, 0.0) + float(
                holding.get("quantity") or 0
            )
    return {t: q for t, q in totals.items() if abs(q) > QTY_TOLERANCE}


def position_drift(
    recorded: dict[str, float],
    actual: dict[str, float],
    *,
    tolerance: float = QTY_TOLERANCE,
) -> list[PositionDrift]:
    """Symbols where the sleeves' combined records != the broker's positions.

    Checks the union of both sides, so it catches all three failure shapes: a
    symbol the broker holds that no sleeve claims (an untracked manual trade), a
    symbol the sleeves claim that the broker doesn't hold (a sell we recorded but
    that never actually filled), and a quantity mismatch. Returns [] when
    everything reconciles. Sorted by ticker so output is stable.
    """
    out: list[PositionDrift] = []
    for ticker in sorted(set(recorded) | set(actual)):
        r = float(recorded.get(ticker, 0.0))
        a = float(actual.get(ticker, 0.0))
        if abs(a - r) > tolerance:
            out.append(PositionDrift(ticker, r, a))
    return out


def unallocated_cash(broker_cash: float, allowances: dict[str, float]) -> float:
    """Broker cash not yet credited to any sleeve.

    Negative means the sleeves have collectively been promised more than the
    account holds — an over-commitment that will show up as a rejected order,
    so callers should treat it as a fault rather than clamp it to zero.
    """
    return round(float(broker_cash) - sum(float(v) for v in allowances.values()), 2)


@dataclass(frozen=True)
class CreditVerdict:
    """Outcome of proposing an allowance change."""

    ok: bool
    reason: str
    new_balance: float
    new_unallocated: float


def plan_credit(
    broker_cash: float,
    allowances: dict[str, float],
    portfolio_id: str,
    delta: float,
    *,
    cash_tolerance: float = CASH_TOLERANCE,
) -> CreditVerdict:
    """Validate moving ``delta`` into (+) or out of (-) a sleeve's allowance.

    Two ways this is refused:

    * crediting more than is unallocated — the account simply doesn't hold it,
      and promising it would produce a rejected order later, at the broker,
      when it is much harder to understand;
    * debiting more than the sleeve's allowance — that would drive it negative.

    Note what is *not* checked: whether the sleeve has already spent its
    allowance on shares. It hasn't got the cash then, so there is nothing to
    take back — a debit is capped by the current balance, not by what was
    credited historically. To free up a spent allowance the sleeve has to sell,
    and the proceeds return to its own allowance.
    """
    current = float(allowances.get(portfolio_id, 0.0))
    delta = float(delta)

    if delta == 0:
        return CreditVerdict(
            False, "delta is zero — nothing to do", current,
            unallocated_cash(broker_cash, allowances),
        )

    spare = unallocated_cash(broker_cash, allowances)

    if delta > 0 and delta > spare + cash_tolerance:
        return CreditVerdict(
            False,
            f"only ${spare:,.2f} unallocated at the broker — "
            f"cannot credit ${delta:,.2f}",
            current,
            spare,
        )

    if delta < 0 and -delta > current + cash_tolerance:
        return CreditVerdict(
            False,
            f"allowance is ${current:,.2f} — cannot debit ${-delta:,.2f} "
            f"(sell holdings to free up more)",
            current,
            spare,
        )

    new_balance = round(current + delta, 2)
    updated = dict(allowances)
    updated[portfolio_id] = new_balance
    return CreditVerdict(
        True, "ok", new_balance, unallocated_cash(broker_cash, updated),
    )


def sleeve_own_positions(book: dict) -> dict[str, float]:
    """A single sleeve's own recorded quantities, keyed by ticker.

    This — **not** the broker's aggregate — is what the mirror diffs its target
    against. It is the whole reason two sleeves can share an account without
    fighting: sleeve A's book never mentions the symbols only sleeve B holds, so
    A cannot mistake them for drift and sell them.
    """
    return {
        h["ticker"]: float(h.get("quantity") or 0)
        for h in book.get("holdings", [])
        if abs(float(h.get("quantity") or 0)) > QTY_TOLERANCE
    }
