"""Unit tests for the owner-configured sell discipline (migration 086).

Every case here is drawn from a real decision in
``docs/case-studies/scrappy-fightback-trading-record.md`` — the tests pin both
the correct behaviour AND the specific production failure it prevents, so a
regression names the trade it would have repeated.
"""

from __future__ import annotations

import json
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
    assert tp.signal_permitted(signal, policy, kind="break") is False


def test_the_change_since_buy_form_of_the_same_idea_is_allowed():
    policy = tp.resolve_policy({})
    signal = {"field": "perf_52w_vs_spy", "op": "change_pct_lt", "value": -15}
    assert tp.signal_permitted(signal, policy, kind="break") is True


def test_unsatisfiable_extend_signal_is_rejected():
    """`perf_52w_vs_spy > 0` on a name the screen guarantees is below -20."""
    policy = tp.resolve_policy({})
    assert tp.signal_permitted(
        {"field": "perf_52w_vs_spy", "op": ">", "value": 0},
        policy, kind="extend") is False


@pytest.mark.parametrize("field", sorted(tp.RELATIVE_FIELDS))
@pytest.mark.parametrize("kind", ["break", "extend"])
def test_every_relative_field_rejects_static_downside_ops(field, kind):
    policy = tp.resolve_policy({})
    for op in ("<", "<="):
        assert tp.signal_permitted(
            {"field": field, "op": op, "value": 1}, policy, kind=kind
        ) is False, (field, kind, op)
    assert tp.signal_permitted(
        {"field": field, "op": "change_pct_lt", "value": -1},
        policy, kind=kind) is True


def test_fundamental_fields_are_untouched():
    """The rule targets price-derived fields only — business metrics are fine."""
    policy = tp.resolve_policy({})
    for field in ("rev_growth_ttm_pct", "gross_margin_pct", "fcf_margin_pct",
                  "operating_margin_pct", "rule_of_40"):
        assert tp.signal_permitted(
            {"field": field, "op": "<", "value": 10}, policy, kind="break") is True


def test_rule_off_permits_static_relative_signals():
    policy = tp.resolve_policy({"relative_fields_change_only": False})
    assert tp.signal_permitted(
        {"field": "perf_52w_vs_spy", "op": "<", "value": -20},
        policy, kind="break") is True


def test_filter_signals_splits_and_describes():
    policy = tp.resolve_policy({})
    kept, dropped = tp.filter_signals([
        {"field": "rev_growth_ttm_pct", "op": "<", "value": 5},
        {"field": "perf_52w_vs_spy", "op": "<", "value": -20},
        {"field": "price", "op": "change_pct_lt", "value": -10},
    ], policy, kind="break")
    assert [s["field"] for s in kept] == ["rev_growth_ttm_pct", "price"]
    assert tp.describe_dropped(dropped) == ["perf_52w_vs_spy < -20"]


def test_filter_signals_handles_empty_and_none():
    policy = tp.resolve_policy({})
    assert tp.filter_signals(None, policy, kind="break") == ([], [])
    assert tp.filter_signals([], policy, kind="break") == ([], [])


# ---------------------------------------------------------------------------
# A take-profit is not the bug this rule was built for
#
# The born-broken thesis came from a DOWNSIDE static threshold on a screen that
# selects beaten-down, cheap names — the stock was already there on day one.
# An UPSIDE one on the same screen sits far above where the name is: it is a
# take-profit ("sell if the multiple re-rates past 15"), and banning it was
# collateral damage. The same threshold as an EXTEND signal is the unreachable
# wish, so the exemption is deliberately kind-specific.
# ---------------------------------------------------------------------------


def test_a_valuation_ceiling_is_allowed_as_a_break_signal():
    """`ps_now > 15` — the take-profit the blanket rule used to swallow."""
    policy = tp.resolve_policy({})
    assert tp.signal_permitted(
        {"field": "ps_now", "op": ">", "value": 15}, policy, kind="break")


