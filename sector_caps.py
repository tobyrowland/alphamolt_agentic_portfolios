"""The Sector Rebalancer's cap, as a constraint every buyer can see.

A hired ``sector_rebalancer`` reviewer carries a ``max_sector_pct`` and trims
any GICS sector above it. That cap used to be enforced in exactly one place —
``swarm.snake_draft_plan`` — and the draft is not the only agent that buys.

What that cost, on the "Scrappy Fightback!" book (11 Sep 2026)::

    11:33  Sector Rebalancer  SELL BSY, CLBT, AGYS   Technology Services 48% -> under cap
                                                     realises -$9,700, frees ~$174k
    12:01  Double-Down Buyer  BUY  BAM, INTU, ...    spends that cash
                                   ^ INTU is Technology Services -> back over cap
    12:08  Sector Rebalancer  SELL INTU 47 @ 312.77  the same 47 shares, the same price

Seven minutes, inside one swarm cycle. `plan_double_down` had no sector
parameters at all, and self-sourced buyers run BEFORE the draft and before the
reviewers — so the agent that could not see the constraint bought first, and
the agent that enforces it ran last and undid the trade at the price just paid.

The fix is not a smarter agent, it is one shared constraint. This module owns
the arithmetic; every buy planner takes a :class:`SectorBudget` and sizes down
to the remaining headroom, exactly as the draft always did. Pure — no DB, no
clock (``db.get_sectors`` is the caller's job), unit-tested against the real
trades above in ``tests/test_sector_caps.py``.

Deliberately NOT a replacement for the Rebalancer: drift, price moves and the
owner's own buys can still push a sector over, and trimming that back is the
reviewer's job. This only stops the swarm from breaching a cap with its own
buy and then paying to reverse it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

# The cap a `sector_rebalancer` uses when its config names none. Mirrors the
# strategy's own default; kept here so every reader resolves it identically.
DEFAULT_MAX_SECTOR_PCT = 30.0


def cap_pct_for_members(member_rows: Iterable[dict]) -> Optional[float]:
    """The tightest sector cap the hired team imposes, or None if nobody does.

    Reads the same `max_sector_pct` knob the Rebalancer trims on, off every
    hired ``sector_rebalancer``. Tightest wins when several are hired — a
    buyer that respected only the loosest would still be breaching one of
    them. Returns None when no Rebalancer is on the team, which is the signal
    to leave every buyer completely unconstrained (pre-fix behaviour).
    """
    caps: list[float] = []
    for m in member_rows or []:
        agent = m.get("agent") or {}
        if agent.get("strategy") != "sector_rebalancer":
            continue
        raw = (m.get("config") or {}).get("max_sector_pct", DEFAULT_MAX_SECTOR_PCT)
        try:
            pct = float(raw if raw is not None else DEFAULT_MAX_SECTOR_PCT)
        except (TypeError, ValueError):
            pct = DEFAULT_MAX_SECTOR_PCT
        if 0 < pct < 100:
            caps.append(pct)
    return min(caps) if caps else None


@dataclass
class SectorBudget:
    """Running per-sector dollar headroom for ONE planning cycle.

    Seeded from what the book already holds, then advanced by each planned buy
    (``record``) so later picks in the same cycle see the earlier ones. A
    planner that never calls ``record`` will happily plan the same headroom
    twice, which is why every caller records immediately after sizing.

    ``max_sector_value <= 0`` disables the whole thing: ``cap_qty`` becomes the
    identity and ``enabled`` is False, so a portfolio with no Rebalancer hired
    behaves exactly as it did before this module existed.
    """

    sector_of: dict[str, str] = field(default_factory=dict)
    max_sector_value: float = 0.0
    sector_value: dict[str, float] = field(default_factory=dict)

    @property
    def enabled(self) -> bool:
        return self.max_sector_value > 0

    @classmethod
    def from_book(
        cls,
        book: Any,
        sector_of: Optional[dict[str, str]],
        *,
        cap_pct: Optional[float],
        total_value: Optional[float] = None,
    ) -> "SectorBudget":
        """Build a budget from a portfolio book and a cap percentage.

        ``cap_pct`` of None (no Rebalancer hired) returns a disabled budget, so
        callers can build one unconditionally and pass it straight through.
        Holdings are valued at ``market_value_usd`` — the same column the
        Rebalancer weighs sectors with, so the buyer's view of "how full is
        this sector" cannot disagree with the trimmer's.
        """
        if cap_pct is None or not (0 < cap_pct < 100):
            return cls()
        book = book or {}
        total = float(
            total_value if total_value is not None else (book.get("total_value_usd") or 0)
        )
        if total <= 0:
            return cls()

        sector_of = {k.upper(): v for k, v in (sector_of or {}).items() if v}
        running: dict[str, float] = {}
        for h in book.get("holdings") or []:
            ticker = str(h.get("ticker") or "").upper()
            sector = sector_of.get(ticker)
            if not sector:
                continue
            running[sector] = running.get(sector, 0.0) + float(
                h.get("market_value_usd") or 0
            )
        return cls(
            sector_of=sector_of,
            max_sector_value=total * float(cap_pct) / 100.0,
            sector_value=running,
        )

    def headroom(self, ticker: str) -> Optional[float]:
        """Dollars of this ticker's sector still buyable, or None if uncapped.

        None means "no constraint applies" — either the cap is off or the name
        is unclassified. An unclassified name is deliberately never capped: we
        cannot know which sector it would fill, and refusing to buy on missing
        reference data would silently shrink the tradable universe every time
        `securities.gics_sector` lagged a new listing.
        """
        if not self.enabled:
            return None
        sector = self.sector_of.get(ticker.upper())
        if not sector:
            return None
        return max(0.0, self.max_sector_value - self.sector_value.get(sector, 0.0))

    def cap_qty(self, ticker: str, qty: int, price: float) -> int:
        """Size ``qty`` down to whole shares that fit the sector's headroom."""
        room = self.headroom(ticker)
        if room is None or price <= 0:
            return qty
        return max(0, min(int(qty), int(math.floor(room / price))))

    def record(self, ticker: str, qty: float, price: float) -> None:
        """Book a planned buy against its sector so later picks see it."""
        if not self.enabled:
            return
        sector = self.sector_of.get(ticker.upper())
        if not sector:
            return
        self.sector_value[sector] = self.sector_value.get(sector, 0.0) + qty * price

    def at_cap(self, ticker: str, price: float, min_order_usd: float = 0.0) -> bool:
        """True when this name's sector has no room worth using.

        The reason string a planner writes for a skip should say *sector*, not
        *cash*: they are different problems for the owner and only one of them
        is fixed by waiting.
        """
        room = self.headroom(ticker)
        if room is None:
            return False
        return room < max(min_order_usd, price)

    def sector_name(self, ticker: str) -> Optional[str]:
        return self.sector_of.get(ticker.upper())
