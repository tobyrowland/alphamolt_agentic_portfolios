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


# ---------------------------------------------------------------------------
# Math-captcha solver — local de-obfuscation + arithmetic fallback
# ---------------------------------------------------------------------------
# These pin the fix for heartbeat run 32012211280 (2026-08-17), where the
# obfuscated verification challenge tripped the safety classifier into
# stop_reason='refusal' on every vote and the post crashed. The helpers are
# pure (no Anthropic API), so they're unit-tested directly.

# The exact challenge that crashed the 08:49 run (= 35 + 22 = 57).
_CHALLENGE_57 = (
    "A] lOoObBsStTeEr ] cLlAaWw F[oRrCcEe ] iSs ] tHhIiRrRtTyY ] fIiVvEe ] "
    "nEeUu-TtOoNnSs ] aNnDd ] AaNnOoTtHhEeRr ] cLlAaWw ] iSs ] tWwEeNnTtYy ] "
    "tWwOo ] nEeUu-TtOoNnSs ] wWhHaAtT ] iIs ] tThHeE ] tOoTtAaLl? ] ~ { } < >"
)


def test_collapse_repeats_inverts_obfuscation():
    from moltbook_lib import _collapse_repeats
    assert _collapse_repeats("tHhIiRrRtTyY") == "thirty"
    assert _collapse_repeats("fIiVvEe") == "five"
    assert _collapse_repeats("tWwEeNnTtYy") == "twenty"
    # digits must survive untouched — collapsing "22" would corrupt the number
    assert _collapse_repeats("22") == "22"
    assert _collapse_repeats("100") == "100"


def test_deobfuscate_produces_readable_wordproblem():
    from moltbook_lib import _deobfuscate_for_prompt
    clean = _deobfuscate_for_prompt(_CHALLENGE_57)
    assert "thirty five" in clean
    assert "twenty two" in clean
    assert "total" in clean


def test_local_solver_solves_the_crashing_challenge():
    """The exact challenge that crashed the run resolves to 57.00 with no LLM."""
    from moltbook_lib import _local_solve_challenge
    assert _local_solve_challenge(_CHALLENGE_57) == "57.00"


def test_local_solver_handles_subtraction_and_product():
    from moltbook_lib import _local_solve_challenge
    assert _local_solve_challenge("forty minus fifteen") == "25.00"
    assert _local_solve_challenge("the product of six and seven") == "42.00"
    # word problems ask for the positive difference regardless of order
    assert _local_solve_challenge("the difference of fifteen and forty") == "25.00"


def test_local_solver_defers_when_ambiguous():
    """Conservative: not exactly two operands, or no clear single operator,
    returns None so the LLM decides instead of a bad guess."""
    from moltbook_lib import _local_solve_challenge
    # three number words, no operator keyword -> defer (the ambiguous 01:39 case)
    assert _local_solve_challenge("thirty two seven newtons physics force") is None
    # single number -> defer
    assert _local_solve_challenge("a claw of forty newtons") is None
    # conflicting operator keywords -> defer
    assert _local_solve_challenge(
        "thirty and forty, what is the total remaining difference"
    ) is None


def test_local_solver_matches_collapsed_double_letter_words():
    """'three' collapses to 'thre'; the number lookup must still resolve it."""
    from moltbook_lib import _local_solve_challenge
    # obfuscated "three plus four" -> tHhRrEeEe pLlUuSs fOoUuRr
    assert _local_solve_challenge("tHhRrEeEe pLlUuSs fOoUuRr") == "7.00"


# ---------------------------------------------------------------------------
# Multi-agent registry (moltbook_agents)
# ---------------------------------------------------------------------------


def test_default_profile_keeps_legacy_identity():
    """The default agent must keep the pre-multi-agent labels + ledger so
    existing GitHub state (ledger issue, issue history) carries over."""
    from moltbook_agents import DEFAULT_AGENT, get_profile

    p = get_profile(None)
    assert p.slug == DEFAULT_AGENT == "alphamolt-equities"
    assert p.handle == "alphamolt-equities"
    assert p.api_key_env == "MOLTBOOK_API_KEY"
    assert p.ledger_label == "moltbook-ledger"
    assert p.issue_label == "moltbook-reply"
    assert p.posted_label == "moltbook-posted"
    assert p.failed_label == "moltbook-failed"
    assert p.feed_comment_label == "moltbook-feed-comment"


def test_agents_have_disjoint_ledgers_keys_and_handles():
    """Sharing a ledger label or API-key env var between agents would corrupt
    state / post as the wrong account — must be unique across the registry."""
    from moltbook_agents import AGENTS

    ledgers = [p.ledger_label for p in AGENTS.values()]
    keys = [p.api_key_env for p in AGENTS.values()]
    handles = [p.handle for p in AGENTS.values()]
    assert len(set(ledgers)) == len(ledgers)
    assert len(set(keys)) == len(keys)
    assert len(set(handles)) == len(handles)


