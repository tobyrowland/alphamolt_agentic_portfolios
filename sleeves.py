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

import math
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


#: A buy trimmed below this dollar value is dropped instead of placed. Ordering
#: a few dollars of stock costs a round trip and leaves a dust position; the
#: shortfall it was trimmed for is recovered on the next run anyway.
MIN_TRIMMED_ORDER_USD = 25.0


def affordable_buy_qty(
    qty: float,
    limit_price: float,
    allowance: float,
    *,
    min_order_usd: float = MIN_TRIMMED_ORDER_USD,
) -> float:
    """How much of a planned buy this sleeve's allowance can actually pay for.

    The mirror sizes orders against a sleeve's **equity** (holdings + allowance)
    and executes sells before buys, so the buys are funded by proceeds that have
    not landed at their planned prices. Slippage on both sides eats the residue,
    and the last buy of a large rebalance is the one that runs out of money: on
    2026-08-26 a 40-order run's final buy came to ~$1,437 against a $1,360.48
    allowance and the RPC refused it — *after* the broker had already filled it.

    So the check has to happen before the order is placed, and it has to be
    against the **limit** price rather than the reference price: the order is a
    marketable limit one band above the market, and the broker may fill anywhere
    up to it. Sizing off the reference price would leave a buy that fills a
    band-width high unaffordable all over again.

    Returns the quantity to order — the request when it fits, a trimmed
    quantity when it doesn't, or ``0.0`` to skip (the allowance is spent, the
    price is unusable, or the trim would leave a dust order). Trimming rather
    than skipping is what keeps the book converging: a skipped name would be
    re-planned and re-skipped at the same shortfall on every subsequent run.
    """
    if qty <= 0 or limit_price <= 0:
        return 0.0
    if allowance <= 0:
        return 0.0
    cost = qty * limit_price
    if cost <= allowance:
        return qty
    trimmed = allowance / limit_price
    # Round DOWN to the mirror's own 4dp share precision — rounding to nearest
    # can round back up over the allowance and re-create the rejection.
    trimmed = math.floor(trimmed * 10_000) / 10_000
    if trimmed <= 0 or trimmed * limit_price < min_order_usd:
        return 0.0
    return trimmed


@dataclass(frozen=True)
class InKindMove:
    """One share leg of an in-kind funding plan."""

    ticker: str
    qty: float
    avg_cost: float
    approx_value: float   # qty × current price at plan time — informational


@dataclass(frozen=True)
class InKindPlan:
    """How to fund ``total`` from a source sleeve: cash first, then shares.

    ``cash_move`` comes out of the source's allowance; ``share_moves`` are
    proportional slices of its positions. ``planned_total`` can fall short of
    the request when the source simply doesn't hold enough value — callers
    refuse in that case rather than partially funding by surprise.
    """

    cash_move: float
    share_moves: tuple[InKindMove, ...]
    planned_total: float

    @property
    def share_value(self) -> float:
        return round(sum(m.approx_value for m in self.share_moves), 2)


def plan_in_kind(
    source_cash: float,
    holdings: list[dict],
    total: float,
    *,
    min_leg_usd: float = 1.0,
) -> InKindPlan:
    """Plan funding ``total`` from a sleeve: spare cash first, shares for the rest.

    ``holdings`` rows carry ``ticker``, ``quantity``, ``avg_cost_usd`` and
    ``price`` (current). The share legs take the same fraction of every
    priced position — proportional, so the source's shape is preserved and
    its mirror stays at rest. Legs under ``min_leg_usd`` are dropped (dust);
    the shortfall that creates is made up by scaling the remaining legs is
    NOT attempted — the plan simply reports what it moves via
    ``planned_total`` and callers compare against the request.

    Pure: no DB, no broker (mirrored in TS as ``planInKindFunding`` —
    web/lib/live-cash-mutations.ts — keep the two in lock-step).
    """
    total = round(float(total), 2)
    cash_move = round(min(max(float(source_cash), 0.0), total), 2)
    remainder = round(total - cash_move, 2)
    if remainder <= 0:
        return InKindPlan(cash_move, (), cash_move)

    priced = [
        h for h in holdings
        if float(h.get("quantity") or 0) > 0 and float(h.get("price") or 0) > 0
    ]
    holdings_value = sum(
        float(h["quantity"]) * float(h["price"]) for h in priced
    )
    if holdings_value <= 0:
        return InKindPlan(cash_move, (), cash_move)

    fraction = min(remainder / holdings_value, 1.0)
    moves: list[InKindMove] = []
    for h in sorted(priced, key=lambda h: h["ticker"]):
        qty = round(float(h["quantity"]) * fraction, 4)
        value = round(qty * float(h["price"]), 2)
        if qty <= 0 or value < min_leg_usd:
            continue
        moves.append(InKindMove(
            ticker=h["ticker"],
            qty=qty,
            avg_cost=round(float(h.get("avg_cost_usd") or h["price"]), 4),
            approx_value=value,
        ))

    planned = round(cash_move + sum(m.approx_value for m in moves), 2)
    return InKindPlan(cash_move, tuple(moves), planned)


