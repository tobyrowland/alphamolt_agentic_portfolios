#!/usr/bin/env python3
"""Badge awarding engine — pure decision core (no DB, no network).

Gamified awards attached to **portfolios**. This module holds the strategy-free
evaluation logic; all database I/O lives in ``award_badges.py`` (the CLI /
nightly sweep). Keeping the logic pure means every badge condition is
unit-tested with plain dicts (``tests/test_badges.py``) — no Supabase, no
prices API.

The vocabulary a caller works with:

* ``GrantSpec`` — "this portfolio earned badge <slug> (for period <period_id>),
  here is the triggering context". The driver diffs the specs a portfolio
  *should* have against the grants it *already* has and inserts the difference,
  so re-running the sweep never double-grants.
* ``PortfolioData`` — everything the per-portfolio evaluators need, already
  fetched and shaped: the daily MTM history, the trade tape, the heartbeat
  journal, plus shared inputs (the SPY close series and a price-series lookup).

Only the **phase-1** badges are evaluated here. Phase-2 badges (Thesis Keeper,
Cold Blood, Graveyard Keeper, Public Autopsy, Mutiny Survived) are seeded in the
catalog (migration 081) but blocked on upstream data that does not exist yet
(persisted thesis-break signals, per-position post-mortem notes, a
public-status history, conflicting-signal records) — they simply never produce a
GrantSpec until that data lands.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Callable, Optional

# --- constants --------------------------------------------------------------

SPY_TICKER = "SPY.US"

# A rules-based buyer is one whose picks are mechanical, not LLM judgment. The
# "Sniper" badge rewards such an agent for firing after a long dry spell.
RULES_BASED_STRATEGIES = {"ma_sniper", "pelosi_mirror"}

# Thresholds (kept named so the tests and the catalog condition_text agree).
MOLT_DAYS = 30
ESCAPE_VELOCITY_ALPHA = 0.25          # +25% cumulative alpha vs SPY
COMPOUNDER_QUARTERS = 4
FULL_DEPLOYMENT_DAYS = 30
FULL_DEPLOYMENT_CASH_FRAC = 0.05      # cash < 5% of equity
SNIPER_DRY_DAYS = 60
TUITION_LOSS_FRAC = -0.10             # realized return <= -10%
DIAMOND_DRAWDOWN_FRAC = 0.20          # price fell >= 20% below entry while held
FALLING_KNIFE_DISCOUNT_FRAC = 0.50    # bought >= 50% below 52w high
FALLING_KNIFE_GAIN_FRAC = 0.30        # closed up >= 30%
SET_FORGET_DAYS = 60
STREAK_THRESHOLDS = {"streak_10": 10, "streak_25": 25, "streak_50": 50}
DARK_HORSE_WINDOW_DAYS = 90
DARK_HORSE_BOTTOM_PCTILE = 0.25       # bottom quartile
DARK_HORSE_TOP_PCTILE = 0.90          # top decile
DARK_HORSE_MIN_PORTFOLIOS = 4         # ranking is meaningless below this

# Period-badge eligibility guardrails (anti-gaming).
PERIOD_MAX_MEDIAN_CASH = 0.40         # median cash weight over the period < 40%
PERIOD_MIN_MEDIAN_HOLDINGS = 8        # >= 8 holdings median over the period
PERIOD_PODIUM_SIZE = 3


# --- data shapes ------------------------------------------------------------


@dataclass
class GrantSpec:
    """A badge a portfolio has earned. ``period_id`` is '' for non-period
    badges; the (portfolio, badge, period) triple is unique."""

    slug: str
    period_id: str = ""
    context: dict = field(default_factory=dict)


@dataclass
class PortfolioData:
    """Everything the per-portfolio evaluators need, pre-fetched and shaped."""

    portfolio_id: str
    slug: str
    created_at: Optional[_dt.date] = None
    is_public: bool = False
    # Daily MTM snapshots, ascending by date. Each: {date, total_value, cash,
    # holdings_value, num_positions}.
    history: list[dict] = field(default_factory=list)
    # Trade tape, ascending by executed_at. Each: {ticker, side, quantity,
    # price, date (date), rules_based (bool)}.
    trades: list[dict] = field(default_factory=list)
    # Heartbeat journal, ascending. Each: {date, status}.
    heartbeats: list[dict] = field(default_factory=list)
    # Shared inputs.
    spy_by_date: dict[_dt.date, float] = field(default_factory=dict)
    # ticker -> {date: adj_close}; only populated for tickers a badge needs.
    price_lookup: Callable[[str], dict[_dt.date, float]] = lambda _t: {}


@dataclass
class RoundTrip:
    """A closed position reconstructed from the trade tape (weighted-avg cost,
    matching the app's accounting). Emitted only when the position is fully
    exited."""

    ticker: str
    open_date: _dt.date
    close_date: _dt.date
    qty: float
    entry_avg_cost: float
    exit_avg_price: float
    cost_basis: float
    proceeds: float
    realized_pnl: float
    realized_return: float


# --- small numeric helpers --------------------------------------------------


def _f(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _quarter_key(d: _dt.date) -> tuple[int, int]:
    return (d.year, (d.month - 1) // 3 + 1)


def _next_quarter(q: tuple[int, int]) -> tuple[int, int]:
    y, qq = q
    return (y + 1, 1) if qq == 4 else (y, qq + 1)


# --- alpha / return helpers -------------------------------------------------


def aligned_series(
    history: list[dict], spy_by_date: dict[_dt.date, float]
) -> list[tuple[_dt.date, float, float]]:
    """(date, portfolio_value, spy_close) for every history date that has a SPY
    close and a positive value, ascending. Restricting to SPY-priced dates
    naturally drops weekends/holidays, so daily returns are trading-day returns.
    """
    out: list[tuple[_dt.date, float, float]] = []
    for row in history:
        d = row.get("date")
        if d is None:
            continue
        spy = spy_by_date.get(d)
        v = _f(row.get("total_value"))
        if spy is None or spy <= 0 or v is None or v <= 0:
            continue
        out.append((d, v, float(spy)))
    out.sort(key=lambda x: x[0])
    return out


def eval_molt(aligned: list[tuple[_dt.date, float, float]]) -> Optional[GrantSpec]:
    """30 consecutive trading days of positive daily alpha vs SPY."""
    streak = 0
    start_idx = 0
    for i in range(1, len(aligned)):
        _, v0, s0 = aligned[i - 1]
        _, v1, s1 = aligned[i]
        daily_alpha = (v1 / v0 - 1) - (s1 / s0 - 1)
        if daily_alpha > 0:
            if streak == 0:
                start_idx = i - 1
            streak += 1
            if streak >= MOLT_DAYS:
                return GrantSpec(
                    "molt",
                    context={
                        "window_start": aligned[start_idx][0].isoformat(),
                        "window_end": aligned[i][0].isoformat(),
                        "days": streak,
                    },
                )
        else:
            streak = 0
    return None


def eval_escape_velocity(
    aligned: list[tuple[_dt.date, float, float]]
) -> Optional[GrantSpec]:
    """+25% cumulative alpha vs SPY since inception."""
    if len(aligned) < 2:
        return None
    d0, v0, s0 = aligned[0]
    dN, vN, sN = aligned[-1]
    port_cum = vN / v0 - 1
    spy_cum = sN / s0 - 1
    alpha = port_cum - spy_cum
    if alpha >= ESCAPE_VELOCITY_ALPHA:
        return GrantSpec(
            "escape_velocity",
            context={
                "since": d0.isoformat(),
                "as_of": dN.isoformat(),
                "cumulative_alpha_pct": round(alpha * 100, 2),
                "portfolio_return_pct": round(port_cum * 100, 2),
                "spy_return_pct": round(spy_cum * 100, 2),
            },
        )
    return None


def eval_compounder(
    aligned: list[tuple[_dt.date, float, float]]
) -> Optional[GrantSpec]:
    """Beat SPY four consecutive calendar quarters (quarter close vs previous
    quarter close)."""
    # Last aligned (value, spy) seen in each calendar quarter.
    by_q: dict[tuple[int, int], tuple[float, float]] = {}
    for d, v, s in aligned:
        by_q[_quarter_key(d)] = (v, s)
    quarters = sorted(by_q.keys())
    if len(quarters) < COMPOUNDER_QUARTERS + 1:
        return None

    streak = 0
    run: list[tuple[int, int]] = []
    for i in range(1, len(quarters)):
        q_prev, q_cur = quarters[i - 1], quarters[i]
        if _next_quarter(q_prev) != q_cur:
            streak = 0
            run = []
            continue
        vprev, sprev = by_q[q_prev]
        vcur, scur = by_q[q_cur]
        if (vcur / vprev - 1) > (scur / sprev - 1):
            streak += 1
            run.append(q_cur)
            if streak >= COMPOUNDER_QUARTERS:
                return GrantSpec(
                    "compounder",
                    context={
                        "quarters": [f"{y}-Q{q}" for (y, q) in run[-COMPOUNDER_QUARTERS:]],
                    },
                )
        else:
            streak = 0
            run = []
    return None


def eval_full_deployment(history: list[dict]) -> Optional[GrantSpec]:
    """Cash < 5% of equity for 30 consecutive daily snapshots."""
    rows = sorted(
        (r for r in history if r.get("date") is not None),
        key=lambda r: r["date"],
    )
    streak = 0
    start = None
    for r in rows:
        tv = _f(r.get("total_value"))
        cash = _f(r.get("cash"))
        if tv is None or tv <= 0 or cash is None:
            streak = 0
            start = None
            continue
        if cash / tv < FULL_DEPLOYMENT_CASH_FRAC:
            if streak == 0:
                start = r["date"]
            streak += 1
            if streak >= FULL_DEPLOYMENT_DAYS:
                return GrantSpec(
                    "full_deployment",
                    context={
                        "window_start": start.isoformat(),
                        "window_end": r["date"].isoformat(),
                        "days": streak,
                    },
                )
        else:
            streak = 0
            start = None
    return None


def eval_set_and_forget(
    aligned: list[tuple[_dt.date, float, float]],
    trades: list[dict],
) -> Optional[GrantSpec]:
    """A 60-day span with zero manual overrides and positive alpha end-to-end.

    "Manual override" = a trade tagged ``manual`` (the owner traded by hand).
    We look for the minimal >=60-day window starting at each aligned point that
    is manual-free and whose end-to-end alpha is positive.
    """
    manual_dates = sorted(
        t["date"] for t in trades if t.get("manual") and t.get("date") is not None
    )

    def has_manual(a: _dt.date, b: _dt.date) -> bool:
        return any(a < md <= b for md in manual_dates)

    n = len(aligned)
    j = 0
    for i in range(n):
        di, vi, si = aligned[i]
        if j < i + 1:
            j = i + 1
        while j < n and (aligned[j][0] - di).days < SET_FORGET_DAYS:
            j += 1
        if j >= n:
            break
        dj, vj, sj = aligned[j]
        if has_manual(di, dj):
            continue
        alpha = (vj / vi - 1) - (sj / si - 1)
        if alpha > 0:
            return GrantSpec(
                "set_and_forget",
                context={
                    "window_start": di.isoformat(),
                    "window_end": dj.isoformat(),
                    "alpha_pct": round(alpha * 100, 2),
                },
            )
    return None


def eval_sniper(trades: list[dict]) -> Optional[GrantSpec]:
    """A rules-based buy agent fired after >=60 days without a purchase."""
    buys = sorted(
        (
            t
            for t in trades
            if t.get("side") == "buy"
            and t.get("rules_based")
            and t.get("date") is not None
        ),
        key=lambda t: t["date"],
    )
    prev: Optional[_dt.date] = None
    for t in buys:
        d = t["date"]
        if prev is not None and (d - prev).days >= SNIPER_DRY_DAYS:
            return GrantSpec(
                "sniper",
                context={
                    "ticker": t.get("ticker"),
                    "date": d.isoformat(),
                    "dry_days": (d - prev).days,
                },
            )
        prev = d
    return None


def reconstruct_round_trips(trades: list[dict]) -> list[RoundTrip]:
    """Replay the trade tape into closed round-trips (weighted-avg cost).

    A round-trip opens on the first buy from a flat position and closes when the
    position returns to zero. Partial sells and re-buys stay inside the same
    round-trip. Only fully-closed positions are emitted; a still-open position
    produces nothing.
    """
    by_ticker: dict[str, list[dict]] = {}
    for t in trades:
        tk = t.get("ticker")
        if tk and t.get("date") is not None:
            by_ticker.setdefault(tk, []).append(t)

    out: list[RoundTrip] = []
    for ticker, ts in by_ticker.items():
        ts = sorted(ts, key=lambda t: (t["date"], 0 if t.get("side") == "buy" else 1))
        qty = 0.0
        cost = 0.0            # total cost of open shares (qty * avg)
        open_date: Optional[_dt.date] = None
        rt_qty = 0.0          # shares sold in the current round-trip
        rt_cost = 0.0         # cost basis of those shares
        rt_proceeds = 0.0
        rt_pnl = 0.0
        for t in ts:
            q = _f(t.get("quantity")) or 0.0
            px = _f(t.get("price"))
            if q <= 0 or px is None:
                continue
            side = t.get("side")
            if side == "buy":
                if qty <= 1e-9:
                    open_date = t["date"]
                qty += q
                cost += q * px
            elif side == "sell":
                if qty <= 1e-9:
                    continue  # nothing to sell (bad data) — skip
                sell_qty = min(q, qty)
                avg_cost = cost / qty
                rt_qty += sell_qty
                rt_cost += avg_cost * sell_qty
                rt_proceeds += px * sell_qty
                rt_pnl += (px - avg_cost) * sell_qty
                qty -= sell_qty
                cost -= avg_cost * sell_qty
                if qty <= 1e-9 and rt_qty > 0 and open_date is not None:
                    out.append(
                        RoundTrip(
                            ticker=ticker,
                            open_date=open_date,
                            close_date=t["date"],
                            qty=rt_qty,
                            entry_avg_cost=rt_cost / rt_qty,
                            exit_avg_price=rt_proceeds / rt_qty,
                            cost_basis=rt_cost,
                            proceeds=rt_proceeds,
                            realized_pnl=rt_pnl,
                            realized_return=(rt_pnl / rt_cost) if rt_cost > 0 else 0.0,
                        )
                    )
                    qty = 0.0
                    cost = 0.0
                    open_date = None
                    rt_qty = rt_cost = rt_proceeds = rt_pnl = 0.0
    out.sort(key=lambda rt: rt.close_date)
    return out


def eval_tuition_paid(round_trips: list[RoundTrip]) -> Optional[GrantSpec]:
    """First realized loss of 10%+ on a closed position."""
    for rt in round_trips:  # already sorted by close_date
        if rt.realized_return <= TUITION_LOSS_FRAC:
            return GrantSpec(
                "tuition_paid",
                context={
                    "ticker": rt.ticker,
                    "closed_at": rt.close_date.isoformat(),
                    "loss_pct": round(rt.realized_return * 100, 2),
                },
            )
    return None


def _min_price_in_window(
    series: dict[_dt.date, float], start: _dt.date, end: _dt.date
) -> Optional[float]:
    vals = [p for d, p in series.items() if start <= d <= end and p and p > 0]
    return min(vals) if vals else None


def _max_price_in_window(
    series: dict[_dt.date, float], start: _dt.date, end: _dt.date
) -> Optional[float]:
    vals = [p for d, p in series.items() if start <= d <= end and p and p > 0]
    return max(vals) if vals else None


def eval_diamond_conviction(
    round_trips: list[RoundTrip],
    price_lookup: Callable[[str], dict[_dt.date, float]],
) -> Optional[GrantSpec]:
    """Held a position through a >=20% drawdown that later closed profitable."""
    for rt in round_trips:
        if rt.realized_pnl <= 0 or rt.entry_avg_cost <= 0:
            continue
        series = price_lookup(rt.ticker) or {}
        low = _min_price_in_window(series, rt.open_date, rt.close_date)
        if low is None:
            continue
        drawdown = 1 - (low / rt.entry_avg_cost)
        if drawdown >= DIAMOND_DRAWDOWN_FRAC:
            return GrantSpec(
                "diamond_conviction",
                context={
                    "ticker": rt.ticker,
                    "opened_at": rt.open_date.isoformat(),
                    "closed_at": rt.close_date.isoformat(),
                    "max_drawdown_pct": round(drawdown * 100, 2),
                    "realized_return_pct": round(rt.realized_return * 100, 2),
                },
            )
    return None


def eval_falling_knife(
    round_trips: list[RoundTrip],
    price_lookup: Callable[[str], dict[_dt.date, float]],
) -> Optional[GrantSpec]:
    """Bought a name >=50% below its 52-week high; closed it up >=30%."""
    for rt in round_trips:
        if rt.realized_return < FALLING_KNIFE_GAIN_FRAC or rt.entry_avg_cost <= 0:
            continue
        series = price_lookup(rt.ticker) or {}
        high_52w = _max_price_in_window(
            series, rt.open_date - _dt.timedelta(days=365), rt.open_date
        )
        if high_52w is None or high_52w <= 0:
            continue
        discount = 1 - (rt.entry_avg_cost / high_52w)
        if discount >= FALLING_KNIFE_DISCOUNT_FRAC:
            return GrantSpec(
                "falling_knife_license",
                context={
                    "ticker": rt.ticker,
                    "opened_at": rt.open_date.isoformat(),
                    "closed_at": rt.close_date.isoformat(),
                    "discount_to_52w_high_pct": round(discount * 100, 2),
                    "realized_return_pct": round(rt.realized_return * 100, 2),
                },
            )
    return None


def eval_streaks(heartbeats: list[dict]) -> list[GrantSpec]:
    """Consecutive scheduled rebalances executed cleanly.

    Rows are collapsed to one event per calendar day (a portfolio's swarm
    journals several agent rows per tick). A day counts as an executed
    rebalance if it has >=1 'ok' row and no 'error' row; an 'error' day breaks
    the streak; a day with only 'skipped' rows (cadence not due) is ignored.
    """
    by_day: dict[_dt.date, set[str]] = {}
    for h in heartbeats:
        d = h.get("date")
        st = h.get("status")
        if d is None or st is None:
            continue
        by_day.setdefault(d, set()).add(st)

    best = 0
    streak = 0
    for d in sorted(by_day):
        statuses = by_day[d]
        if "error" in statuses:
            streak = 0
        elif "ok" in statuses:
            streak += 1
            best = max(best, streak)
        # only-skipped day: ignore, streak unchanged
    out: list[GrantSpec] = []
    for slug, thresh in STREAK_THRESHOLDS.items():
        if best >= thresh:
            out.append(GrantSpec(slug, context={"streak": best}))
    return out


def evaluate_portfolio(data: PortfolioData) -> list[GrantSpec]:
    """Run every phase-1, per-portfolio badge evaluator and collect the grants
    this portfolio has earned. Pure — safe to re-run (the driver de-dupes)."""
    aligned = aligned_series(data.history, data.spy_by_date)
    round_trips = reconstruct_round_trips(data.trades)

    specs: list[GrantSpec] = []

    def _add(spec: Optional[GrantSpec]) -> None:
        if spec is not None:
            specs.append(spec)

    # Alpha & performance
    _add(eval_molt(aligned))
    _add(eval_escape_velocity(aligned))
    _add(eval_compounder(aligned))
    # Process & discipline
    _add(eval_full_deployment(data.history))
    _add(eval_sniper(data.trades))
    _add(eval_diamond_conviction(round_trips, data.price_lookup))
    # Honesty & losses
    _add(eval_tuition_paid(round_trips))
    _add(eval_falling_knife(round_trips, data.price_lookup))
    # Swarm & mechanics
    _add(eval_set_and_forget(aligned, data.trades))
    specs.extend(eval_streaks(data.heartbeats))

    return specs


# --- cross-portfolio: Dark Horse -------------------------------------------


def eval_dark_horse(
    returns_by_portfolio: dict[str, list[tuple[_dt.date, float]]],
) -> dict[str, GrantSpec]:
    """Bottom quartile -> top decile of the leaderboard within 90 days.

    Input: portfolio_id -> ascending [(date, since-inception return)]. We build
    a cross-sectional percentile for every date shared by >= MIN portfolios,
    then a portfolio qualifies if it was in the bottom quartile on some day and
    in the top decile on a day within the next 90.
    """
    # Collect all dates and the per-date return of each portfolio.
    dates: set[_dt.date] = set()
    for series in returns_by_portfolio.values():
        for d, _ in series:
            dates.add(d)

    # date -> {portfolio_id: return}
    per_date: dict[_dt.date, dict[str, float]] = {d: {} for d in dates}
    for pid, series in returns_by_portfolio.items():
        for d, r in series:
            per_date[d][pid] = r

    # date -> {portfolio_id: percentile in [0,1]} (1 = best return)
    pctile: dict[_dt.date, dict[str, float]] = {}
    for d, rmap in per_date.items():
        if len(rmap) < DARK_HORSE_MIN_PORTFOLIOS:
            continue
        ordered = sorted(rmap.items(), key=lambda kv: kv[1])  # worst -> best
        n = len(ordered)
        pm: dict[str, float] = {}
        for rank, (pid, _) in enumerate(ordered):
            pm[pid] = rank / (n - 1) if n > 1 else 1.0
        pctile[d] = pm

    out: dict[str, GrantSpec] = {}
    for pid, series in returns_by_portfolio.items():
        # ascending list of (date, percentile) where this pid was ranked
        ranked = sorted(
            (d, pctile[d][pid]) for d, _ in series if d in pctile and pid in pctile[d]
        )
        low_dates = [d for d, p in ranked if p <= DARK_HORSE_BOTTOM_PCTILE]
        for d0 in low_dates:
            for d1, p1 in ranked:
                if d0 < d1 <= d0 + _dt.timedelta(days=DARK_HORSE_WINDOW_DAYS):
                    if p1 >= DARK_HORSE_TOP_PCTILE:
                        out[pid] = GrantSpec(
                            "dark_horse",
                            context={
                                "from": d0.isoformat(),
                                "to": d1.isoformat(),
                                "days": (d1 - d0).days,
                            },
                        )
                        break
            if pid in out:
                break
    return out


# --- period champions -------------------------------------------------------


def _median(vals: list[float]) -> Optional[float]:
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return None
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


def period_bounds(kind: str, ref: _dt.date) -> tuple[_dt.date, _dt.date]:
    """Start/end (inclusive) of the calendar period of ``kind`` containing
    ``ref``. kind in {'month','quarter','year'}."""
    if kind == "year":
        return _dt.date(ref.year, 1, 1), _dt.date(ref.year, 12, 31)
    if kind == "quarter":
        q = (ref.month - 1) // 3
        start = _dt.date(ref.year, q * 3 + 1, 1)
        end_month = q * 3 + 3
        if end_month == 12:
            end = _dt.date(ref.year, 12, 31)
        else:
            end = _dt.date(ref.year, end_month + 1, 1) - _dt.timedelta(days=1)
        return start, end
    # month
    start = _dt.date(ref.year, ref.month, 1)
    if ref.month == 12:
        end = _dt.date(ref.year, 12, 31)
    else:
        end = _dt.date(ref.year, ref.month + 1, 1) - _dt.timedelta(days=1)
    return start, end


def period_id(kind: str, start: _dt.date) -> str:
    if kind == "year":
        return f"{start.year}"
    if kind == "quarter":
        return f"{start.year}-Q{(start.month - 1) // 3 + 1}"
    return f"{start.year}-{start.month:02d}"


def period_label(kind: str, start: _dt.date) -> str:
    months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    if kind == "year":
        return f"Champion — {start.year}"
    if kind == "quarter":
        return f"Champion — Q{(start.month - 1) // 3 + 1} {start.year}"
    return f"Champion — {months[start.month - 1]} {start.year}"


@dataclass
class PeriodStanding:
    """A portfolio's standing over a closed calendar period, with the anti-gaming
    eligibility inputs already measured over that period."""

    portfolio_id: str
    alpha: float
    existed_before_start: bool
    public_all_period: bool
    median_cash_frac: Optional[float]
    median_holdings: Optional[float]

    def eligible(self) -> bool:
        return (
            self.existed_before_start
            and self.public_all_period
            and self.median_cash_frac is not None
            and self.median_cash_frac < PERIOD_MAX_MEDIAN_CASH
            and self.median_holdings is not None
            and self.median_holdings >= PERIOD_MIN_MEDIAN_HOLDINGS
        )


def rank_period(
    kind: str, start: _dt.date, standings: list[PeriodStanding]
) -> list[tuple[str, GrantSpec]]:
    """Grant champion + podium badges for one closed calendar period.

    Only eligible portfolios (guardrails) compete. #1 by alpha gets the dated
    champion badge; the top 3 get the podium badge (period_id ``<kind>:<pid>``
    so a portfolio can podium in month, quarter and year distinctly). Returns a
    list of ``(portfolio_id, GrantSpec)``.
    """
    pid_of_period = period_id(kind, start)
    label = period_label(kind, start)
    champ_slug = {"month": "champion_month", "quarter": "champion_quarter",
                  "year": "champion_year"}[kind]

    eligible = [s for s in standings if s.eligible()]
    eligible.sort(key=lambda s: s.alpha, reverse=True)

    grants: list[tuple[str, GrantSpec]] = []
    if not eligible:
        return grants

    champ = eligible[0]
    grants.append((
        champ.portfolio_id,
        GrantSpec(
            champ_slug,
            period_id=pid_of_period,
            context={
                "label": label,
                "period": pid_of_period,
                "alpha_pct": round(champ.alpha * 100, 2),
                "rank": 1,
            },
        ),
    ))
    podium_period = f"{kind}:{pid_of_period}"
    short = label.replace("Champion — ", "")
    for i, s in enumerate(eligible[:PERIOD_PODIUM_SIZE], start=1):
        grants.append((
            s.portfolio_id,
            GrantSpec(
                "podium",
                period_id=podium_period,
                context={
                    "label": f"Podium — {short}",
                    "period": pid_of_period,
                    "kind": kind,
                    "alpha_pct": round(s.alpha * 100, 2),
                    "rank": i,
                },
            ),
        ))
    return grants
