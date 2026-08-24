"""Unit tests for the owner-configured sell discipline (migration 086).

Every case here is drawn from a real decision in
``docs/case-studies/scrappy-fightback-trading-record.md`` — the tests pin both
the correct behaviour AND the specific production failure it prevents, so a
regression names the trade it would have repeated.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import thesis_policy as tp  # noqa: E402
from theses import _drop_already_true  # noqa: E402


NOW = datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# resolve_policy — untrusted owner-edited JSON must never break a heartbeat
# ---------------------------------------------------------------------------


def test_empty_policy_is_the_defaults():
    assert tp.resolve_policy({}) == tp.DEFAULTS
    assert tp.resolve_policy(None) == tp.DEFAULTS
    assert tp.resolve_policy("nonsense") == tp.DEFAULTS
    assert tp.resolve_policy(["nope"]) == tp.DEFAULTS


def test_partial_policy_fills_missing_keys():
    got = tp.resolve_policy({"grace_period_days": 7})
    assert got["grace_period_days"] == 7
    assert got["require_fired_break_signal"] is tp.DEFAULTS["require_fired_break_signal"]
    assert got["relative_fields_change_only"] is tp.DEFAULTS["relative_fields_change_only"]


def test_resolve_policy_clamps_and_rejects_bad_types():
    assert tp.resolve_policy({"grace_period_days": -5})["grace_period_days"] == 0
    assert tp.resolve_policy({"grace_period_days": 99999})["grace_period_days"] == 365
    assert tp.resolve_policy({"grace_period_days": 12.7})["grace_period_days"] == 12
    # bool is an int subclass — must not be read as a day count
    assert tp.resolve_policy({"grace_period_days": True})["grace_period_days"] == \
        tp.DEFAULTS["grace_period_days"]
    assert tp.resolve_policy({"grace_period_days": "30"})["grace_period_days"] == \
        tp.DEFAULTS["grace_period_days"]
    assert tp.resolve_policy({"require_fired_break_signal": "yes"})[
        "require_fired_break_signal"] is True


def test_resolve_policy_does_not_mutate_defaults():
    tp.resolve_policy({"grace_period_days": 1})["grace_period_days"] = 999
    assert tp.DEFAULTS["grace_period_days"] == 30


# ---------------------------------------------------------------------------
# Rule 1 — grace period
# ---------------------------------------------------------------------------


def test_alle_and_exls_would_not_have_been_reviewed():
    """ALLE/EXLS were bought and sold 86 seconds later inside one heartbeat."""
    policy = tp.resolve_policy({})
    bought = NOW - timedelta(seconds=86)
    assert tp.within_grace_period(bought, policy, now=NOW) is True


def test_the_six_day_exits_would_not_have_been_reviewed():
    """BL/FICO/ADMA/CRM/CDW were all sold six days after purchase."""
    policy = tp.resolve_policy({})
    assert tp.within_grace_period(NOW - timedelta(days=6), policy, now=NOW) is True


def test_position_past_the_grace_period_is_reviewable():
    policy = tp.resolve_policy({})
    assert tp.within_grace_period(NOW - timedelta(days=31), policy, now=NOW) is False


def test_grace_boundary_is_exclusive_at_exactly_n_days():
    policy = tp.resolve_policy({"grace_period_days": 30})
    assert tp.within_grace_period(NOW - timedelta(days=30), policy, now=NOW) is False


def test_zero_grace_disables_the_rule():
    policy = tp.resolve_policy({"grace_period_days": 0})
    assert tp.within_grace_period(NOW - timedelta(seconds=1), policy, now=NOW) is False


@pytest.mark.parametrize("bad", [None, "", "   ", "not-a-date", 12345])
def test_unparseable_open_date_never_freezes_a_position(bad):
    """An unknown open date must mean 'reviewable', never 'held forever'."""
    policy = tp.resolve_policy({})
    assert tp.within_grace_period(bad, policy, now=NOW) is False


def test_postgres_timestamp_shapes_parse():
    policy = tp.resolve_policy({})
    for shape in (
        "2026-08-24 11:59:00+00",
        "2026-08-24T11:59:00+00:00",
        "2026-08-24T11:59:00Z",
        "2026-08-24T11:59:00",          # naive → assumed UTC
    ):
        assert tp.within_grace_period(shape, policy, now=NOW) is True


def test_days_held():
    assert tp.days_held(NOW - timedelta(days=3), now=NOW) == pytest.approx(3.0)
    assert tp.days_held("garbage", now=NOW) is None


# ---------------------------------------------------------------------------
# Rule 2 — a SELL needs a break signal that actually fired
# ---------------------------------------------------------------------------


THESIS_WITH_SIGNALS = {
    "break_signals": [{"field": "rev_growth_ttm_pct", "op": "<", "value": 5}],
}


def test_alle_sell_is_blocked_no_break_signal_fired():
    """The reviewer's own note: 'above the explicit break signals' — then sold."""
    permitted, why = tp.sell_is_permitted(
        tp.resolve_policy({}),
        thesis=THESIS_WITH_SIGNALS,
        signal_check={"verdict": "active", "broken_signals": []},
    )
    assert permitted is False
    assert "no recorded break signal" in why


