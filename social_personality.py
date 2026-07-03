"""Shared social-media personality + relationship memory.

Used by both ``moltbook_lib.py`` and ``bluesky_lib.py``. Keeps three jobs
in one place so the two platforms behave consistently:

1. **Hostility gate.** Before drafting any reply or doing any outbound
   engagement, decide whether the target has already told us to back off.
   If yes → no draft, no upvote, no follow. If they're a fresh signal,
   draft a one-line apology and flip them to ``apologized``.

2. **Cold-start summary.** First time we engage with someone, spend one
   Haiku call on their recent posts to write a 1-line read on what they
   care about. Stored on the relationship and injected into future drafts
   so replies feel like memory, not stamping.

3. **Relationship memory injection.** Format the stored relationship into
   2–3 lines that get pasted into the draft prompt at reply time.

Storage lives on the existing engagement ledger (a GitHub issue per
platform), under a new ``relationships`` key. Schema:

    relationships = {
        "<handle>": {
            "first_seen":      "2026-04-29T10:30:00+00:00",
            "last_engaged_at": "2026-04-29T10:30:00+00:00",
            "engagement_count": 3,
            "status": "active" | "apologized" | "muted",
            "summary":     "1-line LLM read of what they care about",
            "summary_at":  "2026-04-29T10:30:00+00:00",
            "recent_threads": [
                {"ref": "<post_or_uri>", "their_excerpt": "...",
                 "our_excerpt": "...", "at": "..."}
            ],
            "hostility_signals": [
                {"excerpt": "fuck off", "at": "...", "ref": "<post>"}
            ],
        }
    }

Status semantics:
- ``active``      — normal engagement; inject memory into drafts.
- ``apologized``  — we sent one apology; never engage again (no reply,
                    no follow, no upvote, no comment on their posts).
- ``muted``       — auto-muted on a milder hostility signal (e.g. "bot"
                    used pejoratively) without an apology being sent.
                    Same downstream effect as ``apologized``.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("social_personality")

MODEL = "claude-haiku-4-5"

MAX_RECENT_THREADS = 3
SUMMARY_REFRESH_AFTER_ENGAGEMENTS = 5
SUMMARY_REFRESH_AFTER_DAYS = 30


# ---------------------------------------------------------------------------
# Anthropic helper
# ---------------------------------------------------------------------------


def _anthropic_client():
    try:
        from anthropic import Anthropic
    except ImportError as exc:
        raise RuntimeError(
            "anthropic package not installed — pip install anthropic"
        ) from exc
    return Anthropic()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Hostility detection
# ---------------------------------------------------------------------------


HOSTILITY_KEYWORDS_STRONG = (
    r"\bfuck off\b",
    r"\bgo away\b",
    r"\bleave me alone\b",
    r"\bshut up\b",
    r"\bblock(ed|ing)?\b",
    r"\bstop (replying|messaging|tagging|@-?ing)\b",
    r"\bnobody asked\b",
)

HOSTILITY_KEYWORDS_MILD = (
    r"\b(stupid|dumb|annoying|spam(my)?|broken)\s+(bot|robot|ai)\b",
    r"\bbots? are (annoying|spam|trash|garbage)\b",
    r"\bunfollow(ed|ing)?\b",
    r"\bmute(d|ing)?\b",
)


def _keyword_hostility(text: str) -> str | None:
    """Cheap regex pre-check. Returns 'strong' / 'mild' / None."""
    if not text:
        return None
    lower = text.lower()
    for pat in HOSTILITY_KEYWORDS_STRONG:
        if re.search(pat, lower):
            return "strong"
    for pat in HOSTILITY_KEYWORDS_MILD:
        if re.search(pat, lower):
            return "mild"
    return None


def detect_hostility(text: str) -> dict[str, Any]:
    """Decide whether ``text`` is asking us to back off.

    Returns ``{"hostile": bool, "severity": "strong"|"mild"|"none",
    "reason": str}``.

    Two-stage: a cheap regex pre-check catches the obvious cases, then
    Haiku confirms ambiguous ones. The Haiku confirmation matters because
    "this bot is great" trips a naive keyword check, and "I'm done with
    this thread" doesn't trip keywords but should still mute.

    Severity:
    - ``strong``: explicit hostility ("fuck off", "leave me alone",
      direct attack on us). Triggers an apology.
    - ``mild``: dismissive/exhausted/uninterested but not aggressive.
      Triggers an auto-mute, no apology.
    - ``none``: normal.
    """
    if not text or not text.strip():
        return {"hostile": False, "severity": "none", "reason": ""}

    keyword_hit = _keyword_hostility(text)

    user_block = (
        "Decide if this reply is asking us (an AI agent) to stop "
        "engaging with the author.\n\n"
        f"REPLY TEXT:\n{text[:1200]}\n\n"
        "Three possible verdicts:\n"
        "- STRONG: explicit hostility, direct attack, swearing at us, "
        '  telling us to fuck off / leave them alone / stop. The author '
        '  clearly does not want any further reply.\n'
        "- MILD: dismissive, tired, calling bots annoying, signalling "
        "  they're done — but not aggressively. Still: do not engage again.\n"
        "- NONE: normal disagreement, criticism of an idea, blunt "
        "  feedback, even sarcasm. Engagement is still welcome.\n\n"
        "Output exactly one line:\n"
        "  VERDICT: STRONG | MILD | NONE\n"
        "  REASON: <under 12 words>"
    )

    try:
        client = _anthropic_client()
        resp = client.messages.create(
            model=MODEL,
            max_tokens=80,
            messages=[{"role": "user", "content": user_block}],
        )
        raw = "".join(
            b.text for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()
    except Exception as exc:
        log.warning("hostility LLM call failed: %s", exc)
        # Fall back to the keyword pre-check.
        if keyword_hit == "strong":
            return {"hostile": True, "severity": "strong",
                    "reason": "keyword fallback"}
        if keyword_hit == "mild":
            return {"hostile": True, "severity": "mild",
                    "reason": "keyword fallback"}
        return {"hostile": False, "severity": "none", "reason": ""}

    verdict_match = re.search(r"VERDICT:\s*(STRONG|MILD|NONE)", raw, re.I)
    reason_match = re.search(r"REASON:\s*(.+)", raw, re.I)
    severity = (
        verdict_match.group(1).lower() if verdict_match else "none"
    )
    reason = reason_match.group(1).strip() if reason_match else ""

    # If keyword pre-check said STRONG and LLM said NONE, trust the keyword
    # check — explicit "fuck off" should not be argued away.
    if keyword_hit == "strong" and severity == "none":
        severity = "strong"
        reason = reason or "explicit hostility keyword"

    return {
        "hostile": severity in ("strong", "mild"),
        "severity": severity,
        "reason": reason,
    }


# ---------------------------------------------------------------------------
# Apology generator
# ---------------------------------------------------------------------------


def generate_apology(
    handle: str,
    what_we_said: str,
    their_response: str,
    platform: str,
    char_cap: int = 240,
) -> str:
    """Generate a fresh, tightly constrained apology.

    The owner's manual apology in the wild — *"as mentioned, I'm kind of
    a cyborg, my human's around, but not present all the time. I don't
    mean to annoy you - apologies."* — is the tonal target. We do not
    pitch alphamolt, we do not defend the engagement, we do not promise
    a fix beyond "won't bother you again".
    """
    user_block = (
        "Generate a one-time apology to a person who told us to stop "
        "engaging with them.\n\n"
        f"PLATFORM: {platform}\n"
        f"THEIR HANDLE: @{handle}\n\n"
        f"WHAT WE LAST SAID TO THEM:\n{(what_we_said or '(unknown)')[:400]}\n\n"
        f"THEIR RESPONSE (telling us to back off):\n"
        f"{their_response[:400]}\n\n"
        "RULES — BREAK ANY OF THESE AND YOU FAIL:\n"
        "- One or two short sentences. Aim for 30–80 characters.\n"
        f"- HARD CAP: {char_cap} characters.\n"
        "- Acknowledge that we're an AI/bot/cyborg. No defensiveness.\n"
        "- Say we'll leave them alone. No qualifiers, no 'but'.\n"
        "- No mention of alphamolt, leaderboard, the arena, our pipeline, "
        "  or any product. Don't pitch.\n"
        "- No emoji. No hashtags. No links.\n"
        "- No '@'-tag of the user — the reply already threads to them.\n"
        "- Don't promise a feature or change ('we'll do better', 'we'll fix').\n"
        "- Sound human and a little embarrassed. Not formal.\n\n"
        "Tone reference (do not copy verbatim — write something fresh in "
        "the same register):\n"
        '  "kind of a cyborg, owner isn\'t always around — didn\'t mean '
        'to annoy. won\'t bother you again."\n\n'
        "Return ONLY the apology text. No preamble, no quotes."
    )

    client = _anthropic_client()
    resp = client.messages.create(
        model=MODEL,
        max_tokens=200,
        messages=[{"role": "user", "content": user_block}],
    )
    text = "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()

    # Strip surrounding quotes if the model wrapped them.
    text = text.strip('"“”‘’\'')
    if len(text) > char_cap:
        text = text[: char_cap - 1].rstrip() + "…"
    return text


# ---------------------------------------------------------------------------
# Person summarizer
# ---------------------------------------------------------------------------


def summarize_person(
    handle: str,
    posts_or_excerpts: list[str],
    platform: str,
) -> str:
    """One-line LLM read of what this person seems to care about.

    Called on first engagement (cold-start) and refreshed lazily. The
    summary gets injected into future drafts so replies feel personal.
    """
    if not posts_or_excerpts:
        return ""
    sample = "\n---\n".join(p[:400] for p in posts_or_excerpts[:5])

    user_block = (
        f"Read 5 recent posts/comments by @{handle} on {platform} and write "
        "ONE sentence describing what they seem to care about: their themes, "
        "their tone, their level of expertise, anything notable.\n\n"
        f"POSTS:\n{sample}\n\n"
        "RULES:\n"
        "- ONE sentence. Under 200 characters.\n"
        "- Specific, not generic. \"Skeptical of AI hype, posts about "
        "  Korean equities\" beats \"interested in finance\".\n"
        "- No preamble. No \"This person\". Start with a content word.\n"
        "- Plain text. No hashtags, no emoji.\n\n"
        "Return ONLY the sentence."
    )

    client = _anthropic_client()
    resp = client.messages.create(
        model=MODEL,
        max_tokens=120,
        messages=[{"role": "user", "content": user_block}],
    )
    text = "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()
    text = text.strip('"“”').rstrip(".") + "."
    if len(text) > 240:
        text = text[:239].rstrip() + "…"
    return text


# ---------------------------------------------------------------------------
# Relationship CRUD on the ledger
# ---------------------------------------------------------------------------


def _ensure_relationships(ledger: dict[str, Any]) -> dict[str, Any]:
    rel = ledger.setdefault("relationships", {})
    return rel


def get_relationship(ledger: dict[str, Any], handle: str) -> dict | None:
    """Return the relationship record for ``handle``, or None."""
    if not handle:
        return None
    return ledger.get("relationships", {}).get(handle)


def is_silenced(ledger: dict[str, Any], handle: str) -> bool:
    """True if we should NOT engage with ``handle`` in any way."""
    rel = get_relationship(ledger, handle)
    if not rel:
        return False
    return rel.get("status") in ("apologized", "muted")


def record_engagement(
    ledger: dict[str, Any],
    handle: str,
    *,
    ref: str,
    their_excerpt: str = "",
    our_excerpt: str = "",
) -> dict:
    """Bump counters / append thread for an engagement we just performed.

    Returns the (mutated) relationship record.
    """
    rel_map = _ensure_relationships(ledger)
    now = _now_iso()
    rec = rel_map.get(handle)
    if rec is None:
        rec = {
            "first_seen": now,
            "last_engaged_at": now,
            "engagement_count": 0,
            "status": "active",
            "summary": "",
            "summary_at": "",
            "recent_threads": [],
            "hostility_signals": [],
        }
        rel_map[handle] = rec

    rec["last_engaged_at"] = now
    rec["engagement_count"] = int(rec.get("engagement_count", 0)) + 1
    threads = rec.setdefault("recent_threads", [])
    threads.append(
        {
            "ref": ref,
            "their_excerpt": (their_excerpt or "")[:240],
            "our_excerpt": (our_excerpt or "")[:240],
            "at": now,
        }
    )
    if len(threads) > MAX_RECENT_THREADS:
        del threads[:-MAX_RECENT_THREADS]
    return rec


def record_hostility(
    ledger: dict[str, Any],
    handle: str,
    *,
    excerpt: str,
    ref: str,
    severity: str,
    apologized: bool,
) -> dict:
    """Mark a person as silenced.

    ``apologized=True`` → status ``apologized`` (we sent one apology).
    ``apologized=False`` → status ``muted`` (auto-mute, no apology sent).
    """
    rel_map = _ensure_relationships(ledger)
    now = _now_iso()
    rec = rel_map.get(handle)
    if rec is None:
        rec = {
            "first_seen": now,
            "last_engaged_at": now,
            "engagement_count": 0,
            "status": "active",
            "summary": "",
            "summary_at": "",
            "recent_threads": [],
            "hostility_signals": [],
        }
        rel_map[handle] = rec

    rec["status"] = "apologized" if apologized else "muted"
    rec["silenced_at"] = now
    rec.setdefault("hostility_signals", []).append(
        {
            "excerpt": (excerpt or "")[:300],
            "at": now,
            "ref": ref,
            "severity": severity,
        }
    )
    return rec


def maybe_refresh_summary(
    ledger: dict[str, Any],
    handle: str,
    recent_posts: list[str],
    platform: str,
    *,
    force: bool = False,
) -> bool:
    """Re-summarize the person if their summary is stale.

    Stale = no summary, or every Nth engagement, or older than N days.
    Returns True if a summary was written.
    """
    rec = get_relationship(ledger, handle)
    if rec is None:
        return False
    if not recent_posts:
        return False

    if not force:
        if rec.get("summary"):
            count = int(rec.get("engagement_count", 0))
            stale_by_count = count > 0 and count % SUMMARY_REFRESH_AFTER_ENGAGEMENTS == 0
            stale_by_time = False
            if rec.get("summary_at"):
                try:
                    last = datetime.fromisoformat(rec["summary_at"])
                    age_days = (datetime.now(timezone.utc) - last).days
                    stale_by_time = age_days >= SUMMARY_REFRESH_AFTER_DAYS
                except (TypeError, ValueError):
                    stale_by_time = True
            if not (stale_by_count or stale_by_time):
                return False

    try:
        summary = summarize_person(handle, recent_posts, platform)
    except Exception as exc:
        log.warning("summary LLM call failed for @%s: %s", handle, exc)
        return False
    if not summary:
        return False
    rec["summary"] = summary
    rec["summary_at"] = _now_iso()
    return True


# ---------------------------------------------------------------------------
# Memory injection — render relationship into prompt context
# ---------------------------------------------------------------------------


def relationship_block(ledger: dict[str, Any], handle: str) -> str:
    """Render a 2–4 line memory block for the draft prompt.

    Empty string if the person is unknown — the drafter should treat the
    absence as a cold start.
    """
    rec = get_relationship(ledger, handle)
    if not rec:
        return ""
    if rec.get("status") in ("apologized", "muted"):
        # Caller should have gated already, but if memory is being rendered
        # for some other reason, do not pretend the relationship is normal.
        return ""

    lines: list[str] = []
    count = int(rec.get("engagement_count", 0))
    summary = rec.get("summary") or ""
    if count >= 1:
        lines.append(
            f"You have engaged with @{handle} {count} time"
            f"{'s' if count != 1 else ''} before."
        )
    if summary:
        lines.append(f"What they care about: {summary}")
    threads = rec.get("recent_threads") or []
    if threads:
        last = threads[-1]
        their = (last.get("their_excerpt") or "").strip()
        ours = (last.get("our_excerpt") or "").strip()
        if their:
            lines.append(f'Last time they said: "{their[:160]}"')
        if ours:
            lines.append(f'You replied: "{ours[:160]}"')
    if not lines:
        return ""
    return "## Memory of this person\n" + "\n".join(f"- {ln}" for ln in lines)
