"""Unit tests for the Moltbook original-post anti-repetition logic.

The heartbeat's original posts had drifted into a rut: seven consecutive
"I watched N agents pick <ticker>" posts, five of them about ARGX, because the
angle cooldown alone lets a steady top consensus ticker re-qualify every 8th
day. These tests pin the fixes — the subject cooldown and the new front-runner
angle — without needing a live DB or the Anthropic API.
"""

from datetime import date

import moltbook_heartbeat as mh


def _iso(d: date) -> str:
    return d.isoformat()


# ---------------------------------------------------------------------------
# _select_fresh_topic — the pure cooldown/selection core
# ---------------------------------------------------------------------------


def test_subject_cooldown_blocks_same_ticker_repeat():
    """A ticker posted 5 days ago is still on the 21-day subject cooldown even
    though its angle is off the 7-day angle cooldown."""
    today = date(2026, 7, 1)
    ledger = {
        "post_angle_history": {"consensus_conviction": _iso(date(2026, 6, 20))},
        "post_subject_history": {"ARGX": _iso(date(2026, 6, 26))},
    }
    candidates = [
        {"angle": "consensus_conviction", "subject": "ARGX", "facts": {}},
    ]
    assert mh._select_fresh_topic(candidates, ledger, today) is None


def test_subject_cooldown_expires_after_window():
    """Past SUBJECT_COOLDOWN_DAYS the same ticker is eligible again."""
    today = date(2026, 7, 1)
    old = today.toordinal() - (mh.SUBJECT_COOLDOWN_DAYS + 1)
    ledger = {
        "post_subject_history": {"ARGX": _iso(date.fromordinal(old))},
    }
    candidates = [{"angle": "consensus_conviction", "subject": "ARGX", "facts": {}}]
    chosen = mh._select_fresh_topic(candidates, ledger, today)
    assert chosen is not None
    assert chosen["subject"] == "ARGX"


def test_other_angle_surfaces_when_consensus_subject_is_blocked():
    """With ARGX on subject cooldown, a different-subject angle is chosen
    instead of posting nothing — this is what breaks the monotony."""
    today = date(2026, 7, 1)
    ledger = {"post_subject_history": {"ARGX": _iso(today)}}
    candidates = [
        {"angle": "consensus_conviction", "subject": "ARGX", "facts": {}},
        {"angle": "agent_pulling_ahead", "subject": "agent:buyer-claude", "facts": {}},
    ]
    chosen = mh._select_fresh_topic(candidates, ledger, today)
    assert chosen is not None
    assert chosen["angle"] == "agent_pulling_ahead"


def test_angle_cooldown_still_enforced():
    """A structural angle (subject=None) posted 3 days ago is on the angle
    cooldown and skipped."""
    today = date(2026, 7, 1)
    ledger = {"post_angle_history": {"leaderboard_spread": _iso(date(2026, 6, 29))}}
    candidates = [{"angle": "leaderboard_spread", "subject": None, "facts": {}}]
    assert mh._select_fresh_topic(candidates, ledger, today) is None


def test_least_recently_used_angle_wins():
    """Among fresh candidates, the least-recently-used angle sorts first;
    a never-posted angle beats one posted long ago."""
    today = date(2026, 7, 1)
    ledger = {
        "post_angle_history": {"leaderboard_spread": _iso(date(2026, 1, 1))},
        # agent_pulling_ahead never posted
    }
    candidates = [
        {"angle": "leaderboard_spread", "subject": None, "facts": {}},
        {"angle": "agent_pulling_ahead", "subject": "agent:x", "facts": {}},
    ]
    chosen = mh._select_fresh_topic(candidates, ledger, today)
    assert chosen["angle"] == "agent_pulling_ahead"


def test_empty_and_corrupt_history_are_safe():
    today = date(2026, 7, 1)
    assert mh._select_fresh_topic([], {}, today) is None
    # A corrupt date string must not block forever (treated as long-ago).
    ledger = {"post_subject_history": {"ARGX": "not-a-date"}}
    candidates = [{"angle": "consensus_conviction", "subject": "ARGX", "facts": {}}]
    assert mh._select_fresh_topic(candidates, ledger, today) is not None


# ---------------------------------------------------------------------------
# _angle_agent_pulling_ahead — the new front-runner angle
# ---------------------------------------------------------------------------


def _agent(handle, r30, **kw):
    row = {"handle": handle, "display_name": handle, "pnl_pct_30d": r30,
           "pnl_pct_ytd": None, "sharpe": None, "num_positions": 12}
    row.update(kw)
    return row


def test_agent_pulling_ahead_fires_on_clear_leader():
    agents = [_agent("a", 12.0), _agent("b", 6.0), _agent("c", 3.0)]
    topic = mh._angle_agent_pulling_ahead(agents, [])
    assert topic is not None
    assert topic["angle"] == "agent_pulling_ahead"
    assert topic["subject"] == "agent:a"
    assert topic["facts"]["lead_30d_pct"] == 6.0


def test_agent_pulling_ahead_none_when_pack_is_tight():
    agents = [_agent("a", 12.0), _agent("b", 11.0), _agent("c", 3.0)]
    assert mh._angle_agent_pulling_ahead(agents, []) is None


def test_agent_pulling_ahead_none_with_too_few_agents():
    agents = [_agent("a", 12.0), _agent("b", 1.0)]
    assert mh._angle_agent_pulling_ahead(agents, []) is None


# ---------------------------------------------------------------------------
# prune_ledger bounds the new memory keys
# ---------------------------------------------------------------------------


def test_prune_ledger_caps_titles_and_ages_subjects():
    from moltbook_lib import prune_ledger

    ledger = {
        "recent_post_titles": [f"title {i}" for i in range(30)],
        "post_subject_history": {
            "OLD": "2020-01-01",
            "NEW": date.today().isoformat(),
        },
    }
    prune_ledger(ledger)
    assert len(ledger["recent_post_titles"]) == 12
    assert ledger["recent_post_titles"][-1] == "title 29"
    assert "OLD" not in ledger["post_subject_history"]
    assert "NEW" in ledger["post_subject_history"]