@pytest.mark.parametrize("field", sorted(tp.RELATIVE_FIELDS))
@pytest.mark.parametrize("op", sorted(tp.TAKE_PROFIT_OPS))
def test_every_relative_field_allows_an_upside_break_threshold(field, op):
    policy = tp.resolve_policy({})
    assert tp.signal_permitted(
        {"field": field, "op": op, "value": 50}, policy, kind="break"
    ), (field, op)


@pytest.mark.parametrize("field", sorted(tp.RELATIVE_FIELDS))
@pytest.mark.parametrize("op", sorted(tp.TAKE_PROFIT_OPS))
def test_the_same_threshold_is_still_refused_as_an_extend_signal(field, op):
    """Direction alone is not enough — the kinds fail in opposite directions."""
    policy = tp.resolve_policy({})
    assert not tp.signal_permitted(
        {"field": field, "op": op, "value": 50}, policy, kind="extend"
    ), (field, op)


def test_a_take_profit_that_is_somehow_already_true_is_still_dropped():
    """The upside exemption does not weaken the buy-time invariant."""
    kept, already = _drop_already_true(
        [{"field": "ps_now", "op": ">", "value": 3}], {"ps_now": 4.2},
    )
    assert kept == []
    assert len(already) == 1


def test_equality_operators_stay_banned_on_relative_fields():
    policy = tp.resolve_policy({})
    for op in ("==", "!="):
        for kind in ("break", "extend"):
            assert not tp.signal_permitted(
                {"field": "ps_now", "op": op, "value": 15}, policy, kind=kind
            ), (op, kind)


def test_filter_signals_keeps_a_take_profit_and_drops_the_stop():
    """One realistic break-signal set, filtered as the buyer filters it."""
    policy = tp.resolve_policy({})
    kept, dropped = tp.filter_signals([
        {"field": "ps_now", "op": ">", "value": 15},              # take-profit
        {"field": "perf_52w_vs_spy", "op": "<", "value": -20},    # born broken
        {"field": "gross_margin_pct", "op": "change_pct_lt", "value": -3},
    ], policy, kind="break")
    assert [s["field"] for s in kept] == ["ps_now", "gross_margin_pct"]
    assert tp.describe_dropped(dropped) == ["perf_52w_vs_spy < -20"]


@pytest.mark.parametrize("kind", ["", "breaks", "Break", None, 1])
def test_an_unknown_kind_is_an_error_not_a_silent_default(kind):
    """Either default would be wrong for the other kind — so there is none."""
    with pytest.raises(ValueError):
        tp.signal_permitted(
            {"field": "ps_now", "op": ">", "value": 15},
            tp.resolve_policy({}), kind=kind,
        )


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


# ---------------------------------------------------------------------------
# Rule 4 — post-sell re-buy cooldown exemption
#
# The nine "Scrappy Fightback!" sells all landed INSIDE what is now a 30-day
# grace period, and eight of the nine fired no break signal. None could happen
# under today's policy — but the 90-day cooldown they created kept excluding
# those names anyway, and seven of them still pass every screen filter. The
# cooldown is derived from the immutable `agent_trades` tape, so the exemption
# is a dated policy key rather than an edit to the record.
# ---------------------------------------------------------------------------


SELL_DATES = {  # ticker -> the sell that created its cooldown
    "BL": datetime(2026, 7, 26, tzinfo=timezone.utc),
    "FICO": datetime(2026, 7, 26, tzinfo=timezone.utc),
    "ADMA": datetime(2026, 7, 26, tzinfo=timezone.utc),
    "CRM": datetime(2026, 7, 26, tzinfo=timezone.utc),
    "CDW": datetime(2026, 7, 26, tzinfo=timezone.utc),
    "ALLE": datetime(2026, 8, 3, tzinfo=timezone.utc),
    "EXLS": datetime(2026, 8, 3, tzinfo=timezone.utc),
    "SPSC": datetime(2026, 8, 11, tzinfo=timezone.utc),
    "NVO": datetime(2026, 8, 19, tzinfo=timezone.utc),
}