def test_sell_allowed_when_a_break_signal_is_firing():
    permitted, _ = tp.sell_is_permitted(
        tp.resolve_policy({}),
        thesis=THESIS_WITH_SIGNALS,
        signal_check={
            "verdict": "broken",
            "broken_signals": [{"field": "rev_growth_ttm_pct", "op": "<", "value": 5}],
        },
    )
    assert permitted is True


@pytest.mark.parametrize("thesis,check", [
    (None, None),                                     # no thesis at all
    ({}, {"broken_signals": []}),                     # thesis with no signals
    ({"break_signals": []}, {"broken_signals": []}),  # explicitly empty
    (THESIS_WITH_SIGNALS, None),                      # check_thesis errored
])
def test_rule_self_disables_when_there_is_nothing_to_check(thesis, check):
    """A position must never become unsellable because the oracle is absent."""
    permitted, _ = tp.sell_is_permitted(
        tp.resolve_policy({}), thesis=thesis, signal_check=check,
    )
    assert permitted is True


def test_rule_off_permits_everything():
    permitted, _ = tp.sell_is_permitted(
        tp.resolve_policy({"require_fired_break_signal": False}),
        thesis=THESIS_WITH_SIGNALS,
        signal_check={"broken_signals": []},
    )
    assert permitted is True


# ---------------------------------------------------------------------------
# Rule 3 — price-relative fields take change-since-buy operators only
# ---------------------------------------------------------------------------


def test_ficos_break_signal_is_rejected():
    """`perf_52w_vs_spy < -20` mirrors the screen's own entry filter."""
    policy = tp.resolve_policy({})
    signal = {"field": "perf_52w_vs_spy", "op": "<", "value": -20}
    assert tp.signal_permitted(signal, policy) is False


def test_the_change_since_buy_form_of_the_same_idea_is_allowed():
    policy = tp.resolve_policy({})
    signal = {"field": "perf_52w_vs_spy", "op": "change_pct_lt", "value": -15}
    assert tp.signal_permitted(signal, policy) is True


def test_unsatisfiable_extend_signal_is_rejected():
    """`perf_52w_vs_spy > 0` on a name the screen guarantees is below -20."""
    policy = tp.resolve_policy({})
    assert tp.signal_permitted(
        {"field": "perf_52w_vs_spy", "op": ">", "value": 0}, policy) is False


@pytest.mark.parametrize("field", sorted(tp.RELATIVE_FIELDS))
def test_every_relative_field_rejects_static_ops(field):
    policy = tp.resolve_policy({})
    assert tp.signal_permitted({"field": field, "op": "<", "value": 1}, policy) is False
    assert tp.signal_permitted(
        {"field": field, "op": "change_pct_lt", "value": -1}, policy) is True


def test_fundamental_fields_are_untouched():
    """The rule targets price-derived fields only — business metrics are fine."""
    policy = tp.resolve_policy({})
    for field in ("rev_growth_ttm_pct", "gross_margin_pct", "fcf_margin_pct",
                  "operating_margin_pct", "rule_of_40"):
        assert tp.signal_permitted({"field": field, "op": "<", "value": 10}, policy) is True


def test_rule_off_permits_static_relative_signals():
    policy = tp.resolve_policy({"relative_fields_change_only": False})
    assert tp.signal_permitted(
        {"field": "perf_52w_vs_spy", "op": "<", "value": -20}, policy) is True