# ---------------------------------------------------------------------------
# P&L baselines — keeping "since it started" honest when money moves
# ---------------------------------------------------------------------------
#
# A sleeve's return is (value − starting_cash) / starting_cash, so the baseline
# has to mean "the money put into this sleeve". Every owner-initiated movement
# therefore has to move the baseline too, or the movement itself is booked as
# performance: a deposit credited to a strategy shows up as pure profit, and a
# withdrawal as a loss. Two rules cover every path:
#
#   money IN  -> baseline += amount        the new money starts flat
#   money OUT -> baseline *= 1 − amount/equity   the sleeve's % is untouched
#
# The asymmetry is deliberate. Adding capital should not move the return you
# have earned so far, and removing capital should not either — scaling is the
# only way to take money out without booking a phantom loss. `equity` must be
# the sleeve's MARKET value (cash + holdings at current prices), measured the
# same way as `amount`; mixing market value with cost basis is precisely the
# bug migration 085 fixes.


def baseline_after_deposit(starting_cash: float, amount: float) -> float:
    """Baseline after `amount` of new capital arrives in a sleeve."""
    if amount <= 0:
        return round(float(starting_cash or 0), 2)
    return round(float(starting_cash or 0) + float(amount), 2)


def baseline_after_withdrawal(
    starting_cash: float, amount: float, equity: float,
) -> float:
    """Baseline after `amount` of value leaves a sleeve worth `equity`.

    Scales proportionally, so the sleeve's return percentage is unchanged by
    the withdrawal itself. Falls back to leaving the baseline alone when the
    equity isn't usable (zero/negative, or smaller than the amount leaving) —
    a wrong rescale is worse than none, and those cases mean our records
    disagree with reality anyway.
    """
    starting = float(starting_cash or 0)
    equity = float(equity or 0)
    amount = float(amount or 0)
    if starting <= 0 or amount <= 0 or equity <= 0 or equity <= amount:
        return round(starting, 2)
    return round(starting * (1.0 - amount / equity), 2)


# ----------------------------------------------------------------------
# Repairing records that diverged from the broker
# ----------------------------------------------------------------------

@dataclass(frozen=True)
class RepairLeg:
    """One trade to book so a sleeve's records match the broker again."""

    ticker: str
    side: str        # "buy" | "sell"
    qty: float
    price: float
    order_id: str

    @property
    def value(self) -> float:
        return round(self.qty * self.price, 2)

    def describe(self) -> str:
        return (
            f"{self.side} {self.qty:g} {self.ticker} @ ${self.price:,.4f} "
            f"= ${self.value:,.2f}  [{self.order_id or '?'}]"
        )