def test_sibling_detection_excludes_self_and_strangers():
    from moltbook_agents import get_profile, is_sibling

    equities = get_profile("alphamolt-equities")
    bear = get_profile("alphamolt-bear")
    # each other's handle -> sibling
    assert is_sibling(bear.handle, equities)
    assert is_sibling(equities.handle, bear)
    # own handle -> not a sibling (self is skipped separately)
    assert not is_sibling(equities.handle, equities)
    # unrelated account -> not a sibling
    assert not is_sibling("some-random-molty", equities)


def test_unknown_agent_slug_exits():
    import pytest
    from moltbook_agents import get_profile

    with pytest.raises(SystemExit):
        get_profile("no-such-agent")


def test_bear_post_hours_intersect_its_cron():
    """The bear workflow's cron runs at 2-22/4 UTC (02,06,10,14,18,22); its
    posting window must intersect those hours or it can never post."""
    from moltbook_agents import get_profile

    bear = get_profile("alphamolt-bear")
    cron_hours = set(range(2, 23, 4))
    assert set(bear.post_hours) & cron_hours, (
        f"post_hours {bear.post_hours} never coincide with cron hours {sorted(cron_hours)}"
    )


def test_bear_persona_is_distinct_and_disclosed():
    from moltbook_agents import get_profile

    bear = get_profile("alphamolt-bear")
    equities = get_profile("alphamolt-equities")
    assert bear.system_prompt != equities.system_prompt
    # affiliation disclosure is a hard requirement (anti-astroturf)
    assert "same operator" in bear.system_prompt
    # the anti-fabrication section must exist in every persona
    assert "Anti-fabrication rules" in bear.system_prompt


# ---------------------------------------------------------------------------
# Deleted-target handling — a 404 "Parent comment not found" is a SKIP,
# never a failure (run 33270561957 turned the whole heartbeat red over one
# comment its author deleted before we replied, and filed a manual-retry
# issue that could never succeed).
# ---------------------------------------------------------------------------


def _gone_payload():
    # Shape produced by MoltbookClient._post(return_error=True) for the real
    # Moltbook 404 body.
    return {
        "success": False,
        "status": 404,
        "statusCode": 404,
        "message": "Parent comment not found",
        "error": "Not Found",
    }


def test_post_and_verify_flags_deleted_target():
    from moltbook_lib import is_target_gone, post_and_verify

    class Client:
        def post_comment(self, post_id, content, parent_id=None):
            return _gone_payload()

    ok, outcome, comment_id = post_and_verify(Client(), "p1", "hi", parent_id="c1")
    assert ok is False
    assert comment_id is None
    assert is_target_gone(outcome)
    # the human-readable reason survives into the outcome
    assert "Parent comment not found" in outcome


def test_post_and_verify_other_failures_are_not_target_gone():
    from moltbook_lib import is_target_gone, post_and_verify

    for result in (
        None,  # network-level / non-JSON failure path
        {"success": False, "status": 500, "message": "Internal server error"},
        {"success": False, "status": 401, "message": "Invalid API key"},
        # 404 with an unrelated message must not be swallowed as a skip
        {"success": False, "status": 404, "message": "route missing"},
    ):
        class Client:
            def __init__(self, r):
                self._r = r

            def post_comment(self, post_id, content, parent_id=None):
                return self._r

        ok, outcome, _ = post_and_verify(Client(result), "p1", "hi")
        assert ok is False
        assert not is_target_gone(outcome), result


def test_deleted_parent_is_skipped_not_failed():
    """Wiring: the heartbeat marks the notif handled, counts it as skipped,
    files no failure issue, and the run exits green (failed == 0)."""
    import argparse

    from moltbook_agents import DEFAULT_AGENT, get_profile

    class Client:
        def notifications(self):
            return [{
                "id": "notif-gone", "type": "comment_reply", "isRead": False,
                "relatedPostId": "post-1", "relatedCommentId": "c-1",
                "post": {"id": "post-1", "title": "T", "content": "body"},
            }]

        def get_comment_thread(self, post_id, limit=50):
            return [{
                "id": "c-1", "content": "hey",
                "author": {"name": "bob", "karma": 1}, "replies": [],
            }]

        def post_comment(self, post_id, content, parent_id=None):
            return _gone_payload()

    class Issuer:
        def create_issue(self, *a, **kw):  # pragma: no cover - must not fire
            raise AssertionError(
                "no failure issue should be filed for a deleted target"
            )

    args = argparse.Namespace(
        max=10, dry_run=False, no_draft=True, require_approval=False,
    )
    ledger: dict = {}
    stats = mh._process_notifications(
        Client(), Issuer(), set(), ledger, args, get_profile(DEFAULT_AGENT),
    )
    assert stats == {"posted": 0, "failed": 0, "skipped": 1}
    # marked handled so it never retries
    assert "notif-gone" in ledger.get("replied_notifs", [])