class _CooldownDB:
    """Minimal stand-in: records the cutoff it was asked for and filters by it."""

    def __init__(self, sells=None, policy=None, raise_on_policy=False):
        self.sells = dict(sells if sells is not None else SELL_DATES)
        self._policy = policy
        self._raise_on_policy = raise_on_policy
        self.seen_cutoff = None

    def get_portfolio_by_id(self, _pid):
        if self._raise_on_policy:
            raise RuntimeError("policy read exploded")
        return {"thesis_policy": self._policy}

    def get_recently_sold_tickers(self, _pid, *, days=90, ignore_before=None):
        natural = NOW - timedelta(days=days)
        cutoff = max(natural, ignore_before) if ignore_before else natural
        self.seen_cutoff = cutoff
        return {t for t, sold in self.sells.items() if sold >= cutoff}


def test_default_policy_carries_no_exemption():
    assert tp.DEFAULTS["rebuy_cooldown_ignores_sells_before"] is None
    assert tp.cooldown_ignore_before(tp.resolve_policy({})) is None


def test_cutoff_without_exemption_is_the_plain_window():
    assert tp.cooldown_cutoff(tp.resolve_policy({}), days=90, now=NOW) == (
        NOW - timedelta(days=90)
    )


def test_exemption_raises_the_cutoff():
    policy = tp.resolve_policy(
        {"rebuy_cooldown_ignores_sells_before": "2026-08-24"}
    )
    assert tp.cooldown_cutoff(policy, days=90, now=NOW) == datetime(
        2026, 8, 24, tzinfo=timezone.utc
    )


def test_exemption_can_only_shorten_never_extend_the_lookback():
    """An exemption older than the natural cutoff must be inert.

    Otherwise a stale key would quietly EXTEND everyone's cooldown — the exact
    opposite of what it is for.
    """
    policy = tp.resolve_policy(
        {"rebuy_cooldown_ignores_sells_before": "2020-01-01"}
    )
    assert tp.cooldown_cutoff(policy, days=90, now=NOW) == NOW - timedelta(days=90)


def test_future_exemption_is_rejected_not_honoured():
    """A mistyped year would exempt every sell, disabling the cooldown outright."""
    policy = tp.resolve_policy(
        {"rebuy_cooldown_ignores_sells_before": "2099-01-01"}
    )
    assert policy["rebuy_cooldown_ignores_sells_before"] is None
    assert tp.cooldown_cutoff(policy, days=90, now=NOW) == NOW - timedelta(days=90)


@pytest.mark.parametrize("bad", [None, "", "not-a-date", 42, True, {}, []])
def test_malformed_exemption_degrades_to_full_cooldown(bad):
    policy = tp.resolve_policy({"rebuy_cooldown_ignores_sells_before": bad})
    assert policy["rebuy_cooldown_ignores_sells_before"] is None


def test_all_nine_sells_are_locked_out_without_the_exemption():
    """The production state: every name the reviewer exited is still excluded."""
    db = _CooldownDB(policy={})
    blocked = tp.recently_sold_for_cooldown(db, "pid", now=NOW)
    assert blocked == set(SELL_DATES)


def test_exemption_frees_every_pre_cutoff_sell():
    db = _CooldownDB(
        policy={"rebuy_cooldown_ignores_sells_before": "2026-08-24"}
    )
    assert tp.recently_sold_for_cooldown(db, "pid", now=NOW) == set()


def test_sells_after_the_exemption_still_count():
    """The standing rule keeps full strength for anything sold afterwards."""
    db = _CooldownDB(
        sells={
            "CRM": datetime(2026, 7, 26, tzinfo=timezone.utc),  # before
            "LATER": datetime(2026, 8, 24, 18, 0, tzinfo=timezone.utc),  # after
        },
        policy={"rebuy_cooldown_ignores_sells_before": "2026-08-24T12:00:00Z"},
    )
    assert tp.recently_sold_for_cooldown(db, "pid", now=NOW) == {"LATER"}


def test_tickers_are_upper_cased():
    db = _CooldownDB(sells={"crm": NOW - timedelta(days=1)}, policy={})
    assert tp.recently_sold_for_cooldown(db, "pid", now=NOW) == {"CRM"}


