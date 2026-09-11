#!/usr/bin/env python3
"""The owner-configured **cash policy** for a portfolio's shared pot
(migration 088) — stored on ``portfolios.cash_policy``.

Pure: no DB, no LLM, no clock. Unit-tested in ``tests/test_cash_policy.py``
against the production situation it exists to fix.

**Why it exists.** A portfolio's buyers share one cash pool and nothing
allocated it between them. The swarm runs self-sourced buyers (``double_down``)
BEFORE the snake draft, and the draft then buys until cash reaches its floor —
so the draft always left ~2% and the Double-Down Buyer always arrived to find
~2%. It made **zero** trades in its entire life while the screen buyer made 25
on the same book.

``swarm.snake_draft_plan`` has always accepted a ``cash_reserve_pct``; the
heartbeat never passed one, so it defaulted to 2%. This module is the missing
half — somewhere for the OWNER to set that number.

**Why portfolio-level, not an agent knob** (the same argument as
``thesis_policy``): per-agent settings live in ``portfolio_agents.config`` and
reach exactly one member. "Leave room for the other agents" is a rule about the
SHARED POT — on one buyer's config it would bind only that buyer, be silently
ignored the day a second screen-buyer is hired, and read as one buyer's setting
for how much everyone *else* gets.

**What a reserve is not.** It is a TRANSFER of budget from the screen draft to
the buyers that run before it — not a renewable supply. Only sells (and
deposits) create cash. On a book that rarely sells, raising the reserve funds an
occasional extra add rather than a continuous stream. Nothing here can conjure
cash that the book does not have.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("cash_policy")


# `reserve_pct` is a PERCENT of NAV (2.0 == 2%), not a fraction — it is what the
# owner types into the panel, and it matches `thesis_policy.grace_period_days`
# in being a plain human number. `snake_draft_plan` wants a FRACTION, so the one
# conversion happens at that call site via `reserve_fraction()`.
#
# The default is 2.0 because that is exactly `snake_draft_plan`'s own default,
# in force before migration 088: a portfolio that never touches this setting
# behaves identically to how it did before the column existed.
DEFAULTS: dict[str, Any] = {
    "reserve_pct": 2.0,
}

# Bounds — a policy read from the DB is untrusted input (owner-edited JSON).
# A reserve above half the book is not a reserve, it is a decision to stop
# investing, and is far more likely to be a typo than an intention.
MAX_RESERVE_PCT = 50.0


def resolve_policy(raw: Any) -> dict[str, Any]:
    """Return a complete policy dict: ``raw`` overlaid on :data:`DEFAULTS`.

    Total and defensive — ``None``, a non-dict, unknown keys and out-of-range
    or wrong-typed values all degrade to the default for that key rather than
    raising. A malformed policy must never break a heartbeat; the worst case is
    that the portfolio runs on defaults, which is the pre-088 behaviour.
    """
    policy = dict(DEFAULTS)
    if not isinstance(raw, dict):
        return policy

    pct = raw.get("reserve_pct")
    if isinstance(pct, bool):
        pass  # bool is an int subclass — never a valid percentage
    elif isinstance(pct, (int, float)):
        value = float(pct)
        if value == value and abs(value) != float("inf"):  # not NaN/inf
            policy["reserve_pct"] = max(0.0, min(MAX_RESERVE_PCT, value))
    return policy


def reserve_pct(policy: dict[str, Any]) -> float:
    """The reserve as a PERCENT of NAV (2.0 == 2%)."""
    return float(resolve_policy(policy)["reserve_pct"])


def reserve_fraction(policy: dict[str, Any]) -> float:
    """The reserve as a FRACTION, the form ``snake_draft_plan`` takes.

    The single conversion site. Keeping it here rather than inline at the
    caller is the point: a percent passed where a fraction is expected is a
    50x sizing error that no type checker would catch.
    """
    return reserve_pct(policy) / 100.0


def reserve_usd(policy: dict[str, Any], total_value_usd: float) -> float:
    """The reserve in dollars for a book of ``total_value_usd``."""
    try:
        nav = float(total_value_usd)
    except (TypeError, ValueError):
        return 0.0
    if nav <= 0:
        return 0.0
    return nav * reserve_fraction(policy)


def policy_for_portfolio(db, portfolio_id: Optional[str]) -> dict[str, Any]:
    """Resolve the cash policy for a portfolio; DEFAULTS on any failure.

    Tolerates a pre-088 database (no ``cash_policy`` column) and any read
    error — a heartbeat must not abort because a policy could not be read, and
    DEFAULTS is the behaviour that predates the column.
    """
    if not portfolio_id:
        return dict(DEFAULTS)
    try:
        row = db.get_portfolio_by_id(portfolio_id) or {}
    except Exception as exc:  # noqa: BLE001 — policy read is never fatal
        logger.warning("cash_policy: read failed for %s: %s", portfolio_id, exc)
        return dict(DEFAULTS)
    return resolve_policy(row.get("cash_policy"))
