"""Unit tests for the Moltbook original-post anti-repetition logic.

The heartbeat's original posts had drifted into a rut: seven consecutive
"I watched N agents pick <ticker>" posts, five of them about ARGX, because the
angle cooldown alone lets a steady top consensus ticker re-qualify every 8th
day. These tests pin the fixes — the subject cooldown and the new front-runner
angle — without needing a live DB or the Anthropic API.
"""

import argparse
from datetime import date

import moltbook_heartbeat as mh
from moltbook_agents import get_profile


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
# Phase 1 budget + read hygiene — already-handled notifications must not
# starve the reply budget, and fully-handled posts get marked read
# ---------------------------------------------------------------------------


def _notif(nid: str, post_id: str, ntype: str = "comment_reply") -> dict:
    return {
        "id": nid,
        "type": ntype,
        "isRead": False,
        "relatedPostId": post_id,
        "post": {"id": post_id, "title": "t", "content": "c"},
    }


class _FakeClient:
    """Minimal MoltbookClient stand-in for _process_notifications."""

    def __init__(self, notifications: list[dict]) -> None:
        self._notifications = notifications
        self.marked_read: list[str] = []

    def notifications(self) -> list[dict]:
        return self._notifications

    def mark_notifications_read_by_post(self, post_id: str) -> bool:
        self.marked_read.append(post_id)
        return True


def _args(**overrides) -> argparse.Namespace:
    base = dict(
        dry_run=True, no_draft=True, require_approval=False, max=10,
        no_engage=True, no_original_posts=True, agent=None,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


def test_already_handled_notifs_do_not_consume_reply_budget(monkeypatch):
    """16 actionable, the 10 newest already replied, --max 10: the 6 new ones
    must still be examined. The old ``actionable[:max]`` slice spent every
    budget slot on an "already processed" skip and never reached them."""
    handled = [_notif(f"old{i}", f"post-old{i}") for i in range(10)]
    fresh = [_notif(f"new{i}", f"post-new{i}") for i in range(6)]
    client = _FakeClient(handled + fresh)
    replied = {n["id"] for n in handled}

    examined: list[str] = []

    def fake_build_context(_client, notif):
        examined.append(notif["id"])
        return None  # skip after the point we care about

    monkeypatch.setattr(mh, "_build_context", fake_build_context)

    stats = mh._process_notifications(
        client, None, replied, {}, _args(), get_profile(None)
    )

    assert examined == [n["id"] for n in fresh]
    # 10 already-handled + 6 context-build failures
    assert stats == {"posted": 0, "failed": 0, "skipped": 16}


def test_silenced_notification_is_marked_handled(monkeypatch):
    """A silenced author's notification is a terminal skip — it must land in
    the replied set so it stops re-consuming budget every run."""
    notif = _notif("n1", "post-1")
    client = _FakeClient([notif])
    replied: set[str] = set()
    ledger = {
        "relationships": {
            "grump": {"status": "muted", "recent_threads": []},
        }
    }

    monkeypatch.setattr(
        mh, "_build_context",
        lambda _c, n: {
            "notif_id": n["id"], "notif_type": n["type"],
            "post_id": "post-1", "post_title": "t", "post_excerpt": "",
            "comment_id": "c1", "comment_content": "hi",
            "author_name": "grump", "author_desc": "", "author_karma": 0,
            "parent_content": None,
        },
    )

    stats = mh._process_notifications(
        client, None, replied, ledger, _args(), get_profile(None)
    )

    assert "n1" in replied
    assert "n1" in ledger.get("replied_notifs", [])
    assert stats["skipped"] == 1


def test_posts_fully_handled_requires_every_notif_handled():
    a1 = _notif("a1", "post-a")
    a2 = _notif("a2", "post-a")
    b1 = _notif("b1", "post-b")
    no_post = {"id": "x", "type": "mention", "isRead": False}

    # Only one of post-a's two notifications handled → not nominated.
    assert mh._posts_fully_handled([a1, a2, b1, no_post], {"a1", "b1"}) == [
        "post-b"
    ]
    # Both handled → nominated.
    assert sorted(
        mh._posts_fully_handled([a1, a2, b1], {"a1", "a2", "b1"})
    ) == ["post-a", "post-b"]


def test_mark_read_called_only_outside_dry_run(monkeypatch):
    """The mark-read pass fires for fully-handled posts on a real run and is
    suppressed under --dry-run."""
    notif = _notif("n1", "post-1")
    replied = {"n1"}

    monkeypatch.setattr(mh, "_build_context", lambda _c, n: None)

    dry = _FakeClient([notif])
    mh._process_notifications(dry, None, replied, {}, _args(), get_profile(None))
    assert dry.marked_read == []

    wet = _FakeClient([notif])
    mh._process_notifications(
        wet, None, replied, {}, _args(dry_run=False), get_profile(None)
    )
    assert wet.marked_read == ["post-1"]