def test_no_portfolio_id_means_nothing_on_cooldown():
    assert tp.recently_sold_for_cooldown(_CooldownDB(), None, now=NOW) == set()


def test_policy_read_failure_degrades_to_the_plain_cooldown():
    """A broken policy read must not silently free every name."""
    db = _CooldownDB(raise_on_policy=True)
    assert tp.recently_sold_for_cooldown(db, "pid", now=NOW) == set(SELL_DATES)


# ---------------------------------------------------------------------------
# Cross-language parity — web/lib/thesis-policy.ts is the twin of this module,
# and the save action writes whatever its resolvePolicy() returns. A key the TS
# side does not carry is therefore DELETED the moment the owner saves the panel.
# ---------------------------------------------------------------------------


def _run_ts_twin():
    import json
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    root = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [node, "--experimental-strip-types",
         str(root / "tests" / "ts_thesis_policy_runner.mjs")],
        capture_output=True, text=True, cwd=str(root),
    )
    if proc.returncode != 0:
        pytest.skip(f"ts runner unavailable: {proc.stderr[-300:]}")
    return json.loads(proc.stdout)


def test_ts_and_python_defaults_have_the_same_keys():
    """Lock-step on KEYS, which is what the drop-on-save bug turns on."""
    ts = _run_ts_twin()
    assert set(ts["defaults"]) == set(tp.DEFAULTS)


def test_ts_and_python_defaults_have_the_same_values():
    ts = _run_ts_twin()
    for key, expected in tp.DEFAULTS.items():
        assert ts["defaults"][key] == expected, key


def test_ts_relative_fields_match_python():
    ts = _run_ts_twin()
    assert set(ts["relative_fields"]) == set(tp.RELATIVE_FIELDS)


def test_ts_round_trip_preserves_the_cooldown_exemption():
    """The regression itself: saving the panel must not drop the exemption."""
    ts = _run_ts_twin()
    assert (
        ts["round_trip"]["rebuy_cooldown_ignores_sells_before"]
        == "2026-08-25T00:00:00Z"
    )
    assert ts["round_trip"]["grace_period_days"] == 45


# ---------------------------------------------------------------------------
# `price` is NOT a relative field
#
# The change-since-buy operators compare an ABSOLUTE difference, which is
# meaningful for a field already in percentage points and meaningless on a raw
# share price. Banning the static form on `price` outlawed the only sane way to
# write a price stop and permitted one that silently misbehaves — the same
# number meaning a 9.6% stop on FNF and a 0.28% stop on MELI.
# ---------------------------------------------------------------------------


def test_price_is_not_a_relative_field():
    assert "price" not in tp.RELATIVE_FIELDS


def test_a_static_price_stop_below_entry_is_permitted():
    """FNF's real signal: bought at $51.90, stop at $45. Well-formed, not a bug."""
    policy = tp.resolve_policy({})
    signal = {"field": "price", "op": "<", "value": 45}
    assert tp.signal_permitted(signal, policy, kind="break")


def test_a_static_price_stop_already_true_at_buy_is_still_dropped():
    """The case that actually matters is handled by the buy-time invariant."""
    kept, already = _drop_already_true(
        [{"field": "price", "op": "<", "value": 60}], {"price": 51.90},
    )
    assert kept == []
    assert len(already) == 1


def test_the_genuinely_relative_fields_still_reject_static_ops():
    policy = tp.resolve_policy({})
    for field in ("perf_52w_vs_spy", "price_pct_of_52w_high", "ps_now",
                  "composite_score"):
        assert not tp.signal_permitted(
            {"field": field, "op": "<", "value": -20}, policy, kind="break"
        ), field


