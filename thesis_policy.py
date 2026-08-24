"""Owner-configured sell discipline — the rules a thesis's signals live under.

A buyer, when it opens a position, also authors the **break signals** that will
later justify selling it: the optimist writes its own falsification test, and a
different agent (the reviewer) enforces it. Nothing constrained what could be
written, so three things went wrong in production (see
``docs/case-studies/scrappy-fightback-trading-record.md``):

* a break signal identical to the screen's own entry filter — true at the
  instant of purchase, so the thesis was born broken;
* an *extend* signal (what would CONFIRM the thesis) read as a break — sold
  while the reviewer's own note said no break signal had fired;
* no holding period at all — buyers run before reviewers over the shared book
  inside one heartbeat, so three positions were bought and sold within 90
  seconds.

This module is the policy layer. It is **pure** — no DB, no LLM, no clock of
its own (callers pass ``now``) — so every rule is unit-testable in isolation
(``tests/test_thesis_policy.py``). Enforcement lives at three call sites:

``grace_period_days``
    ``portfolio_reviewer`` skips positions younger than this.

``require_fired_break_signal``
    ``portfolio_reviewer`` refuses a SELL when no break signal is actually
    firing *and* the thesis carries signals to check.

``relative_fields_change_only``
    ``llm_watchlist_buyer`` drops price-relative signals that use a static
    operator, keeping only the change-since-buy form.

Storage is ``portfolios.thesis_policy`` (migration 086) — portfolio-level, not
per-agent, because the buyer writes signals and the reviewer acts on them: a
knob on either alone cannot bind the other.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

logger = logging.getLogger("thesis_policy")


# Defaults applied to every missing key, so ``{}`` (the column default) is a
# complete, sane policy and pre-086 rows behave identically to configured ones.
DEFAULTS: dict[str, Any] = {
    # The reviewer ignores a position for this many days after it opens.
    # A turnaround thesis cannot be confirmed or refuted in a week; judging it
    # sooner just harvests noise. 0 disables the grace period entirely.
    "grace_period_days": 30,
    # A SELL requires a break signal to be ACTUALLY FIRING (per
    # theses.check_thesis), not merely an unsatisfied extend signal or a
    # narrative "the re-rating hasn't happened yet".
    "require_fired_break_signal": True,
    # Price-relative fields may only carry change-since-buy operators.
    "relative_fields_change_only": True,
}

# Bounds — a policy read from the DB is untrusted input (owner-edited JSON).
_MAX_GRACE_DAYS = 365


# Fields whose value is a function of the share price (directly, or of the
# price relative to the market / to its own history). A STATIC threshold on
# one of these says where the stock IS, not what has CHANGED — so it can be
# true the moment the position opens, and on a screen that selects for
# beaten-down names it usually is. The change-since-buy form is always safe:
# at buy time the delta is zero by construction.
RELATIVE_FIELDS: frozenset[str] = frozenset({
    "perf_52w_vs_spy",        # the observed offender — mirrors the screen filter
    "price_pct_of_52w_high",
    "price",
    "ps_now",
    "composite_score",
})

# Operators that compare current vs the value frozen at buy (theses._evaluate_signal).
CHANGE_OPS: frozenset[str] = frozenset({"change_pct_lt", "change_pct_gt"})


def resolve_policy(raw: Any) -> dict[str, Any]:
    """Return a complete policy dict: ``raw`` overlaid on :data:`DEFAULTS`.

    Total and defensive — ``None``, a non-dict, unknown keys and out-of-range
    or wrong-typed values all degrade to the default for that key rather than
    raising. A malformed policy must never break a heartbeat; the worst case
    is that the portfolio runs on defaults.
    """
    policy = dict(DEFAULTS)
    if not isinstance(raw, dict):
        return policy

    days = raw.get("grace_period_days")
    if isinstance(days, bool):
        pass  # bool is an int subclass — never a valid day count
    elif isinstance(days, (int, float)):
        policy["grace_period_days"] = max(0, min(_MAX_GRACE_DAYS, int(days)))

    for key in ("require_fired_break_signal", "relative_fields_change_only"):
        value = raw.get(key)
        if isinstance(value, bool):
            policy[key] = value

    return policy


# ---------------------------------------------------------------------------
# Rule 1 — grace period
# ---------------------------------------------------------------------------


def _parse_ts(value: Any) -> Optional[datetime]:
    """Coerce a Postgres timestamptz (or datetime) to an aware datetime."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace(" ", "T", 1)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def within_grace_period(
    opened_at: Any, policy: dict[str, Any], *, now: Optional[datetime] = None,
) -> bool:
    """Is a position opened at ``opened_at`` still too young to review?

    Returns False when the grace period is 0 (disabled) or when ``opened_at``
    is missing/unparseable — an unknown open date must never freeze a position
    permanently, so the conservative answer is "reviewable".
    """
    days = int(policy.get("grace_period_days") or 0)
    if days <= 0:
        return False
    opened = _parse_ts(opened_at)
    if opened is None:
        return False
    now = now or datetime.now(timezone.utc)
    return now < opened + timedelta(days=days)


