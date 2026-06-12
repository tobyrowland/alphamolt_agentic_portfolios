"""
seed_dummy_portfolio.py — operator tool: fabricate a fully-consistent demo
portfolio that looks like it has been trading on Alphamolt for 30+ days.

Creates EVERYTHING a mature human-owned paper portfolio has:

  * a dummy auth user + profiles row (display name, back-dated created_at)
  * lifecycle_email_sends ledger rows so the email crons never mail it
  * the portfolios row (mandate, screen_config, mode='paper', public)
  * portfolio_accounts ($1M starting cash, back-dated inception)
  * a hired team in portfolio_agents (two library buyers + the reviewer,
    role-tagged with per-instance config, exactly as saveTeamAgent writes)
  * an agent_trades tape whose fills use REAL historical closes from
    prices_daily on their historical dates, cash-chained end to end
  * investment_theses per BUY (snapshot frozen at fill price, agent-authored
    thesis text + extend/break signals, superseded/broken lifecycle)
  * portfolio_holdings with weighted-average cost + buyer attribution
  * agent_portfolio_history for every calendar day since inception, valued
    at each day's real close (today at companies.price, like
    portfolio_valuation.py would write)
  * agent_heartbeats journal rows for every daily buyer run + weekly
    reviewer run

The trade tape, holdings, cash and daily snapshots all reconcile — the
script verifies the chain before writing and refuses to seed a portfolio
that doesn't satisfy the demo constraints:

  * >10 equities in every daily snapshot (buys 14 names on day one)
  * >8% growth over the trailing 30 days, measured exactly the way the
    leaderboard measures it (latest snapshot vs the snapshot 30 days ago)

The >8% constraint is met by SELECTION, not invention: the basket is chosen
from real Tier 1 names whose actual price history over the window produces
the return. Every fill price is a genuine close.

Usage:
    python seed_dummy_portfolio.py --dry-run        # plan + verify only
    python seed_dummy_portfolio.py                  # create the portfolio
    python seed_dummy_portfolio.py --teardown       # remove it again

Flags: --slug, --display-name, --owner-name, --email, --days,
       --target-30d, --seed, --dry-run, --teardown
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
import uuid
from datetime import date, datetime, timedelta, timezone

from db import SupabaseDB
from theses import _SNAPSHOT_FIELDS

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger("seed_dummy_portfolio")

# ---------------------------------------------------------------------------
# Defaults / fixed copy
# ---------------------------------------------------------------------------

DEFAULT_SLUG = "mara-v1"
DEFAULT_DISPLAY_NAME = "MARA v1"
DEFAULT_OWNER_NAME = "Morgan Hale"
DEFAULT_EMAIL = "morgan.demo@alphamolt.ai"
DEFAULT_DAYS = 45          # calendar days of history (>=42 so 30d anchor exists)
DEFAULT_TARGET_30D = 10.5  # selection target %, must come out > 8 after sim

STARTING_CASH = 1_000_000.00

BUYER_HANDLES = ("buyer-claude", "buyer-gemini")
REVIEWER_HANDLE = "portfolio-reviewer"

MANDATE = "Make America Rich Again!  Only winners, sell all losers"

SCREEN_CONFIG = {
    "filters": [
        {"field": "rule_of_40", "op": ">=", "value": 30},
        {"field": "gross_margin", "op": ">=", "value": 0.40},
        {"field": "country", "op": "==", "value": "United States"},
    ],
    "weights": {"quality": 60, "value": 15, "momentum": 25},
    "aiMultiplier": True,
    "topN": 30,
}

BUYER_CONFIG = {"target_position_pct": 6}
REVIEWER_CONFIG = {"sell_conviction_threshold": 4}

LIFECYCLE_KEYS = ("a1_welcome", "a2_setup_nudge")

# Trade-plan shape (trading-day indexes into the window's trading calendar)
INITIAL_BUYS = 14            # day-one snake draft
ADD_DAYS = (5, 9, 14)        # one new name on each of these trading days
TOPUP_DAY = 18               # add to the best performer so far
SELL_AFTER_CAL_DAYS = 21     # reviewer exit ~3 weeks in (first trading day after)
FINAL_NAMES = INITIAL_BUYS + len(ADD_DAYS)  # before the one reviewer exit


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _utc(d: date, hh: int, mm: int, ss: int) -> str:
    return datetime(d.year, d.month, d.day, hh, mm, ss, tzinfo=timezone.utc).isoformat()


def _fetch_all(builder_fn, page: int = 1000) -> list[dict]:
    """Paginate a PostgREST query past the server max-rows cap."""
    rows: list[dict] = []
    offset = 0
    while True:
        resp = builder_fn().range(offset, offset + page - 1).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < page:
            return rows
        offset += page


def _num(v) -> float | None:
    return SupabaseDB.safe_float(v)


def _fmt_metric(v, suffix="%") -> str:
    f = _num(v)
    return f"{f:.0f}{suffix}" if f is not None else "n/a"


# ---------------------------------------------------------------------------
# Thesis / rationale copy generators (template prose over real metrics)
# ---------------------------------------------------------------------------


def make_rationale(company: dict, rng: random.Random) -> str:
    growth = _fmt_metric(company.get("rev_growth_ttm_pct"))
    gm = _fmt_metric(company.get("gross_margin_pct"))
    r40 = _fmt_metric(company.get("rule_of_40"), suffix="")
    sector = company.get("sector") or "its sector"
    templates = [
        f"{growth} TTM growth at {gm} gross margin (Rule of 40: {r40}); "
        f"category leader in {sector.lower()}",
        f"Durable compounder — Rule of 40 of {r40} with {gm} gross margin "
        f"and {growth} TTM revenue growth",
        f"Quality screen standout: {growth} growth, {gm} gross margin, "
        f"reasonable entry vs its own P/S history",
        f"Best-in-class {sector.lower()} economics ({gm} GM, R40 {r40}) "
        f"with momentum confirming",
    ]
    return rng.choice(templates)


def make_thesis_text(company: dict, rng: random.Random) -> str:
    name = company.get("company_name") or company["ticker"]
    growth = _fmt_metric(company.get("rev_growth_ttm_pct"))
    gm = _fmt_metric(company.get("gross_margin_pct"))
    fcf = _fmt_metric(company.get("fcf_margin_pct"))
    r40 = _fmt_metric(company.get("rule_of_40"), suffix="")
    closers = [
        "Expect the multiple to hold while revenue compounds; the position "
        "pays off through execution, not re-rating.",
        "Entry near its own valuation history gives a margin of safety if "
        "growth merely persists.",
        "Operating leverage should keep dropping through to free cash flow "
        "as the business scales.",
    ]
    return (
        f"{name} pairs {growth} TTM revenue growth with {gm} gross margins "
        f"and {fcf} FCF margin (Rule of 40: {r40}) — a winner by the "
        f"mandate's bar. {rng.choice(closers)}"
    )


def make_signals(company: dict) -> tuple[list[dict], list[dict]]:
    growth = _num(company.get("rev_growth_ttm_pct"))
    extend = [
        {
            "field": "rev_growth_ttm_pct",
            "op": "change_pct_gt",
            "value": 5,
            "description": "TTM revenue growth accelerates >5pp from purchase",
        },
        {
            "field": "fcf_margin_pct",
            "op": "change_pct_gt",
            "value": 3,
            "description": "FCF margin expands >3pp from purchase",
        },
    ]
    brk = [
        {
            "field": "rule_of_40",
            "op": "change_pct_lt",
            "value": -15,
            "description": "Rule of 40 deteriorates >15pts from purchase",
        },
        {
            "field": "gross_margin_pct",
            "op": "change_pct_lt",
            "value": -5,
            "description": "Gross margin compresses >5pp from purchase",
        },
    ]
    if growth is not None and growth > 10:
        brk.append({
            "field": "rev_growth_ttm_pct",
            "op": "<",
            "value": round(growth / 2, 1),
            "description": f"TTM growth halves from {growth:.0f}%",
        })
    return extend, brk


def adjust_snapshot_to_fill(snapshot: dict, fill: float) -> dict:
    """Scale the price-linked snapshot fields to the historical fill price so
    the frozen state is coherent with the trade tape."""
    current = _num(snapshot.get("price"))
    out = dict(snapshot)
    out["price"] = round(fill, 4)
    if current and current > 0:
        ratio = fill / current
        ps = _num(snapshot.get("ps_now"))
        if ps is not None:
            out["ps_now"] = round(ps * ratio, 2)
        pct_high = _num(snapshot.get("price_pct_of_52w_high"))
        if pct_high is not None:
            out["price_pct_of_52w_high"] = round(min(pct_high * ratio, 100.0), 1)
    return out


# ---------------------------------------------------------------------------
# Price history
# ---------------------------------------------------------------------------


class PriceBook:
    """Per-ticker {date -> close} with last-known-close lookups."""

    def __init__(self) -> None:
        self.by_ticker: dict[str, dict[date, float]] = {}

    def add(self, ticker: str, d: date, close: float) -> None:
        self.by_ticker.setdefault(ticker, {})[d] = close

    def close_on(self, ticker: str, d: date) -> float | None:
        return self.by_ticker.get(ticker, {}).get(d)

    def last_close_on_or_before(self, ticker: str, d: date) -> float | None:
        series = self.by_ticker.get(ticker)
        if not series:
            return None
        best = None
        for k in series:
            if k <= d and (best is None or k > best):
                best = k
        return series.get(best) if best else None


def load_universe(db: SupabaseDB, window_start: date):
    """Candidate companies + their real daily closes over the window."""
    companies = _fetch_all(
        lambda: db.client.table("companies")
        .select("*")
        .eq("in_tv_screen", True)
        .not_.is_("price", "null")
        .not_.is_("sort_order", "null")
        .order("sort_order")
    )
    companies = companies[:160]
    by_ticker = {c["ticker"]: c for c in companies}
    tickers = list(by_ticker)

    book = PriceBook()
    since = (window_start - timedelta(days=10)).isoformat()
    for i in range(0, len(tickers), 50):
        chunk = tickers[i : i + 50]
        rows = _fetch_all(
            lambda c=chunk: db.client.table("prices_daily")
            .select("ticker,date,close")
            .in_("ticker", c)
            .gte("date", since)
            .order("date")
        )
        for r in rows:
            close = _num(r.get("close"))
            if close and close > 0:
                book.add(r["ticker"], date.fromisoformat(r["date"]), close)

    # Trading calendar = dates seen for at least half the priced tickers.
    counts: dict[date, int] = {}
    for series in book.by_ticker.values():
        for d in series:
            counts[d] = counts.get(d, 0) + 1
    n_priced = max(1, len(book.by_ticker))
    trading_days = sorted(d for d, n in counts.items() if n >= n_priced * 0.5)
    return by_ticker, book, trading_days


def coverage_ok(book: PriceBook, ticker: str, days: list[date]) -> bool:
    series = book.by_ticker.get(ticker, {})
    if not series:
        return False
    missing = sum(1 for d in days if d not in series)
    if missing > max(2, len(days) // 20):
        return False
    # Drop split/halt suspects: any |day-over-day| move > 35%.
    closes = [series[d] for d in days if d in series]
    for a, b in zip(closes, closes[1:]):
        if a > 0 and abs(b / a - 1) > 0.35:
            return False
    return True


# ---------------------------------------------------------------------------
# Plan + simulate
# ---------------------------------------------------------------------------


class Plan:
    """Everything to be written, fully simulated in memory first."""

    def __init__(self) -> None:
        self.trades: list[dict] = []          # row dicts + private _ keys
        self.holdings: dict[str, dict] = {}   # ticker -> {qty, avg_cost, first_ts, opened_by}
        self.cash = STARTING_CASH
        self.history: list[dict] = []
        self.heartbeats: list[dict] = []
        self.sold_ticker: str | None = None
        self.sell_ts: str | None = None
        self.topup_ticker: str | None = None
        self.ret_30d: float | None = None
        self.ret_inception: float | None = None
        self.min_positions: int | None = None
        self.final_value: float | None = None


def build_trade_plan(
    basket: list[str],
    by_ticker: dict[str, dict],
    book: PriceBook,
    trading_days: list[date],
    buyer_ids: list[str],
    reviewer_id: str,
    rng: random.Random,
    weights: dict[str, float] | None = None,
) -> Plan:
    plan = Plan()
    first_day = trading_days[0]
    weights = weights or {}

    def fill_price(ticker: str, d: date) -> float | None:
        # Heartbeat trades at 07:00 UTC fill at companies.price = the
        # previous trading day's close.
        prev = d - timedelta(days=1)
        return book.last_close_on_or_before(ticker, prev)

    def snake_buyer(i: int) -> str:
        # A B B A A B B A ... (snake draft order across two buyers)
        return buyer_ids[(0, 1, 1, 0)[i % 4]]

    def do_buy(ticker: str, d: date, target_pct: float, seq: int, buyer: str,
               conviction: int) -> None:
        px = fill_price(ticker, d)
        if px is None or px <= 0:
            raise RuntimeError(f"no fill price for {ticker} on {d}")
        # Keep a ~1.5% cash reserve (mirrors the buyers' reserve convention);
        # skip rather than open a token-sized position.
        alloc = STARTING_CASH * target_pct / 100.0
        alloc = min(alloc, plan.cash - 0.015 * STARTING_CASH)
        if alloc < 0.005 * STARTING_CASH:
            return
        qty = int(alloc // px)
        if qty < 1:
            return
        gross = round(qty * px, 2)
        plan.cash = round(plan.cash - gross, 2)
        secs = 125 + seq * 7  # fills staggered a few seconds apart from 07:02
        ts = _utc(d, 7, secs // 60, secs % 60)
        company = by_ticker[ticker]
        rationale = make_rationale(company, rng)
        h = plan.holdings.get(ticker)
        if h:
            new_qty = h["qty"] + qty
            h["avg_cost"] = round((h["qty"] * h["avg_cost"] + qty * px) / new_qty, 4)
            h["qty"] = new_qty
        else:
            plan.holdings[ticker] = {
                "qty": qty, "avg_cost": round(px, 4),
                "first_ts": ts, "opened_by": buyer,
            }
        plan.trades.append({
            "agent_id": buyer,
            "ticker": ticker,
            "side": "buy",
            "quantity": qty,
            "price_usd": round(px, 4),
            "gross_usd": gross,
            "cash_after_usd": plan.cash,
            "executed_at": ts,
            "note": f"swarm draft (conviction {conviction}/5): {rationale}",
            "_rationale": rationale,
            "_date": d,
        })

    # --- Day one: snake-draft 14 names ------------------------------------
    for i, ticker in enumerate(basket[:INITIAL_BUYS]):
        pct = weights.get(ticker, 5.9) + rng.uniform(-0.15, 0.15)
        do_buy(
            ticker, first_day, target_pct=pct,
            seq=i, buyer=snake_buyer(i), conviction=5 if i < 8 else 4,
        )

    # --- Adds: one new name on each add day --------------------------------
    add_names = basket[INITIAL_BUYS:FINAL_NAMES]
    for j, (idx, ticker) in enumerate(zip(ADD_DAYS, add_names)):
        if idx >= len(trading_days):
            break
        do_buy(
            ticker, trading_days[idx], target_pct=4.4 + rng.uniform(-0.4, 0.6),
            seq=j, buyer=buyer_ids[j % 2], conviction=5,
        )

    # --- Reviewer exit ~3 weeks in: worst performer to date ----------------
    sell_day = next(
        (d for d in trading_days
         if d >= trading_days[0] + timedelta(days=SELL_AFTER_CAL_DAYS)),
        None,
    )
    if sell_day:
        def ret_to(t: str) -> float:
            px = book.last_close_on_or_before(t, sell_day - timedelta(days=1))
            h = plan.holdings[t]
            return (px / h["avg_cost"] - 1) if px else 0.0

        worst = min(list(plan.holdings)[:INITIAL_BUYS], key=ret_to)
        px = book.last_close_on_or_before(worst, sell_day - timedelta(days=1))
        h = plan.holdings.pop(worst)
        gross = round(h["qty"] * px, 2)
        plan.cash = round(plan.cash + gross, 2)
        ts = _utc(sell_day, 7, 11, 42)
        rationale = (
            "the position is a loser since purchase — momentum and relative "
            "strength have deteriorated, and the mandate is explicit: sell "
            "all losers"
        )
        plan.trades.append({
            "agent_id": reviewer_id,
            "ticker": worst,
            "side": "sell",
            "quantity": h["qty"],
            "price_usd": round(px, 4),
            "gross_usd": gross,
            "cash_after_usd": plan.cash,
            "executed_at": ts,
            "note": f"portfolio-reviewer drift ({rationale[:80]})",
            "_rationale": rationale,
            "_date": sell_day,
        })
        plan.sold_ticker = worst
        plan.sell_ts = ts

    # --- Top-up the best performer so far ----------------------------------
    if TOPUP_DAY < len(trading_days):
        topup_day = trading_days[TOPUP_DAY]

        def ret_at(t: str) -> float:
            px = book.last_close_on_or_before(t, topup_day - timedelta(days=1))
            return (px / plan.holdings[t]["avg_cost"] - 1) if px else 0.0

        best = max(plan.holdings, key=ret_at)
        plan.topup_ticker = best
        do_buy(best, topup_day, target_pct=2.4 + rng.uniform(0, 0.5),
               seq=9, buyer=plan.holdings[best]["opened_by"], conviction=5)

    return plan


def simulate_history(
    plan: Plan,
    by_ticker: dict[str, dict],
    book: PriceBook,
    inception: date,
    today: date,
) -> None:
    """Daily MTM snapshots from the trade tape + real closes. Today is valued
    at companies.price, exactly like portfolio_valuation.py would."""
    plan.history = []
    d = inception
    while d <= today:
        cash = STARTING_CASH
        pos: dict[str, float] = {}
        for t in plan.trades:
            if t["_date"] > d:
                continue
            cash = t["cash_after_usd"]
            q = pos.get(t["ticker"], 0.0)
            pos[t["ticker"]] = q + t["quantity"] if t["side"] == "buy" else q - t["quantity"]
        pos = {k: v for k, v in pos.items() if v > 1e-9}

        hv = 0.0
        for ticker, qty in pos.items():
            if d == today:
                px = _num(by_ticker[ticker].get("price")) or \
                    book.last_close_on_or_before(ticker, d)
            else:
                px = book.last_close_on_or_before(ticker, d)
            hv += qty * (px or 0.0)
        hv = round(hv, 2)
        total = round(cash + hv, 2)
        pnl = round(total - STARTING_CASH, 2)
        plan.history.append({
            "snapshot_date": d.isoformat(),
            "cash_usd": round(cash, 2),
            "holdings_value_usd": hv,
            "total_value_usd": total,
            "pnl_usd": pnl,
            "pnl_pct": round(pnl / STARTING_CASH * 100, 4),
            "num_positions": len(pos),
        })
        d += timedelta(days=1)

    plan.min_positions = min(r["num_positions"] for r in plan.history)
    plan.final_value = plan.history[-1]["total_value_usd"]
    plan.ret_inception = plan.history[-1]["pnl_pct"]
    anchor_date = (today - timedelta(days=30)).isoformat()
    anchor = max(
        (r for r in plan.history if r["snapshot_date"] <= anchor_date),
        key=lambda r: r["snapshot_date"],
        default=None,
    )
    if anchor and anchor["total_value_usd"] > 0:
        plan.ret_30d = round(
            (plan.final_value / anchor["total_value_usd"] - 1) * 100, 4
        )


def build_heartbeats(
    plan: Plan,
    portfolio_id: str,
    buyers: list[dict],
    reviewer: dict,
    inception: date,
    today: date,
    rng: random.Random,
) -> None:
    """Journal rows mirroring the swarm path: buyers daily, reviewer weekly."""
    buys_by_day_agent: dict[tuple[str, str], int] = {}
    sells_by_day: dict[str, int] = {}
    for t in plan.trades:
        day = t["_date"].isoformat()
        if t["side"] == "buy":
            key = (day, t["agent_id"])
            buys_by_day_agent[key] = buys_by_day_agent.get(key, 0) + 1
        else:
            sells_by_day[day] = sells_by_day.get(day, 0) + 1

    rows: list[dict] = []
    d = inception
    while d <= today:
        day = d.isoformat()
        for b in buyers:
            n = buys_by_day_agent.get((day, b["id"]), 0)
            started = _utc(d, 7, 0, rng.randint(30, 55))
            rows.append({
                "agent_id": b["id"],
                "strategy": b.get("strategy") or "llm_watchlist_buyer",
                "started_at": started,
                "finished_at": _utc(d, 7, rng.randint(1, 3), rng.randint(0, 59)),
                "status": "ok",
                "trades_executed": n,
                "buys": n,
                "sells": 0,
                "notes": {"portfolio_id": portfolio_id, "role": "buyer",
                          "remit": None},
            })
        run_reviewer = ((d - inception).days % 7 == 0) or day in sells_by_day
        if run_reviewer:
            n_sell = sells_by_day.get(day, 0)
            notes = {
                "portfolio_id": portfolio_id,
                "role": "reviewer",
                "positions_reviewed": max(
                    (r["num_positions"] for r in plan.history
                     if r["snapshot_date"] == day), default=0,
                ),
            }
            if n_sell == 0:
                notes["reason"] = "no positions met the sell threshold"
            rows.append({
                "agent_id": reviewer["id"],
                "strategy": reviewer.get("strategy") or "portfolio_reviewer",
                "started_at": _utc(d, 7, 8, rng.randint(0, 40)),
                "finished_at": _utc(d, 7, rng.randint(12, 16), rng.randint(0, 59)),
                "status": "ok",
                "trades_executed": n_sell,
                "buys": 0,
                "sells": n_sell,
                "notes": notes,
            })
        d += timedelta(days=1)
    plan.heartbeats = rows


# ---------------------------------------------------------------------------
# Basket selection — meet the 30d-return constraint with real names
# ---------------------------------------------------------------------------


def select_basket(
    by_ticker: dict[str, dict],
    book: PriceBook,
    trading_days: list[date],
    buyer_ids: list[str],
    reviewer_id: str,
    today: date,
    target_30d: float,
    rng: random.Random,
) -> tuple[list[str], Plan]:
    anchor_day = today - timedelta(days=30)
    last_day = trading_days[-1]

    eligible: list[dict] = []
    for ticker, company in by_ticker.items():
        if not coverage_ok(book, ticker, trading_days):
            continue
        entry = book.last_close_on_or_before(
            ticker, trading_days[0] - timedelta(days=1)
        )
        anchor = book.last_close_on_or_before(ticker, anchor_day)
        last = book.last_close_on_or_before(ticker, last_day)
        if not entry or not anchor or not last:
            continue
        eligible.append({
            "ticker": ticker,
            "ret_30": last / anchor - 1,
            "ret_window": last / entry - 1,
            "rank": company.get("sort_order") or 9999,
        })

    need = FINAL_NAMES + 2
    if len(eligible) < need:
        raise RuntimeError(
            f"only {len(eligible)} tickers have usable price history — "
            "cannot build the basket"
        )

    winners = sorted(eligible, key=lambda e: -e["ret_30"])
    by_rank = sorted(eligible, key=lambda e: e["rank"])

    ret_30 = {e["ticker"]: e["ret_30"] for e in eligible}
    for k_win in range(10, FINAL_NAMES + 1):
        chosen = [w["ticker"] for w in winners[:k_win]]
        for e in by_rank:
            if len(chosen) >= FINAL_NAMES:
                break
            if e["ticker"] not in chosen and e["ret_30"] > -0.08:
                chosen.append(e["ticker"])
        # Day-one draft = the 14 strongest trailing-30d names, overweighted
        # linearly from ~7.0% down to ~4.8% (mean ≈ 5.9%, ~83% deployed);
        # the rest arrive as later adds.
        chosen.sort(key=lambda t: -ret_30[t])
        initial = chosen[:INITIAL_BUYS]
        weights = {
            t: 7.0 - 2.2 * i / max(1, INITIAL_BUYS - 1)
            for i, t in enumerate(initial)
        }
        plan = build_trade_plan(
            chosen, by_ticker, book, trading_days, buyer_ids, reviewer_id,
            random.Random(rng.random()), weights=weights,
        )
        simulate_history(plan, by_ticker, book, trading_days[0], today)
        logger.info(
            "selection attempt k_win=%d → 30d %.2f%%, min positions %d",
            k_win, plan.ret_30d or 0, plan.min_positions or 0,
        )
        if (plan.ret_30d or 0) >= target_30d and (plan.min_positions or 0) > 10:
            return chosen, plan

    raise RuntimeError(
        "could not assemble a basket meeting the 30d-return target from real "
        "price history — try --days a few higher/lower or lower --target-30d"
    )


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def ensure_owner(db: SupabaseDB, email: str, owner_name: str,
                 backdate: date) -> str:
    """Create (or reuse) the dummy auth user + profile. Returns user id."""
    existing = (
        db.client.table("profiles").select("id").eq("email", email)
        .limit(1).execute().data
    )
    if existing:
        user_id = existing[0]["id"]
        logger.info("Reusing existing profile %s for %s", user_id, email)
    else:
        resp = db.client.auth.admin.create_user({
            "email": email,
            "email_confirm": True,
            "user_metadata": {"display_name": owner_name},
        })
        user_id = resp.user.id
        logger.info("Created auth user %s (%s)", user_id, email)

    db.client.table("profiles").update({
        "display_name": owner_name,
        "created_at": _utc(backdate, 9, 14, 3),
    }).eq("id", user_id).execute()

    # Seed the lifecycle-email ledger so the cron never emails the dummy.
    for key in LIFECYCLE_KEYS:
        db.client.table("lifecycle_email_sends").upsert(
            {"user_id": user_id, "email_key": key, "recipient": email,
             "sent_at": _utc(backdate, 9, 20, 0)},
            on_conflict="user_id,email_key",
        ).execute()
    return user_id


def write_plan(
    db: SupabaseDB,
    plan: Plan,
    *,
    slug: str,
    display_name: str,
    owner_user_id: str,
    by_ticker: dict[str, dict],
    buyers: list[dict],
    reviewer: dict,
    inception: date,
    rng: random.Random,
    portfolio_id: str,
) -> str:
    last_hb = plan.heartbeats[-1]["started_at"]
    created_ts = _utc(inception, 6, 45, 12)

    db.client.table("portfolios").insert({
        "id": portfolio_id,
        "slug": slug,
        "display_name": display_name,
        "description": MANDATE,
        "owner_user_id": owner_user_id,
        "is_public": False,            # flipped after holdings exist
        "mode": "paper",
        "screen_config": SCREEN_CONFIG,
        "created_at": created_ts,
        "last_heartbeat_at": last_hb,
    }).execute()
    logger.info("portfolios row %s (slug=%s)", portfolio_id, slug)

    db.client.table("portfolio_accounts").insert({
        "portfolio_id": portfolio_id,
        "starting_cash": STARTING_CASH,
        "cash_usd": plan.cash,
        "inception_date": inception.isoformat(),
        "created_at": created_ts,
    }).execute()

    members = [
        (b, "buyer", BUYER_CONFIG) for b in buyers
    ] + [(reviewer, "reviewer", REVIEWER_CONFIG)]
    for agent, role, config in members:
        db.client.table("portfolio_agents").insert({
            "portfolio_id": portfolio_id,
            "agent_id": agent["id"],
            "role": role,
            "config": config,
            "enabled": True,
            "joined_at": created_ts,
            "last_heartbeat_at": last_hb,
        }).execute()
    logger.info("team: %s", ", ".join(a["handle"] for a, _, _ in members))

    # Trade tape + theses. The AFTER INSERT trigger on agent_trades is a
    # no-op for these agents (no agent_accounts row — verified upstream).
    superseded: dict[str, int] = {}  # ticker -> prior thesis id
    thesis_ids: dict[str, int] = {}
    for t in plan.trades:
        row = {k: v for k, v in t.items() if not k.startswith("_")}
        row["portfolio_id"] = portfolio_id
        trade_id = db.insert_agent_trade(row)

        if t["side"] == "buy":
            company = by_ticker[t["ticker"]]
            prior = thesis_ids.get(t["ticker"])
            if prior:
                db.client.table("investment_theses").update({
                    "status": "superseded",
                    "status_changed_at": t["executed_at"],
                }).eq("id", prior).execute()
                superseded[t["ticker"]] = prior
            snapshot = adjust_snapshot_to_fill(
                {k: company.get(k) for k in _SNAPSHOT_FIELDS},
                float(t["price_usd"]),
            )
            extend, brk = make_signals(company)
            resp = db.client.table("investment_theses").insert({
                "agent_id": t["agent_id"],
                "portfolio_id": portfolio_id,
                "ticker": t["ticker"],
                "trade_id": trade_id,
                "snapshot": snapshot,
                "thesis_text": make_thesis_text(company, rng),
                "extend_signals": extend,
                "break_signals": brk,
                "source": "agent",
                "status": "active",
                "opened_at": t["executed_at"],
                "status_changed_at": t["executed_at"],
            }).execute()
            thesis_ids[t["ticker"]] = (resp.data or [{}])[0].get("id")
        else:
            # Reviewer exit: thesis marked broken just before the sell —
            # exactly the order portfolio_reviewer.py writes it.
            tid = thesis_ids.get(t["ticker"])
            if tid:
                db.client.table("investment_theses").update({
                    "status": "broken",
                    "status_changed_at": t["executed_at"],
                }).eq("id", tid).execute()
    logger.info("%d trades + %d theses written", len(plan.trades), len(thesis_ids))

    for ticker, h in plan.holdings.items():
        db.client.table("portfolio_holdings").insert({
            "portfolio_id": portfolio_id,
            "ticker": ticker,
            "quantity": h["qty"],
            "avg_cost_usd": h["avg_cost"],
            "first_bought_at": h["first_ts"],
            "opened_by_agent_id": h["opened_by"],
        }).execute()
    logger.info("%d holdings written", len(plan.holdings))

    for row in plan.history:
        db.upsert_portfolio_snapshot({**row, "portfolio_id": portfolio_id})
    logger.info("%d daily snapshots written", len(plan.history))

    for row in plan.heartbeats:
        db.insert_agent_heartbeat(row)
    logger.info("%d heartbeat journal rows written", len(plan.heartbeats))

    # ≥15 holdings now exist, so the public-threshold trigger allows this.
    db.client.table("portfolios").update({"is_public": True}).eq(
        "id", portfolio_id
    ).execute()
    logger.info("portfolio flipped public")
    return portfolio_id


# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------


def teardown(db: SupabaseDB, slug: str, email: str) -> None:
    portfolio = db.get_portfolio_by_slug(slug)
    if not portfolio:
        logger.info("No portfolio with slug=%s — nothing to tear down", slug)
        return
    owner = portfolio.get("owner_user_id")
    if not owner:
        raise RuntimeError(f"{slug} is not a human portfolio — refusing teardown")
    prof = (
        db.client.table("profiles").select("email").eq("id", owner)
        .limit(1).execute().data
    )
    if not prof or prof[0].get("email") != email:
        raise RuntimeError(
            f"{slug} is owned by {prof[0].get('email') if prof else '?'} — "
            f"not the dummy owner {email}; refusing teardown"
        )
    pid = portfolio["id"]
    db.client.table("agent_heartbeats").delete().eq(
        "notes->>portfolio_id", pid
    ).execute()
    # portfolios cascade removes account, holdings, members, trades,
    # theses and history.
    db.client.table("portfolios").delete().eq("id", pid).execute()
    db.client.table("lifecycle_email_sends").delete().eq("user_id", owner).execute()
    db.client.table("profiles").delete().eq("id", owner).execute()
    try:
        db.client.auth.admin.delete_user(owner)
    except Exception as exc:  # noqa: BLE001
        logger.warning("auth user delete failed (profile already gone): %s", exc)
    logger.info("Tore down portfolio %s (%s) and owner %s", slug, pid, email)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--slug", default=DEFAULT_SLUG)
    ap.add_argument("--display-name", default=DEFAULT_DISPLAY_NAME)
    ap.add_argument("--owner-name", default=DEFAULT_OWNER_NAME)
    ap.add_argument("--email", default=DEFAULT_EMAIL)
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help="calendar days of history (default 45)")
    ap.add_argument("--target-30d", type=float, default=DEFAULT_TARGET_30D,
                    help="selection target for trailing-30d return (%%)")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--teardown", action="store_true")
    args = ap.parse_args()

    db = SupabaseDB()

    if args.teardown:
        teardown(db, args.slug, args.email)
        return 0

    if args.days < 42:
        ap.error("--days must be >= 42 so a 30d-ago snapshot anchor exists")

    if db.get_portfolio_by_slug(args.slug):
        logger.error(
            "Portfolio slug=%s already exists — run --teardown first", args.slug
        )
        return 1

    rng = random.Random(args.seed if args.seed is not None else args.slug)

    # House agents to hire; they must have NO agent_accounts row (otherwise
    # the agent_trades AFTER INSERT trigger would write spurious snapshots
    # into their own legacy history when we insert back-dated trades).
    buyers, reviewer = [], None
    for handle in (*BUYER_HANDLES, REVIEWER_HANDLE):
        agent = db.get_agent_by_handle(handle)
        if not agent:
            logger.error("House agent %s not found — cannot build the team", handle)
            return 1
        if db.get_agent_account(agent["id"]):
            logger.error(
                "Agent %s has an agent_accounts row — back-dated trades would "
                "pollute its own snapshot history via the recompute trigger. "
                "Aborting.", handle,
            )
            return 1
        if handle == REVIEWER_HANDLE:
            reviewer = agent
        else:
            buyers.append(agent)

    today = date.today()
    window_start = today - timedelta(days=args.days)
    by_ticker, book, all_days = load_universe(db, window_start)
    trading_days = [d for d in all_days if d >= window_start]
    if len(trading_days) < 28:
        logger.error(
            "Only %d trading days of prices_daily history in the window — "
            "not enough to fabricate 30+ days", len(trading_days),
        )
        return 1
    inception = trading_days[0]
    logger.info(
        "Window: %s → %s (%d trading days), %d candidate tickers",
        inception, today, len(trading_days), len(by_ticker),
    )

    basket, plan = select_basket(
        by_ticker, book, trading_days,
        [b["id"] for b in buyers], reviewer["id"],
        today, args.target_30d, rng,
    )

    # ---- Verification: the records must add up + meet the constraints ----
    recomputed_cash = STARTING_CASH
    for t in plan.trades:
        delta = t["gross_usd"] if t["side"] == "sell" else -t["gross_usd"]
        recomputed_cash = round(recomputed_cash + delta, 2)
        assert abs(recomputed_cash - t["cash_after_usd"]) < 0.01, "cash chain broken"
    assert abs(recomputed_cash - plan.cash) < 0.01
    qty_check: dict[str, float] = {}
    for t in plan.trades:
        q = qty_check.get(t["ticker"], 0)
        qty_check[t["ticker"]] = q + t["quantity"] if t["side"] == "buy" else q - t["quantity"]
    qty_check = {k: v for k, v in qty_check.items() if v > 1e-9}
    assert qty_check == {k: h["qty"] for k, h in plan.holdings.items()}, \
        "holdings don't match trade tape"
    assert (plan.ret_30d or 0) > 8.0, f"30d return {plan.ret_30d}% <= 8%"
    assert (plan.min_positions or 0) > 10, "fewer than 11 equities at some point"
    assert plan.cash >= 0
    assert len(plan.holdings) >= 15, "needs >=15 holdings to flip public"

    portfolio_id = str(uuid.uuid4())
    build_heartbeats(plan, portfolio_id, buyers, reviewer, inception, today, rng)

    logger.info("=" * 70)
    logger.info("PLAN VERIFIED")
    logger.info("  inception        %s   (%d calendar days ago)", inception,
                (today - inception).days)
    logger.info("  trades           %d (%d buys, 1 reviewer sell)",
                len(plan.trades), len(plan.trades) - 1)
    logger.info("  holdings         %d names, cash $%.2f (%.1f%% of book)",
                len(plan.holdings), plan.cash,
                plan.cash / plan.final_value * 100)
    logger.info("  final value      $%.2f  (%+.2f%% since inception)",
                plan.final_value, plan.ret_inception)
    logger.info("  trailing 30d     %+.2f%%  (constraint: > 8%%)", plan.ret_30d)
    logger.info("  min positions    %d  (constraint: > 10)", plan.min_positions)
    logger.info("  sold position    %s on %s", plan.sold_ticker,
                (plan.sell_ts or "")[:10])
    logger.info("  topped up        %s", plan.topup_ticker)
    for t in plan.trades:
        logger.info(
            "    %s %-4s %-6s x%-5d @ %9.2f  cash_after %12.2f",
            t["_date"], t["side"].upper(), t["ticker"], t["quantity"],
            t["price_usd"], t["cash_after_usd"],
        )
    logger.info("=" * 70)

    if args.dry_run:
        logger.info("[dry-run] no rows written")
        return 0

    owner_id = ensure_owner(db, args.email, args.owner_name,
                            inception - timedelta(days=1))
    write_plan(
        db, plan,
        slug=args.slug, display_name=args.display_name,
        owner_user_id=owner_id, by_ticker=by_ticker,
        buyers=buyers, reviewer=reviewer, inception=inception, rng=rng,
        portfolio_id=portfolio_id,
    )

    logger.info(
        "DONE — portfolio '%s' live at /portfolios/%s (id=%s), owner %s",
        args.display_name, args.slug, portfolio_id, args.email,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