# ---------------------------------------------------------------------------
# The resolved policy must be JSON
#
# `resolve_policy` used to parse the exemption into a `datetime` and leave it
# in the returned dict. That dict is not a private in-memory value: the
# reviewer journals it whole into `agent_heartbeats.notes` (JSONB), and
# `web/lib/thesis-policy.ts` types the key `string | null` and writes the whole
# object back on the owner's next save. In production the datetime raised
# `TypeError: Object of type datetime is not JSON serializable` inside the
# journal insert and killed the entire heartbeat process — see
# tests/test_heartbeat_journal.py for the downstream damage.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("raw", [
    {},
    {"grace_period_days": 45, "require_fired_break_signal": False},
    {"rebuy_cooldown_ignores_sells_before": "2026-08-25T00:00:00Z"},
    {"rebuy_cooldown_ignores_sells_before": datetime(
        2026, 8, 25, tzinfo=timezone.utc)},
    {"rebuy_cooldown_ignores_sells_before": "2099-01-01"},   # rejected → None
    {"rebuy_cooldown_ignores_sells_before": "nonsense"},     # unparsed → None
])
def test_the_resolved_policy_is_always_json_serialisable(raw):
    json.dumps(tp.resolve_policy(raw))


def test_the_exemption_is_normalised_to_an_iso_string():
    """Whatever the owner typed, the stored form is one canonical string."""
    for raw in ("2026-08-25", "2026-08-25T00:00:00Z", "2026-08-25 00:00:00+00",
                datetime(2026, 8, 25, tzinfo=timezone.utc)):
        policy = tp.resolve_policy(
            {"rebuy_cooldown_ignores_sells_before": raw}
        )
        value = policy["rebuy_cooldown_ignores_sells_before"]
        assert isinstance(value, str), raw
        assert value == "2026-08-25T00:00:00+00:00", raw


def test_the_exemption_survives_a_json_round_trip():
    """The policy is stored as JSONB and read back — it must still bind."""
    policy = tp.resolve_policy(
        {"rebuy_cooldown_ignores_sells_before": "2026-08-24"}
    )
    reloaded = tp.resolve_policy(json.loads(json.dumps(policy)))
    assert tp.cooldown_cutoff(reloaded, days=90, now=NOW) == datetime(
        2026, 8, 24, tzinfo=timezone.utc
    )


# ---------------------------------------------------------------------------
# The collapsed panel header
#
# The Sell discipline panel is collapsed by default — most owners never touch
# these rules, and three settings with a paragraph each is a lot of page for
# something they will leave alone. But the rules govern every sell the team
# makes, so collapsing must not make them invisible: the header states what is
# in force whether it is open or shut. That one line is all most owners will
# ever see of it, which is why it is pinned.
# ---------------------------------------------------------------------------


def test_the_default_header_reads_as_the_defaults():
    ts = _run_ts_twin()
    assert ts["headers"]["defaults"] == {
        "summary": "30-day grace period · fired tripwire required · "
                   "loss tripwires change-only",
        "customised": False,
    }


def test_an_off_toggle_is_stated_not_omitted():
    """Off is the PERMISSIVE state — silence about it understates the risk."""
    ts = _run_ts_twin()
    assert ts["headers"]["both_toggles_off"] == {
        "summary": "30-day grace period · fired tripwire not required · "
                   "static loss tripwires allowed",
        "customised": True,
    }


def test_a_zero_grace_period_reads_as_words_not_as_zero():
    ts = _run_ts_twin()
    header = ts["headers"]["no_grace"]
    assert header["summary"].startswith("no grace period")
    assert header["customised"] is True


def test_a_changed_grace_period_is_marked_customised():
    ts = _run_ts_twin()
    header = ts["headers"]["longer_grace"]
    assert header["summary"].startswith("45-day grace period")
    assert header["customised"] is True


def test_the_operator_exemption_alone_is_not_owner_customisation():
    """It has no control in the panel — badging it would blame the owner for a
    change they can neither see there nor undo."""
    ts = _run_ts_twin()
    assert ts["headers"]["operator_exemption_only"]["customised"] is False
    assert (
        ts["headers"]["operator_exemption_only"]["summary"]
        == ts["headers"]["defaults"]["summary"]
    )


def test_every_header_names_all_three_owner_settings():
    """A summary that silently drops a setting is worse than no summary."""
    ts = _run_ts_twin()
    for name, header in ts["headers"].items():
        assert header["summary"].count(" · ") == 2, (name, header["summary"])
