"""Pelosi-mirror strategy core.

A "copy-trade a member of Congress" buyer for human portfolios. It does NOT
rank the screen like the other buyers — it brings its OWN candidate feed: the
disclosed stock transactions of a named politician (default *Nancy Pelosi*),
parsed from the House Clerk's Periodic Transaction Reports by
``congress_trades.py`` into the ``congress_trades`` table.

Mirror semantics (the design the owner chose):

- **Buys and sells.** A disclosed purchase opens / tops the name up to a
  settable ``target_position_pct``; a disclosed sale exits a held name in full.
- **Options → the underlying.** Her signature trades are deep-in-the-money
  LEAPS calls. A long-only equity book can't hold an option, so an option
  transaction mirrors as the *underlying common stock* (buy on a call purchase
  / exercise, sell on a disposal). ``congress_trades`` already records the
  underlying ticker for ``[OP]`` rows, so this layer is option-agnostic.
- **Gifts / charitable contributions are not market signals** and are dropped
  upstream (``congress_trades.is_gift``); this layer defends against any that
  slip through anyway.

Idempotency is durable, not heuristic: every disclosed transaction this
(portfolio, agent) pair acts on — or deliberately skips — is written to
``congress_mirror_log``. A re-run only ever sees transactions it has never
logged, so the heartbeat is safe to retry and a freshly-hired agent replays at
most ``lookback_days`` of history rather than years of it.

The decision core (`plan_mirror`) is pure — trades + book in, a plan out — so
it is unit-tested without a DB or a broker (`test_pelosi_mirror.py`). The
``rebalance_pelosi_mirror`` wrapper does the IO and trades through the standard
``ctx.buy``/``ctx.sell`` facade, so it works on a paper book or (live-flagged)
a real Alpaca account exactly like every other strategy.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import TYPE_CHECKING

from portfolio import PortfolioError

if TYPE_CHECKING:  # avoid a runtime import cycle with agent_strategies
    from agent_strategies import RebalanceContext, RebalanceResult

logger = logging.getLogger(__name__)


PELOSI_MIRROR_DEFAULTS = {
    "politician": "Nancy Pelosi",   # whose disclosures to mirror
    "target_position_pct": 5.0,     # size each mirrored name to this % of NAV
    "lookback_days": 60,            # on first run, ignore disclosures older than this
    "min_trade_usd": 500.0,         # ignore sub-noise rebalance deltas
    "cash_reserve_pct": 0.02,       # keep a little cash for rounding / drift
    "max_positions": 30,            # don't open past this many holdings
    # What to do when she buys a name the portfolio ALREADY holds:
    #   "skip"   — don't double up; only ever open NEW positions (default).
    #   "top_up" — add toward `target_position_pct` if currently underweight.
    "when_held": "skip",
}


# ---------------------------------------------------------------------------
# Pure decision core
# ---------------------------------------------------------------------------


@dataclass
class MirrorPlan:
    """A planned set of mirror actions over a batch of disclosed trades."""

    buys: list[dict] = field(default_factory=list)   # {ticker, qty, trade_ids, why}
    sells: list[dict] = field(default_factory=list)  # {ticker, qty, trade_ids, why}
    # trade_ids we touched but deliberately did not act on, with a reason.
    skips: list[dict] = field(default_factory=list)  # {trade_ids, ticker, reason}


def _net_action_by_ticker(trades: list[dict]) -> dict[str, dict]:
    """Collapse a batch of disclosures to one net action per ticker.

    A single report often lists several rows for one name (e.g. an option buy,
    a share sale and an exercise of NVDA in one filing). Mirroring each in turn
    would thrash the book, so we take the **latest** transaction for each
    ticker as the net intent and attribute every row for that ticker to it
    (they are all logged as handled). Ties on date resolve to a SELL — the more
    conservative read when she both added and trimmed on the same day.
    """
    by_ticker: dict[str, list[dict]] = {}
    for t in trades:
        by_ticker.setdefault(str(t["ticker"]).upper(), []).append(t)

    out: dict[str, dict] = {}
    for ticker, rows in by_ticker.items():
        # latest date wins; sell beats buy on a tie (sort key: date, then
        # buy<sell so sell lands last and is picked by [-1]).
        rows_sorted = sorted(
            rows,
            key=lambda r: (str(r.get("txn_date") or ""), 0 if r.get("txn_type") == "buy" else 1),
        )
        net = rows_sorted[-1]
        out[ticker] = {
            "txn_type": net.get("txn_type"),
            "trade_ids": [r["id"] for r in rows],
            "latest": net,
        }
    return out


def plan_mirror(
    trades: list[dict],
    book: dict,
    prices: dict[str, float],
    *,
    target_position_pct: float,
    cash_reserve_pct: float,
    min_trade_usd: float,
    max_positions: int,
    when_held: str = "skip",
) -> MirrorPlan:
    """Decide what to trade to mirror a batch of disclosures. Pure.

    ``trades`` are the disclosures this (portfolio, agent) has not yet logged.
    ``prices`` maps the *tradable* subset to a price (callers drop unpriced /
    out-of-universe names first). ``book`` is the current portfolio book.

    ``when_held`` controls a disclosed BUY of a name the portfolio already
    holds: ``"skip"`` (default) never doubles up — it only opens new positions;
    ``"top_up"`` adds toward ``target_position_pct`` when currently underweight.

    Returns a :class:`MirrorPlan`; every input trade id ends up in exactly one
    of buys / sells / skips so the caller can log the whole batch as handled.
    """
    plan = MirrorPlan()
    total_value = float(book.get("total_value_usd") or 0)
    cash = float(book.get("cash_usd") or 0)
    held_qty = {
        str(h["ticker"]).upper(): float(h.get("quantity") or 0)
        for h in (book.get("holdings") or [])
    }
    held_count = sum(1 for q in held_qty.values() if q > 0)

    target_usd = total_value * float(target_position_pct) / 100.0
    spendable = cash - total_value * float(cash_reserve_pct)

    for ticker, net in _net_action_by_ticker(trades).items():
        trade_ids = net["trade_ids"]
        action = net["txn_type"]

        if action not in ("buy", "sell"):
            plan.skips.append({"ticker": ticker, "trade_ids": trade_ids,
                               "reason": f"unhandled txn_type {action!r}"})
            continue

        price = prices.get(ticker)
        if price is None or price <= 0:
            plan.skips.append({"ticker": ticker, "trade_ids": trade_ids,
                               "reason": "not tradable in our universe (unpriced)"})
            continue

        if action == "sell":
            qty = held_qty.get(ticker, 0.0)
            if qty <= 0:
                plan.skips.append({"ticker": ticker, "trade_ids": trade_ids,
                                   "reason": "she sold but we don't hold it"})
                continue
            plan.sells.append({"ticker": ticker, "qty": qty, "trade_ids": trade_ids,
                               "why": "Nancy Pelosi disclosed a sale"})
            held_qty[ticker] = 0.0
            held_count -= 1
            continue

        # --- buy. `held_qty` reflects the SHARED book (any agent or the owner).
        current_qty = held_qty.get(ticker, 0.0)
        already_held = current_qty > 0
        if already_held and when_held != "top_up":
            # Default: don't double up — only ever open NEW positions.
            plan.skips.append({"ticker": ticker, "trade_ids": trade_ids,
                               "reason": "already held — not doubling up"})
            continue
        if not already_held and held_count >= max_positions:
            plan.skips.append({"ticker": ticker, "trade_ids": trade_ids,
                               "reason": f"at max_positions ({max_positions})"})
            continue
        # Buy budget = the gap to target weight (a full target for a new name;
        # only the underweight remainder when topping up an existing holding).
        gap_usd = target_usd - current_qty * price
        if gap_usd < min_trade_usd:
            plan.skips.append({"ticker": ticker, "trade_ids": trade_ids,
                               "reason": "already at/above target weight"})
            continue
        budget = min(gap_usd, spendable)
        qty = int(math.floor(budget / price)) if price > 0 else 0
        if qty < 1 or qty * price < min_trade_usd:
            plan.skips.append({"ticker": ticker, "trade_ids": trade_ids,
                               "reason": "insufficient cash for a meaningful buy"})
            continue
        plan.buys.append({"ticker": ticker, "qty": qty, "trade_ids": trade_ids,
                          "why": "Nancy Pelosi disclosed a purchase"})
        spendable -= qty * price
        if not already_held:
            held_count += 1

    return plan


# ---------------------------------------------------------------------------
# Heartbeat strategy
# ---------------------------------------------------------------------------


def _format_note(politician: str, action: str, ticker: str, why: str) -> str:
    return f"{action} {ticker} — mirroring {politician}: {why}."


def rebalance_pelosi_mirror(ctx: "RebalanceContext") -> "RebalanceResult":
    """Mirror a politician's disclosed stock trades into the portfolio.

    Self-sourced buyer: the candidate feed is ``congress_trades`` (populated by
    ``congress_trades.py``), NOT the screen. Buys disclosed purchases up to
    ``target_position_pct`` and exits held names she sold; every disclosure
    touched is logged to ``congress_mirror_log`` so re-runs are no-ops and only
    genuinely new filings ever trade. Never raises — failures land in
    ``result.errors`` so the heartbeat can't crash on it.
    """
    from agent_strategies import RebalanceResult  # local: avoid import cycle

    result = RebalanceResult()
    params = {**PELOSI_MIRROR_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    if not ctx.portfolio_id:
        result.notes["reason"] = "pelosi_mirror only runs on a human portfolio"
        return result

    politician = str(params["politician"]).strip()
    lookback_days = int(params["lookback_days"])
    since = (date.today() - timedelta(days=lookback_days)).isoformat()

    # New disclosures = those we have never logged for this (portfolio, agent),
    # within the lookback window, excluding gifts (not a market signal).
    try:
        trades = ctx.db.get_unmirrored_congress_trades(
            ctx.portfolio_id, ctx.agent["id"], politician, since=since,
        )
    except Exception as exc:  # noqa: BLE001 — never crash the heartbeat
        result.errors.append(f"congress_trades read failed: {exc}")
        return result

    result.notes["politician"] = politician
    result.notes["lookback_since"] = since
    result.notes["new_disclosures"] = len(trades)
    if not trades:
        result.notes.setdefault("reason", "no new disclosures to mirror")
        return result

    # Price the candidate tickers; an unpriced name isn't tradable in our
    # universe (e.g. a name not in Level 0 / companies) and is skipped.
    prices: dict[str, float] = {}
    for t in trades:
        tk = str(t["ticker"]).upper()
        if tk in prices:
            continue
        try:
            prices[tk] = ctx.pm.get_price(tk)
        except PortfolioError:
            continue

    book = ctx.get_book()
    if float(book.get("total_value_usd") or 0) <= 0:
        result.errors.append(f"total_value_usd <= 0 for {handle}")
        return result

    plan = plan_mirror(
        trades, book, prices,
        target_position_pct=float(params["target_position_pct"]),
        cash_reserve_pct=float(params["cash_reserve_pct"]),
        min_trade_usd=float(params["min_trade_usd"]),
        max_positions=int(params["max_positions"]),
        when_held=str(params["when_held"]),
    )

    if ctx.dry_run:
        result.notes["dry_run_plan"] = {
            "sells": [{"ticker": s["ticker"], "qty": s["qty"]} for s in plan.sells],
            "buys": [{"ticker": b["ticker"], "qty": b["qty"]} for b in plan.buys],
            "skips": plan.skips,
            "target_position_pct": params["target_position_pct"],
        }
        logger.info(
            "[dry-run] %s: mirror %s — %d sell(s), %d buy(s), %d skip(s)",
            handle, politician, len(plan.sells), len(plan.buys), len(plan.skips),
        )
        return result

    # Sells first so cash frees up for the rotations into her new names.
    handled: list[dict] = []  # {trade_ids, ticker, action}
    for s in plan.sells:
        try:
            ctx.sell(s["ticker"], s["qty"],
                     note=_format_note(politician, "Sold", s["ticker"], s["why"]))
            result.sells += 1
            handled.append({"trade_ids": s["trade_ids"], "ticker": s["ticker"], "action": "sell"})
        except PortfolioError as exc:
            result.errors.append(f"sell {s['ticker']}: {exc}")

    for b in plan.buys:
        note = _format_note(politician, "Bought", b["ticker"], b["why"])
        # Thesis text mirrors the disclosure; the break signal is the inverse —
        # if she later sells, the mirror's sell path closes it.
        thesis = {"thesis_text": note}
        try:
            ctx.buy(b["ticker"], b["qty"], note=note, thesis=thesis)
            result.buys += 1
            handled.append({"trade_ids": b["trade_ids"], "ticker": b["ticker"], "action": "buy"})
        except PortfolioError as exc:
            result.errors.append(f"buy {b['ticker']} x{b['qty']}: {exc}")

    # Record EVERY disclosure we touched (executed or skipped) so it is never
    # reconsidered — this is what makes "check for NEW transactions" durable.
    log_rows: list[dict] = []
    for h in handled:
        for tid in h["trade_ids"]:
            log_rows.append({"congress_trade_id": tid, "ticker": h["ticker"], "action": h["action"]})
    for sk in plan.skips:
        for tid in sk["trade_ids"]:
            log_rows.append({"congress_trade_id": tid, "ticker": sk["ticker"],
                             "action": f"skip:{sk['reason'][:60]}"})
    if log_rows:
        try:
            ctx.db.record_congress_mirror(ctx.portfolio_id, ctx.agent["id"], log_rows)
        except Exception as exc:  # noqa: BLE001
            result.errors.append(f"mirror-log write failed: {exc}")

    result.notes["mirrored_buys"] = result.buys
    result.notes["mirrored_sells"] = result.sells
    result.notes["skipped"] = len(plan.skips)
    return result
