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
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


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
    convictions: dict[str, dict[str, int]],
) -> DraftResult:
    """Plan a snake-draft buy cycle. Pure — returns the ordered picks.

    `convictions[agent_id][ticker]` is that buyer's conviction (1..5) for a
    name; a missing entry means "no opinion / won't draft". A buyer drafts the
    highest-conviction candidate it can both clear (>= its gate) and afford
    (>= 1 share within its max_per_name and the shared cash, minus reserve).
    """
    result = DraftResult(cash_remaining=cash)
    available = [t for t in candidates if prices.get(t, 0) and prices[t] > 0]
    taken: set[str] = set()
    min_cash = total_value * cash_reserve_pct

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
                if qty >= 1:
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