@dataclass(frozen=True)
class RepairPlan:
    """What to book, and how much allowance the sleeve needs first.

    ``topup`` is cash to credit from the unallocated pot before the legs are
    booked: an unrecorded buy was paid for out of the broker's pooled cash, so
    the sleeve's allowance is short by exactly the amount it overspent. Booking
    without the top-up would just be refused again, for the same reason.

    ``refusals`` is why a drifted symbol was left alone. A plan with refusals is
    still executable for the symbols it did resolve — but it will not clear the
    alignment gate, so callers report them loudly.
    """

    legs: tuple[RepairLeg, ...]
    topup: float
    refusals: tuple[str, ...]

    @property
    def net_cash(self) -> float:
        """Allowance change from the legs alone — sells credit, buys debit."""
        return round(
            sum(leg.value if leg.side == "sell" else -leg.value for leg in self.legs),
            2,
        )


def plan_repair(
    drift: list[PositionDrift],
    fills: list[dict],
    recorded_order_ids: set[str],
    allowance: float,
    unallocated: float,
    *,
    qty_tolerance: float = QTY_TOLERANCE,
) -> RepairPlan:
    """Book the broker fills a sleeve's records are missing — at their real prices.

    A fill can land at the broker and fail to reach our records (the atomic RPC
    refuses an over-allowance buy; a partial fill arrives after
    ``execute_and_wait`` gives up). On a **sole-occupant** account
    ``broker_sync.sync_to_db`` cleans that up by overwriting the book wholesale.
    On a **shared** account it must not — the overwrite would hand one sleeve
    every position in the account — so nothing repaired it, and the alignment
    gate correctly halted all trading until a human did.

    This is that human's tool, and the price is the whole reason it exists: the
    quantity is knowable from the drift, but what the account actually paid is
    only in the broker's own tape. ``fills`` are its ``FILL`` activity rows; a
    symbol whose difference has no matching unrecorded fill is REFUSED rather
    than booked at a guessed price — a wrong cost basis is a permanent, silent
    error in every return the sleeve ever reports.

    The caller names the sleeve to attribute to; this does the arithmetic. It
    never nets one symbol's difference against another's, and it never invents a
    fill.
    """
    legs: list[RepairLeg] = []
    refusals: list[str] = []

    by_symbol: dict[str, list[dict]] = {}
    for row in fills:
        sym = (row.get("symbol") or "").upper()
        if sym:
            by_symbol.setdefault(sym, []).append(row)

    for d in drift:
        delta = d.delta
        if abs(delta) <= qty_tolerance:
            continue
        side = "buy" if delta > 0 else "sell"
        want = abs(delta)
        candidates = [
            row for row in by_symbol.get(d.ticker.upper(), [])
            if (row.get("side") or "").lower().startswith(side)
            and str(row.get("order_id") or "") not in recorded_order_ids
        ]
        if not candidates:
            refusals.append(
                f"{d.ticker}: {side} of {want:g} sh unaccounted for, but no "
                f"unrecorded broker {side} fill to price it against — repair by "
                f"hand or re-read the broker's tape"
            )
            continue
        best = candidates[0]
        try:
            price = float(best.get("price"))
        except (TypeError, ValueError):
            price = 0.0
        if price <= 0:
            refusals.append(f"{d.ticker}: broker fill carries no usable price")
            continue
        legs.append(
            RepairLeg(
                ticker=d.ticker,
                side=side,
                qty=round(want, 6),
                price=price,
                order_id=str(best.get("order_id") or ""),
            )
        )

    # Sells first: their proceeds help fund the buys, exactly as in a live run.
    legs.sort(key=lambda leg: (leg.side != "sell", leg.ticker))

    spend = sum(leg.value for leg in legs if leg.side == "buy")
    proceeds = sum(leg.value for leg in legs if leg.side == "sell")
    shortfall = round(spend - (float(allowance) + proceeds), 2)
    topup = max(0.0, shortfall)
    if topup > 0 and topup > float(unallocated) + CASH_TOLERANCE:
        refusals.append(
            f"needs ${topup:,.2f} credited to cover the unrecorded buys but "
            f"only ${float(unallocated):,.2f} is unallocated — credit the "
            f"account or repair a smaller set"
        )
        return RepairPlan(legs=(), topup=0.0, refusals=tuple(refusals))

    return RepairPlan(legs=tuple(legs), topup=topup, refusals=tuple(refusals))