def days_held(
    opened_at: Any, *, now: Optional[datetime] = None,
) -> Optional[float]:
    """Age of a position in days, or None when ``opened_at`` is unusable."""
    opened = _parse_ts(opened_at)
    if opened is None:
        return None
    now = now or datetime.now(timezone.utc)
    return (now - opened).total_seconds() / 86400.0


# ---------------------------------------------------------------------------
# Rule 2 — a SELL needs a break signal that actually fired
# ---------------------------------------------------------------------------


def sell_is_permitted(
    policy: dict[str, Any],
    *,
    thesis: Any,
    signal_check: Any,
) -> tuple[bool, str]:
    """May a SELL verdict be acted on? Returns ``(permitted, reason)``.

    The rule only bites when there is something to check. A position with no
    recorded thesis, or a thesis carrying no break signals, falls back to the
    reviewer's judgement — otherwise the rule would make such positions
    unsellable forever, which is a worse failure than the one it prevents.

    ``signal_check`` is the output of ``theses.check_thesis``; when it is
    missing (the check errored) the sell is likewise permitted, because a
    failed oracle must not silently become a hold-forever policy.
    """
    if not policy.get("require_fired_break_signal"):
        return True, ""
    if not isinstance(thesis, dict):
        return True, "no recorded thesis to check against"
    if not (thesis.get("break_signals") or []):
        return True, "thesis records no break signals"
    if not isinstance(signal_check, dict):
        return True, "break-signal check unavailable"
    if signal_check.get("broken_signals"):
        return True, ""
    return False, "no recorded break signal is firing"


# ---------------------------------------------------------------------------
# Rule 3 — price-relative fields: change-since-buy operators only
# ---------------------------------------------------------------------------


def signal_permitted(signal: Any, policy: dict[str, Any]) -> bool:
    """May this ``{field, op, value}`` signal be recorded?

    Rejects a static threshold on a price-relative field when
    ``relative_fields_change_only`` is on. A malformed signal is left alone —
    schema validation is ``llm_watchlist_buyer._validate_signals``' job, and
    double-filtering here would silently swallow shape bugs.
    """
    if not policy.get("relative_fields_change_only"):
        return True
    if not isinstance(signal, dict):
        return True
    if signal.get("field") not in RELATIVE_FIELDS:
        return True
    return signal.get("op") in CHANGE_OPS


def filter_signals(
    signals: Optional[Iterable[dict]], policy: dict[str, Any],
) -> tuple[list[dict], list[dict]]:
    """Split ``signals`` into ``(kept, dropped)`` under the policy."""
    kept: list[dict] = []
    dropped: list[dict] = []
    for signal in signals or []:
        (kept if signal_permitted(signal, policy) else dropped).append(signal)
    return kept, dropped


def describe_dropped(dropped: Iterable[dict]) -> list[str]:
    """Render dropped signals as ``"field op value"`` for run journals."""
    return [
        f"{s.get('field')} {s.get('op')} {s.get('value')}"
        for s in dropped
        if isinstance(s, dict)
    ]


# ---------------------------------------------------------------------------
# Reading the policy off a portfolio
# ---------------------------------------------------------------------------


def policy_for_portfolio(db, portfolio_id: Optional[str]) -> dict[str, Any]:
    """Resolve the policy for a portfolio; DEFAULTS on any failure.

    Tolerates a pre-086 database (no ``thesis_policy`` column) and any read
    error — a heartbeat must not abort because a policy could not be read.
    """
    if not portfolio_id:
        return dict(DEFAULTS)
    try:
        row = db.get_portfolio_by_id(portfolio_id) or {}
    except Exception as exc:  # noqa: BLE001 — policy read is never fatal
        logger.warning("thesis_policy: read failed for %s: %s", portfolio_id, exc)
        return dict(DEFAULTS)
    return resolve_policy(row.get("thesis_policy"))
