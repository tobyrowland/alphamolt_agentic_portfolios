"""The heartbeat journal must survive whatever a strategy puts in its notes.

`RebalanceResult.notes` is a free-form bag; it is persisted whole into the
`agent_heartbeats.notes` JSONB column. In production a `datetime` reached it
(via `thesis_policy.resolve_policy`, which parsed the owner's re-buy-cooldown
exemption into a datetime and handed the whole policy dict to the reviewer's
notes). httpx's request encoder raised

    TypeError: Object of type datetime is not JSON serializable

*inside* the insert, so:

  * the journal row was never written,
  * `portfolio_agents.last_heartbeat_at` never advanced (the member was "due"
    on every subsequent run, forever),
  * the portfolio page's run-now panel waited for a journal that could not
    arrive and gave up at its 12-minute client timeout, and
  * the exception escaped `main()`, so every portfolio queued behind the
    failing one silently never rebalanced.

These tests pin the two guarantees that prevent a recurrence: the notes bag is
coerced to JSON-safe values before the write, and a journal write that fails
anyway never takes the process down.
"""

import json
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

import agent_heartbeat as hb
from agent_strategies import RebalanceResult


NOW = datetime(2026, 8, 26, 8, 55, tzinfo=timezone.utc)


class _RecordingDB:
    """Captures journal rows; optionally rejects non-JSON rows like PostgREST."""

    def __init__(self, *, strict: bool = True, fail_times: int = 0):
        self.rows: list[dict] = []
        self.strict = strict
        self.fail_times = fail_times
        self.attempts = 0
        self.member_clock: list[tuple] = []

    def insert_agent_heartbeat(self, row: dict) -> None:
        self.attempts += 1
        if self.attempts <= self.fail_times:
            raise RuntimeError("postgrest boom")
        if self.strict:
            # The real failure mode: the client json-encodes the row.
            json.dumps(row)
        self.rows.append(row)

    def update_agent_last_heartbeat(self, agent_id, when_iso) -> None:
        pass

    def update_portfolio_member_heartbeat(self, pid, aid, when_iso) -> None:
        self.member_clock.append((pid, aid, when_iso))


def _journal(db, notes: dict, **kw):
    result = RebalanceResult()
    result.notes.update(notes)
    hb._journal(
        db, agent_id="agent-1", strategy="portfolio_reviewer",
        started_at=NOW, status="ok", result=result,
        portfolio_id="pid-1", advance_agent=False, **kw,
    )


# ---------------------------------------------------------------------------
# The regression itself
# ---------------------------------------------------------------------------


def test_a_datetime_in_notes_does_not_break_the_journal_write():
    db = _RecordingDB()
    _journal(db, {"thesis_policy": {
        "grace_period_days": 30,
        "rebuy_cooldown_ignores_sells_before": datetime(
            2026, 8, 25, tzinfo=timezone.utc
        ),
    }})
    assert len(db.rows) == 1
    stored = db.rows[0]["notes"]["thesis_policy"]
    assert stored["rebuy_cooldown_ignores_sells_before"] == "2026-08-25T00:00:00+00:00"
    assert stored["grace_period_days"] == 30


def test_the_real_reviewer_policy_journals_cleanly():
    """End to end: what `policy_for_portfolio` returns must be journallable."""
    import thesis_policy as tp

    policy = tp.resolve_policy(
        {"rebuy_cooldown_ignores_sells_before": "2026-08-25T00:00:00Z"}
    )
    db = _RecordingDB()
    _journal(db, {"thesis_policy": policy})
    assert len(db.rows) == 1


@pytest.mark.parametrize("value,expected", [
    (datetime(2026, 8, 25, tzinfo=timezone.utc), "2026-08-25T00:00:00+00:00"),
    (date(2026, 8, 25), "2026-08-25"),
    (Decimal("12.5"), 12.5),
    ({"a", "b"}, None),          # set → list (order-insensitive, checked below)
    (object(), None),            # anything else → its str()
])
def test_every_leaf_is_coerced_to_something_json_can_hold(value, expected):
    out = hb._json_safe({"k": value})
    json.dumps(out)              # the assertion that matters
    if expected is not None:
        assert out["k"] == expected


def test_nesting_is_walked_not_just_the_top_level():
    out = hb._json_safe(
        {"a": [{"b": (datetime(2026, 1, 1, tzinfo=timezone.utc),)}]}
    )
    assert out == {"a": [{"b": ["2026-01-01T00:00:00+00:00"]}]}
    json.dumps(out)


def test_ordinary_notes_are_left_exactly_as_they_were():
    notes = {"verdicts": {"HOLD": 15, "SELL": 1}, "unpriced": ["ABC"],
             "reason": None, "ok": True, "pct": 4.5}
    assert hb._json_safe(notes) == notes


# ---------------------------------------------------------------------------
# A journal write that fails must not strand the run
# ---------------------------------------------------------------------------


def test_a_failing_write_is_retried_with_a_notes_bag_that_cannot_fail():
    db = _RecordingDB(fail_times=1)
    _journal(db, {"whatever": "value"}, triggered_by="run-now")
    assert db.attempts == 2
    assert len(db.rows) == 1
    notes = db.rows[0]["notes"]
    assert notes["portfolio_id"] == "pid-1"
    assert notes["triggered_by"] == "run-now"
    assert "journal_notes_dropped" in notes
    # The row still landed, so the member clock still advanced — which is what
    # stops the member being "due" on every subsequent run.
    assert [(p, a) for p, a, _ in db.member_clock] == [("pid-1", "agent-1")]


def test_a_write_that_fails_twice_never_escapes_to_kill_the_heartbeat():
    db = _RecordingDB(fail_times=99)
    _journal(db, {"whatever": "value"})     # must not raise
    assert db.rows == []
    assert db.member_clock == []            # nothing persisted, nothing claimed
