"""
swarm.py — portfolio swarm coordination (portfolio page brief §4).

A portfolio runs a swarm of specialist buyers + reviewers over a SHARED cash
pool. This module is the pure coordination core — the buy/sell *decisions*
(conviction per name, sell verdicts) are injected, so the algorithm is
deterministic and unit-testable without LLMs or a DB. agent_heartbeat wires the
real per-name LLM evaluations into these functions.

Buying — snake draft per cycle:
  * Candidates = the shared top-N of the portfolio's screen.
  * Buyers draft ONE name at a time; draft order rotates and reverses each
    round (A-B-C, then C-B-A, …).
  * A buyer only drafts a name that clears ITS OWN conviction bar; a turn can
    be a pass.
  * Shared cash; a drafted name is taken (no double-buying) — duplicate-pick
    conflicts resolve inherently.
  * Each pick is attributed to the buyer that drafted it.

Selling — first valid sell wins:
  * Any reviewer can trigger a sell on a name it covers; the first reviewer (in
    order) that says SELL executes it. Not consensus. Each sell is tagged with
    the reviewer + reason.

Churn — no reversing a trade inside its own cycle (`TradeCycle`):
  * Buyers run before reviewers over one shared book, so a reviewer can undo a
    buy the same cycle made. It happened: Double-Down bought INTU at 12:01:33
    and the Sector Rebalancer sold the same 47 shares at the same $312.77 at
    12:08:34. A cycle that reverses itself pays the spread twice and reports a
    realised loss for holding a position for seven minutes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from sector_caps import SectorBudget


@dataclass
class TradeCycle:
    """What this swarm cycle has already traded, so it cannot reverse itself.

    Buyers run before reviewers over one shared book. Nothing stopped a
    reviewer from selling, minutes later, a name a buyer had just bought — and
    on 11 Sep 2026 the Sector Rebalancer did exactly that to Double-Down's INTU
    add: same 47 shares, same $312.77, seven minutes apart, inside one cycle.

    The rule is deliberately narrow: **a ticker traded this cycle may not be
    traded in the OPPOSITE direction this cycle.** Not "no selling what we
    hold" — a real thesis break should still exit. But a break cannot credibly
    fire minutes after a 5/5 conviction add on unchanged data, and a mechanical
    cap trim is a constraint that belongs at the buy (see `sector_caps`), not a
    repair at the sell. Blocking the reversal costs at most one cycle of delay:
    the next heartbeat sees a fresh cycle and acts normally.

    Same-direction repeats stay allowed — two buyers topping up one name, or a
    reviewer trimming after another reviewer trimmed, are not reversals.

    Held by `agent_heartbeat` for one `_run_portfolio_swarm` call and shared by
    every member's `RebalanceContext`; the guard sits in `ctx.buy`/`ctx.sell`
    so it covers every strategy, including ones not yet written. A cycle of
    None (the legacy 1:1 agent path) disables it entirely.
    """

    bought: set[str] = field(default_factory=set)
    sold: set[str] = field(default_factory=set)
    # Every refusal, for the heartbeat journal: a blocked reversal is a
    # decision the owner should be able to see, not a silent no-op.
    blocked: list[dict] = field(default_factory=list)

    _OPPOSITE = {"buy": "sell", "sell": "buy"}
    _PAST = {"buy": "bought", "sell": "sold"}

    def blocks(self, side: str, ticker: str) -> str | None:
        """Why this trade may not run, or None to allow it."""
        side = (side or "").lower()
        opposite = self._OPPOSITE.get(side)
        if opposite is None:
            return None
        prior = self.sold if side == "buy" else self.bought
        if ticker.upper() in prior:
            return (
                f"{ticker.upper()} was already {self._PAST[opposite]} this "
                f"cycle — refusing to reverse it in the same run"
            )
        return None

    def record(self, side: str, ticker: str) -> None:
        """Note an EXECUTED trade. Never called for a plan that did not fill."""
        side = (side or "").lower()
        if side == "buy":
            self.bought.add(ticker.upper())
        elif side == "sell":
            self.sold.add(ticker.upper())

    def note_blocked(self, side: str, ticker: str, agent_id: str, reason: str) -> None:
        self.blocked.append({
            "side": side, "ticker": ticker.upper(),
            "agent_id": agent_id, "reason": reason,
        })


@dataclass
class Buyer:
    agent_id: str
    gate: int = 1                 # minimum conviction (1..5) to draft a name
    max_per_name: float = 0.08    # target position as a fraction of total value


@dataclass
class DraftPick:
    agent_id: str
    ticker: str
    qty: int
    price: float
    conviction: int


@dataclass
class SellTrigger:
    ticker: str
    agent_id: str
    reason: str


@dataclass
class DraftResult:
    picks: list[DraftPick] = field(default_factory=list)
    cash_remaining: float = 0.0
    passes: dict[str, int] = field(default_factory=dict)  # agent_id -> pass count


def snake_draft_plan(
    buyers: list[Buyer],
    candidates: list[str],
    prices: dict[str, float],
    total_value: float,
    cash: float,
    *,
    cash_reserve_pct: float = 0.02,
    min_order_value: float = 0.0,
    convictions: dict[str, dict[str, int]],
    sector_of: dict[str, str] | None = None,
    sector_start_value: dict[str, float] | None = None,
    max_sector_value: float = 0.0,
) -> DraftResult:
    """Plan a snake-draft buy cycle. Pure — returns the ordered picks.

    `convictions[agent_id][ticker]` is that buyer's conviction (1..5) for a
    name; a missing entry means "no opinion / won't draft". A buyer drafts the
    highest-conviction candidate it can both clear (>= its gate) and afford
    (>= 1 share within its max_per_name and the shared cash, minus reserve).

    `min_order_value` is a dust guard: a candidate whose affordable notional
    (qty*price) is below this floor is skipped rather than drafted, so a buyer
    spending down the tail of the cash never opens a $9 sliver position. 0
    disables it (the default, so existing callers/tests are unaffected).

    Sector cap (the Sector Rebalancer's buy-side half): when `max_sector_value`
    is > 0, no pick may push its GICS sector's total market value over that
    dollar ceiling. `sector_of[ticker]` maps a name to its sector (absent =
    unclassified, never capped); `sector_start_value[sector]` is the value the
    portfolio already holds in each sector before this cycle. A candidate near
    its sector's cap is sized DOWN to the remaining headroom (and dropped by the
    dust guard if nothing meaningful fits), so freed cash diversifies instead of
    re-concentrating the same sector. 0 / None disables it — existing callers
    and tests are unaffected.

    The cap arithmetic itself lives in `sector_caps.SectorBudget`, shared with
    the self-sourced buyers (`double_down`, `pelosi_mirror`) that run BEFORE
    this draft. It used to live only here, which is how a Double-Down add
    breached a cap the draft would have respected and the Rebalancer reversed
    it seven minutes later — see the module docstring there.
    """
    result = DraftResult(cash_remaining=cash)
    available = [t for t in candidates if prices.get(t, 0) and prices[t] > 0]
    taken: set[str] = set()
    min_cash = total_value * cash_reserve_pct

    # Running value per sector, seeded from what the book already holds; each
    # draft pick adds to its sector so later picks in the same cycle see it.
    budget = SectorBudget(
        sector_of={k.upper(): v for k, v in (sector_of or {}).items() if v},
        max_sector_value=float(max_sector_value or 0.0),
        sector_value=dict(sector_start_value or {}),
    )

    round_idx = 0
    while available:
        order = buyers if round_idx % 2 == 0 else list(reversed(buyers))
        drafted = 0
        for b in order:
            conv = convictions.get(b.agent_id, {})
            # Eligible = cleared the gate, still available; best conviction first,
            # tie-broken by the candidate pool's order (its screen rank).
            eligible = sorted(
                (t for t in available if t not in taken and conv.get(t, 0) >= b.gate),
                key=lambda t: (-conv.get(t, 0), candidates.index(t)),
            )
            picked = None
            for t in eligible:
                price = prices[t]
                target = b.max_per_name * total_value
                spendable = min(target, result.cash_remaining - min_cash)
                qty = int(math.floor(spendable / price))
                qty = budget.cap_qty(t, qty, price)
                if qty >= 1 and qty * price >= min_order_value:
                    picked = (t, qty, price)
                    break
            if picked is None:
                result.passes[b.agent_id] = result.passes.get(b.agent_id, 0) + 1
                continue
            t, qty, price = picked
            result.picks.append(
                DraftPick(b.agent_id, t, qty, price, int(conv.get(t, 0)))
            )
            result.cash_remaining -= qty * price
            budget.record(t, qty, price)
            taken.add(t)
            drafted += 1
        available = [t for t in available if t not in taken]
        round_idx += 1
        if drafted == 0:
            break  # a full round with no picks — nothing left anyone can/will buy
    return result


def rank_to_conviction(index: int, n: int) -> int:
    """Map a 0-based screen rank (0 = best) to a 1..5 conviction bucket.

    A deterministic conviction baseline derived from the screen rank: the top
    fifth of the candidate pool is 5, the next fifth 4, … the bottom fifth 1.
    Used when a buyer has no per-brain LLM conviction wired (the swarp's draft
    mechanics — order, gates, shared cash, attribution — are unchanged; only
    the conviction *source* differs; per-brain LLM convictions can replace
    this by populating the `convictions` map directly.
    """
    if n <= 0:
        return 1
    bucket = max(1, (n + 4) // 5)  # ceil(n/5)
    return max(1, 5 - index // bucket)


def first_valid_sell_plan(
    reviewers: list[str],
    holdings: list[str],
    verdicts: dict[str, dict[str, dict]],
) -> list[SellTrigger]:
    """For each held name, the first reviewer (in order) that returns a SELL
    triggers the sell. `verdicts[agent_id][ticker] = {"verdict": "SELL"|"HOLD",
    "reason": str}`. Returns one SellTrigger per name that any reviewer sells.
    """
    triggers: list[SellTrigger] = []
    for ticker in holdings:
        for agent_id in reviewers:
            v = verdicts.get(agent_id, {}).get(ticker)
            if v and str(v.get("verdict", "")).upper() == "SELL":
                triggers.append(
                    SellTrigger(ticker, agent_id, str(v.get("reason", "")).strip())
                )
                break
    return triggers