def test_filter_signals_splits_and_describes():
    policy = tp.resolve_policy({})
    kept, dropped = tp.filter_signals([
        {"field": "rev_growth_ttm_pct", "op": "<", "value": 5},
        {"field": "perf_52w_vs_spy", "op": "<", "value": -20},
        {"field": "price", "op": "change_pct_lt", "value": -10},
    ], policy)
    assert [s["field"] for s in kept] == ["rev_growth_ttm_pct", "price"]
    assert tp.describe_dropped(dropped) == ["perf_52w_vs_spy < -20"]


def test_filter_signals_handles_empty_and_none():
    policy = tp.resolve_policy({})
    assert tp.filter_signals(None, policy) == ([], [])
    assert tp.filter_signals([], policy) == ([], [])


# ---------------------------------------------------------------------------
# The unconditional invariant — a break signal already true at buy is dropped
# ---------------------------------------------------------------------------


def test_fico_born_broken_signal_is_dropped_at_record_time():
    """Even with the policy off, a tripwire already tripped is not a tripwire."""
    snapshot = {"perf_52w_vs_spy": -36.2, "rev_growth_ttm_pct": 39.0}
    kept, already = _drop_already_true([
        {"field": "perf_52w_vs_spy", "op": "<", "value": -20},
        {"field": "rev_growth_ttm_pct", "op": "<", "value": 15},
    ], snapshot)
    assert [s["field"] for s in already] == ["perf_52w_vs_spy"]
    assert [s["field"] for s in kept] == ["rev_growth_ttm_pct"]


def test_nvo_break_signal_already_true_at_buy_is_dropped():
    """NVO: `rev_growth_ttm_pct < 15` against 5.6% actual — sold 80s later."""
    snapshot = {"rev_growth_ttm_pct": 5.6}
    kept, already = _drop_already_true(
        [{"field": "rev_growth_ttm_pct", "op": "<", "value": 15}], snapshot)
    assert kept == []
    assert len(already) == 1


def test_change_signals_are_structurally_immune():
    """At buy the delta is zero by construction, so these always survive."""
    snapshot = {"gross_margin_pct": 48.0, "perf_52w_vs_spy": -30.0}
    kept, already = _drop_already_true([
        {"field": "gross_margin_pct", "op": "change_pct_lt", "value": -3},
        {"field": "perf_52w_vs_spy", "op": "change_pct_lt", "value": -15},
    ], snapshot)
    assert already == []
    assert len(kept) == 2


def test_unevaluable_signal_is_kept_not_silently_discarded():
    kept, already = _drop_already_true(
        [{"field": "cash", "op": "<", "value": 1}], {"gross_margin_pct": 50})
    assert len(kept) == 1 and already == []


def test_drop_already_true_handles_empty():
    assert _drop_already_true(None, {}) == ([], [])
    assert _drop_already_true([], {"a": 1}) == ([], [])


def test_snapshot_only_buy_still_stores_null_break_signals():
    """The drop must not turn a snapshot-only buy's None into an empty array.

    `record_thesis` distinguishes source='auto' (no agent narrative or signals)
    from source='agent' partly by these columns being NULL, so rewriting None
    to [] silently changes what a snapshot-only row looks like. Pinned here
    because the first cut of the already-true drop did exactly that.
    """
    import theses

    calls: list[dict] = []

    class _Table:
        def update(self, payload):
            self._payload = payload
            return self

        def match(self, filters):
            calls.append({"op": "update", "payload": self._payload})
            return self

        def insert(self, payload):
            calls.append({"op": "insert", "payload": payload})
            return self

        def execute(self):
            return type("R", (), {"data": [{"id": 7}]})()

    class _Client:
        def table(self, _name):
            return _Table()

    class _DB:
        client = _Client()

    monkey = theses.build_snapshot
    theses.build_snapshot = lambda db, ticker: {"ticker": ticker}
    try:
        theses.record_thesis(_DB(), agent_id="A", ticker="NVDA")
    finally:
        theses.build_snapshot = monkey

    inserted = next(c["payload"] for c in calls if c["op"] == "insert")
    assert inserted["break_signals"] is None
    assert inserted["extend_signals"] is None
    assert inserted["source"] == "auto"
