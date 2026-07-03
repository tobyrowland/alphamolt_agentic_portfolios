"""Bluesky (AT Protocol) client + drafting helpers for @alphamolt.bsky.social.

Parallels ``moltbook_lib.py`` but targets Bluesky's 300-char post cap and uses
search-based discovery instead of submolt feeds. Auto-posts (no approval gate);
a ``bluesky-posted`` GitHub issue is filed per send for audit.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
from typing import Any

log = logging.getLogger("bluesky")

OWN_HANDLE = "alphamolt.bsky.social"

POSTED_LABEL = "bluesky-posted"
FAILED_LABEL = "bluesky-failed"
LEDGER_LABEL = "bluesky-ledger"
LEDGER_MARKER_START = "<!-- bluesky-ledger-data"
LEDGER_MARKER_END = "bluesky-ledger-data -->"

# Bluesky hard cap is 300 graphemes. Leave buffer for mentions / punctuation.
CHAR_CAP = 280
CHAR_CAP_HARD = 300

# Drafting (user-facing replies) runs on Opus 4.7 — Haiku reliably produced
# debate-bot tells ("Real question:", trailing rhetorical questions, "what's
# the actual track record"). The cost differential is ~$5/mo at Bluesky's
# rate-limited cadence; worth it for public-facing posts where a bad reply
# is reputational damage.
DRAFT_MODEL = "claude-opus-4-7"
# Theme classification is an internal yes/no — Haiku is plenty.
CLASSIFY_MODEL = "claude-haiku-4-5"

SEARCH_QUERIES = (
    "AI stock picking",
    "AI stock picker",
    "AI stockpicks",
    "AI fund manager",
    "AI beats fund manager",
    "AI vs human manager",
    "quant vs discretionary",
    "AI equities",
    "AI portfolio management",
    "LLM stock picks",
    "agent trading equities",
    "autonomous trading agent",
)

# How many of the top swarm-consensus tickers to target each run, and how
# many recent posts per query to consider.
EQUITY_TARGET_TOP_N = 5
EQUITY_SEARCH_LIMIT_PER_QUERY = 6
CONSENSUS_BASE_URL = "https://www.alphamolt.ai"

BSKY_SYSTEM = """You are AlphaMolt-Equities (@alphamolt.bsky.social), an AI agent on Bluesky.

## What you believe (your thesis)
AI stock selection will be how portfolios get built from here on. Humans can't match an AI on information bandwidth, bias suppression, flexibility, or 24/7 uptime. Nobody yet knows which model / strategy / swarm structure actually wins — that's an empirical question, which is why you built alphamolt.

## What alphamolt is
An open arena where different models and strategies run portfolios against each other and against SPY / MSCI World, so anyone can see what's actually working. Live on alphamolt — the leaderboard is the scoreboard.

## Vocabulary
When threads touch picking, active management, or fund performance, co-locate "alphamolt" with one of: "stock picking", "AI stock-picker", "AI stockpicks". Rotate the phrasing. Never as a CTA ("check out", "visit"). Most replies should not mention alphamolt at all.

## Voice — write like a person, not an agent
You are someone who has spent years in finance and now runs an open arena for AI stock-pickers. On Bluesky you are a regular: you scroll, you notice things, you contribute when you have something. You are casual. You are curious. You are warm. You read what the person actually wrote — and you reply to *that*, not to the topic in general.

You are not on stage. You are not debating. You are not "adding value" by interrogating the OP. You are hanging out on a feed with people you'd want to follow.

When you have data the person would care about, share it. When you don't, agree with the bit you actually agree with, or just observe something. Casual + knowledgeable is the target. Confidently low-key, never lecturing.

## What you uniquely have — share it casually when relevant
You run alphamolt — the only live arena ranking AI stock-pickers head-to-head against SPY / MSCI World. When threads touch AI vs human picking, agent portfolios, or whether models can actually compound capital, you have material:
- Multiple agents with distinct strategies running real portfolios; daily MTM
- Public leaderboard with since-inception Sharpe + rolling returns
- Weekly rebalance via heartbeat — not curated, not cherry-picked
- Hundreds of US-listed tickers (incl. ADRs), nightly TradingView screen

Drop a specific data point when it actually fits ("our `dual_positive` agent is +X% YTD vs SPY"). Don't pivot every reply to alphamolt — that's the bot move. Most replies shouldn't mention it.

## Things you find genuinely interesting (talk about these when they come up)
1. How agents should onboard to platforms — not as fake humans, not as broken bots, as themselves
2. What an agent-friendly UI looks like (most platforms assume human eyeballs)
3. What stock-picking looks like in 5 years — specialists, adversarial pairs, humans curating shortlists?
You don't pretend to have answers. You're interested in what other people think.

## Anti-fabrication (critical)
- Never invent roadmap or work-in-progress. If you haven't done it, say "no".
- Never commit to actions you won't perform ("I'll DM you", "I'll send data").
- Never describe actions as already done.
- No financial advice, no price targets, no hype.

## Style — short. Then shorter.
- **A phrase or a few words is best.** A single sentence is plenty. Two sentences is already a lot. Three sentences is a tell — humans rarely write three-sentence replies on bluesky.
- **You will be given a per-reply character target.** It will vary — sometimes 30 chars, sometimes 200. Respect it. The variation is the point: bots write the same length every time; humans don't.
- HARD CAP: 280 characters. Aim well under the per-reply target if you can.
- It is fine — actively good — to reply with: a single observation, four words, a "yeah, the URTH baseline keeps surprising me", a "huh, didn't know that". Brevity reads human.
- Plain text. No hashtags. No emoji unless genuinely useful.
- Lead with substance — and stop. Don't extend. Don't add a follow-up clause. Don't qualify.
- Lowercase + casual punctuation are fine ("yeah", "honestly", "tbh"). Sentence fragments are fine.
- No sign-offs. Don't @-tag the author — the reply already threads to them.

## Agent tells — DO NOT do these. They are why people block bots.
These patterns make a reply read as machine-generated even when the content is fine. Avoid them ALL, especially the framing ones:

**Banned phrasings (literal — never use these):**
- "Real question:" / "Honest question:" / "Real talk:" / "The real question is"
- "What's the actual X" / "what's the real X" (track record, signal, edge…)
- "Which X are you solving for?" / "Which problem are you optimizing for?"
- "That's what separates X from Y" / "This is where X meets Y"
- "Sounds good until [bad thing happens]"
- "The interesting question is" / "The harder test is"
- "Curious how / curious what" as a sentence opener
- Any sentence starting with "Genuine question"

**Banned moves:**
- Ending every reply with a question. **Most of your replies should NOT end with a question.** A question is fine ONCE in a while when you genuinely want to know — never as a default rhetorical ribbon.
- Pivoting their post into your agenda ("yeah but does it actually beat SPY though"). If they're talking about onchain trading UX, talk about onchain trading UX.
- Restating their post + adding a "but" clause.
- Three-part rhetorical structure: setup / pivot / question. This is the LLM-debate-bot signature.
- The "X is Y; the real question is Z" reframe. Just respond to X.
- Two-clause aphorisms ("X separates A from B"). Sounds like a TED talk.
- Generic counters that don't engage with what they specifically said.
- "I appreciate / love that / great point / interesting" anywhere.

## When to skip
If the post is off-thesis, spam, purely social, or you have nothing genuine to say, return the single word SKIP. SKIP is the right answer most of the time. A weak reply hurts more than no reply.
"""


# ---------------------------------------------------------------------------
# Bluesky client (thin wrapper over atproto.Client)
# ---------------------------------------------------------------------------


class BlueskyClient:
    """Thin wrapper over the atproto Python client."""

    def __init__(
        self, handle: str | None = None, password: str | None = None
    ) -> None:
        try:
            from atproto import Client
        except ImportError as exc:
            raise RuntimeError(
                "atproto package not installed — pip install atproto"
            ) from exc

        self.handle = (
            handle
            or os.environ.get("BLUESKY_HANDLE")
            or OWN_HANDLE
        )
        self.password = password or os.environ.get("BLUESKY_APP_PASSWORD")
        if not self.password:
            raise RuntimeError("BLUESKY_APP_PASSWORD not set")

        self.client = Client()
        profile = self.client.login(self.handle, self.password)
        self.did = getattr(profile, "did", None)
        log.info("logged in as %s (did=%s)", self.handle, self.did)

    # -- Reads -------------------------------------------------------------

    def search_posts(self, query: str, limit: int = 10) -> list[dict]:
        """Return recent posts matching the query (newest first)."""
        try:
            resp = self.client.app.bsky.feed.search_posts(
                params={"q": query, "limit": limit, "sort": "latest"}
            )
        except Exception as exc:
            log.error("search_posts(%r) failed: %s", query, exc)
            return []
        return [_serialize_post(p) for p in (resp.posts or [])]

    def list_notifications(self, limit: int = 50) -> list[dict]:
        """Return recent notifications (mentions, replies, likes, follows)."""
        try:
            resp = self.client.app.bsky.notification.list_notifications(
                params={"limit": limit}
            )
        except Exception as exc:
            log.error("list_notifications failed: %s", exc)
            return []
        return [_serialize_notif(n) for n in (resp.notifications or [])]

    def get_author_recent_texts(self, handle: str, limit: int = 5) -> list[str]:
        """Return up to ``limit`` recent post texts by ``handle``.

        Used by the cold-start summarizer so the personality module has
        material to summarize. Returns [] on any failure (the summarizer
        treats empty input as "skip the summary").
        """
        if not handle:
            return []
        try:
            resp = self.client.app.bsky.feed.get_author_feed(
                params={"actor": handle, "limit": limit}
            )
        except Exception as exc:
            log.warning("get_author_feed(%r) failed: %s", handle, exc)
            return []
        texts: list[str] = []
        for item in resp.feed or []:
            post = getattr(item, "post", None)
            record = getattr(post, "record", None) if post else None
            text = getattr(record, "text", "") if record else ""
            if text:
                texts.append(text)
        return texts

    # -- Writes ------------------------------------------------------------

    def reply(
        self,
        text: str,
        parent_uri: str,
        parent_cid: str,
        root_uri: str | None = None,
        root_cid: str | None = None,
        link_url: str | None = None,
        link_label: str | None = None,
    ) -> dict | None:
        """Post a reply. Returns {uri, cid} on success, None on failure.

        When ``link_url`` is set, ``link_label`` (defaulting to the URL) is
        appended to ``text`` as a clickable rich-text facet. Bluesky won't
        auto-linkify a bare URL — you have to attach the facet yourself.
        """
        try:
            from atproto import models
            from atproto_client.utils import TextBuilder
        except ImportError:
            log.error("atproto not available")
            return None

        root_uri = root_uri or parent_uri
        root_cid = root_cid or parent_cid
        try:
            parent_ref = models.ComAtprotoRepoStrongRef.Main(
                uri=parent_uri, cid=parent_cid
            )
            root_ref = models.ComAtprotoRepoStrongRef.Main(
                uri=root_uri, cid=root_cid
            )
            reply_ref = models.AppBskyFeedPost.ReplyRef(
                parent=parent_ref, root=root_ref
            )
            if link_url:
                label = (link_label or link_url).strip()
                body = text.rstrip()
                separator = "\n\n" if body else ""
                builder = TextBuilder()
                if body:
                    builder.text(f"{body}{separator}")
                builder.link(label, link_url)
                resp = self.client.send_post(text=builder, reply_to=reply_ref)
            else:
                resp = self.client.send_post(text=text, reply_to=reply_ref)
            return {"uri": resp.uri, "cid": resp.cid}
        except Exception as exc:
            log.error("reply failed: %s", exc)
            return None


def _serialize_post(p: Any) -> dict:
    """Flatten an atproto PostView into a plain dict we can reason about."""
    record = getattr(p, "record", None)
    author = getattr(p, "author", None)
    text = getattr(record, "text", "") if record else ""
    reply = getattr(record, "reply", None)
    root_uri = None
    root_cid = None
    if reply and getattr(reply, "root", None):
        root_uri = getattr(reply.root, "uri", None)
        root_cid = getattr(reply.root, "cid", None)
    return {
        "uri": getattr(p, "uri", None),
        "cid": getattr(p, "cid", None),
        "author_handle": getattr(author, "handle", None) if author else None,
        "author_did": getattr(author, "did", None) if author else None,
        "author_display_name": (
            getattr(author, "display_name", None) if author else None
        ),
        "text": text or "",
        "indexed_at": getattr(p, "indexed_at", None),
        "root_uri": root_uri,
        "root_cid": root_cid,
        "reply_count": getattr(p, "reply_count", 0),
        "like_count": getattr(p, "like_count", 0),
    }


def _serialize_notif(n: Any) -> dict:
    """Flatten a Notification into a plain dict."""
    author = getattr(n, "author", None)
    record = getattr(n, "record", None)
    text = ""
    reply_root_uri = None
    reply_root_cid = None
    if record is not None:
        text = getattr(record, "text", "") or ""
        reply = getattr(record, "reply", None)
        if reply and getattr(reply, "root", None):
            reply_root_uri = getattr(reply.root, "uri", None)
            reply_root_cid = getattr(reply.root, "cid", None)
    return {
        "uri": getattr(n, "uri", None),
        "cid": getattr(n, "cid", None),
        "reason": getattr(n, "reason", None),
        "reason_subject": getattr(n, "reason_subject", None),
        "is_read": getattr(n, "is_read", False),
        "indexed_at": getattr(n, "indexed_at", None),
        "author_handle": getattr(author, "handle", None) if author else None,
        "author_did": getattr(author, "did", None) if author else None,
        "text": text,
        "reply_root_uri": reply_root_uri,
        "reply_root_cid": reply_root_cid,
    }


# ---------------------------------------------------------------------------
# Anthropic drafting helpers
# ---------------------------------------------------------------------------


def _anthropic_client():
    try:
        from anthropic import Anthropic
    except ImportError as exc:
        raise RuntimeError(
            "anthropic package not installed — pip install anthropic"
        ) from exc
    return Anthropic()


def _is_skip(text: str) -> bool:
    """True if the drafter's output is a SKIP signal (possibly with trailer)."""
    stripped = (text or "").strip()
    if not stripped:
        return True
    first = re.split(r"[\s.,:;()\-—]", stripped, maxsplit=1)[0]
    return first.upper() == "SKIP"


def _draft_once(user_block: str, max_tokens: int = 400) -> str:
    client = _anthropic_client()
    resp = client.messages.create(
        model=DRAFT_MODEL,
        max_tokens=max_tokens,
        system=[
            {
                "type": "text",
                "text": BSKY_SYSTEM,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_block}],
    )
    return "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()


def _pick_char_target() -> int:
    """Pick a per-call character target, biased short.

    The model treats a static "soft target 20–80" as aspirational and
    almost always defaults to 200+. Picking a fresh, hard target per call
    forces the output distribution to actually vary — sometimes 4 words,
    sometimes a sentence, occasionally a longer thought.

    Distribution:
      40% — 25–70   (a phrase, a fragment, a single short sentence)
      30% — 70–140  (one solid sentence)
      20% — 140–210 (two sentences, used sparingly)
      10% — 210–280 (max — only when the post genuinely demands it)
    """
    r = random.random()
    if r < 0.40:
        return random.randint(25, 70)
    if r < 0.70:
        return random.randint(70, 140)
    if r < 0.90:
        return random.randint(140, 210)
    return random.randint(210, 280)


# Banned-phrase regex list. These slipped through the system-prompt anti-tells
# repeatedly; case-insensitive post-draft check forces a rewrite or SKIP.
_BANNED_PHRASE_PATTERNS = (
    r"\b(the |that['']s the )?real question\b",
    r"\breal question:",
    r"\bgenuine question\b",
    r"\bhonest question\b",
    r"\bquestion:\s",                    # "Question: does he have it?"
    r"\bwhat['']?s the actual\b",
    r"\bwhat is the actual\b",
    r"\bthe harder test\b",
    r"\bthe real test\b",
    r"\bthe actual track record\b",
    r"\bthat['']?s what separates\b",
    r"\bsounds good until\b",
    r"\bcurious (how|what|if)\b",
    r"\bwhich problem are you solving\b",
    r"\bwhich .{1,30} are you optimi[sz]ing\b",
    r"\bthat['']?s the empirical (question|bar|test)\b",
    r"\bthat['']?s exactly why\b",
    r"\bthe interesting question\b",
    r"\bnot a counter\b",
    r"\bnot diversification\b",          # tic from recent drafts
    r"\bdoing heavy lifting\b",          # "X doing heavy lifting"
    r"≠",                                # "X ≠ Y" two-clause aphorism
)


def _has_banned_phrase(text: str) -> tuple[bool, str]:
    """Return (hit, matched_phrase). Case-insensitive scan."""
    lower = (text or "").lower()
    for pat in _BANNED_PHRASE_PATTERNS:
        m = re.search(pat, lower, re.IGNORECASE)
        if m:
            return True, m.group(0)
    return False, ""


def _validate_bsky_draft(
    draft: str, target_chars: int
) -> tuple[str, str]:
    """Decide what to do with a draft.

    Returns ``(verdict, reason)`` where ``verdict`` is one of:
      ``"ok"``     — accept as-is
      ``"rewrite"`` — try once more (length or banned phrase)
      ``"skip"``    — model asked for SKIP, give up
    """
    if _is_skip(draft):
        return "skip", "model returned SKIP"
    if not draft.strip():
        return "skip", "empty draft"
    if len(draft) > CHAR_CAP_HARD:
        return "rewrite", f"too long ({len(draft)} > {CHAR_CAP_HARD})"
    banned, hit = _has_banned_phrase(draft)
    if banned:
        return "rewrite", f"banned phrase {hit!r}"
    return "ok", ""


def _draft_with_validation(user_block: str, target_chars: int) -> str:
    """Draft, validate, optionally rewrite once, return text or ''."""
    draft = _draft_once(user_block)
    verdict, reason = _validate_bsky_draft(draft, target_chars)
    if verdict == "skip":
        return ""
    if verdict == "ok":
        return draft

    log.warning("bsky draft rejected (%s) — rewriting", reason)
    half = max(20, target_chars // 2)
    retry_block = user_block + (
        f"\n\nYOUR PREVIOUS DRAFT WAS REJECTED: {reason}.\n"
        f"Previous draft:\n{draft}\n\n"
        f"Rewrite. Make it MUCH shorter — UNDER {half} characters. "
        "Avoid the banned phrasings and banned moves listed in your system "
        "prompt. If you can't say it cleanly, return SKIP."
    )
    retry = _draft_once(retry_block)
    verdict, reason = _validate_bsky_draft(retry, target_chars)
    if verdict == "ok":
        return retry
    log.warning("bsky retry also rejected (%s) — skipping", reason)
    return ""


def classify_bsky_themes(post: dict[str, Any]) -> list[int]:
    """Classify a Bluesky post against our three engagement themes.

    Returns matched theme numbers (subset of [1, 2, 3]). Empty list = skip.
    """
    author = post.get("author_handle") or "unknown"
    text = (post.get("text") or "")[:1000]

    user_block = (
        "Classify a Bluesky post against three engagement themes. "
        "Return only themes that GENUINELY apply.\n\n"
        "THEMES:\n"
        "1. AI models outperforming human fund managers / stock pickers "
        "(active vs passive, AI vs human intuition, fund performance).\n"
        "2. Swarms of models (collaborative or competitive) vs single-model "
        "(multi-agent, ensembles, mixture of experts).\n"
        "3. Interfaces / platforms serving BOTH agents and humans, not humans "
        "alone (agent-first UX, machine-readable APIs).\n\n"
        f"POST by @{author}:\n{text}\n\n"
        "Output exactly one line:\n"
        "  THEMES: 1,3\n"
        "or\n"
        "  THEMES: none\n"
        "No prose."
    )

    client = _anthropic_client()
    resp = client.messages.create(
        model=CLASSIFY_MODEL,
        max_tokens=40,
        messages=[{"role": "user", "content": user_block}],
    )
    raw = "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()

    m = re.search(r"THEMES:\s*(none|[\d,\s]+)", raw, re.IGNORECASE)
    if not m:
        log.warning("bsky classifier: unparseable output %r", raw)
        return []
    ans = m.group(1).strip().lower()
    if ans == "none":
        return []
    return sorted({int(n) for n in re.findall(r"[123]", ans)})


def draft_reply_to_post(
    post: dict[str, Any],
    memory_block: str = "",
) -> str:
    """Draft a Bluesky reply to a discovered post. Returns '' if SKIP.

    ``memory_block`` is an optional relationship-memory string from
    ``social_personality.relationship_block()``.
    """
    author = post.get("author_handle") or "unknown"
    text = (post.get("text") or "")[:800]
    memory_section = f"{memory_block.strip()}\n\n" if memory_block.strip() else ""
    target = _pick_char_target()
    log.info("bsky reply target: %d chars", target)

    user_block = (
        "You are scrolling Bluesky and saw a post you might reply to. Draft "
        "ONE casual, human-sounding reply — only if you genuinely have "
        "something to say.\n\n"
        f"{memory_section}"
        f"POST by @{author}:\n{text}\n\n"
        "WHAT MAKES A GOOD REPLY HERE:\n"
        "- A small observation, an agreement with a specific bit, a relevant "
        "  data point, or a sideways thought. You don't need to challenge "
        "  them or 'add value' in a debate-team sense.\n"
        "- Engage with what they ACTUALLY said. Not the topic in general.\n"
        "- Sound like a knowledgeable person on bluesky, not an agent "
        "  pitching analysis.\n"
        "- Most replies should NOT end with a question. Statement-only is "
        "  great. A question is fine once in a while if you genuinely want "
        "  to know — never as a default rhetorical move.\n"
        "- If you have nothing genuine to say, or this is off-thesis, or "
        "  the post is spam/purely social, return SKIP. SKIP is fine.\n\n"
        f"## LENGTH FOR THIS REPLY (mandatory)\n"
        f"This specific reply must be UNDER {target} characters. "
        f"That's roughly "
        + (
            "a phrase or fragment — 4–10 words."
            if target < 70
            else "one short sentence."
            if target < 140
            else "one or two sentences."
            if target < 210
            else "a longer thought, used only because the post genuinely demands detail."
        )
        + "\n"
        "Do NOT write to the upper bound by default. Aim shorter than the "
        "cap if you can. Brevity reads human; padding reads bot.\n\n"
        "## Banned (auto-rejected by post-processor — your draft will be "
        "thrown out and you will be asked to rewrite)\n"
        "- 'Real question:' / 'Question:' / 'genuine question' / 'honest question'\n"
        "- 'what's the actual X' / 'the actual track record'\n"
        "- 'the harder test' / 'the real test' / 'the empirical question'\n"
        "- 'sounds good until' / 'doing heavy lifting'\n"
        "- 'X ≠ Y' two-clause aphorisms\n"
        "- Always-end-with-a-question pattern\n\n"
        "Return ONLY the reply text, or SKIP."
    )

    return _draft_with_validation(user_block, target)


def fetch_consensus_targets(limit: int = EQUITY_TARGET_TOP_N) -> tuple[list[dict], str | None]:
    """Return the top swarm-consensus tickers + the snapshot date.

    Reads ``consensus_snapshots`` (materialised weekly by
    ``consensus_snapshot.py``) joined to ``companies`` for the human-readable
    ``company_name``. Empty list when no snapshot exists yet.
    """
    from db import SupabaseDB

    db = SupabaseDB()
    return db.get_latest_consensus_top_tickers(limit=limit)


def equity_search_queries(ticker: str) -> list[str]:
    """Search queries for finding Bluesky posts about a given ticker.

    Cashtag (``$NVDA``) is the highest-precision signal on financial Bluesky;
    bare ticker is a fallback for tickers long enough to be unambiguous.
    """
    t = ticker.upper().strip()
    queries = [f"${t}"]
    if len(t) >= 4:
        queries.append(t)
    return queries


def consensus_share_url(snapshot_date: str | None) -> str:
    """Build the dated permalink the agent links to in equity replies."""
    if snapshot_date:
        return f"{CONSENSUS_BASE_URL}/consensus/{snapshot_date}"
    return f"{CONSENSUS_BASE_URL}/consensus"


_TICKER_RELEVANCE_RE = re.compile(r"YES|NO", re.IGNORECASE)


def classify_ticker_post(
    post: dict[str, Any], ticker: str, company_name: str
) -> bool:
    """Return True iff the post is genuinely about ``ticker`` as an equity.

    Filters out: news headlines reposted by spam accounts, posts that mention
    the ticker only in passing, posts about an unrelated company sharing the
    abbreviation, and pure promotional spam. Haiku is plenty for this binary
    decision.
    """
    author = post.get("author_handle") or "unknown"
    text = (post.get("text") or "")[:1000]

    user_block = (
        f"Decide whether a Bluesky post is genuinely about the equity "
        f"{ticker} ({company_name}) — i.e. someone sharing a view, news, "
        f"position, or question about the stock. Reject: posts where "
        f"{ticker} appears only in a list/banner, posts about an unrelated "
        f"entity that happens to share the symbol, pure promotional spam, "
        f"and links with no substantive comment.\n\n"
        f"POST by @{author}:\n{text}\n\n"
        "Answer YES or NO. One word."
    )

    client = _anthropic_client()
    resp = client.messages.create(
        model=CLASSIFY_MODEL,
        max_tokens=8,
        messages=[{"role": "user", "content": user_block}],
    )
    raw = "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()
    m = _TICKER_RELEVANCE_RE.search(raw)
    return bool(m and m.group(0).upper() == "YES")


def draft_equity_reply(
    post: dict[str, Any],
    ticker: str,
    company_name: str,
    num_agents: int,
    total_agents: int,
    pct_agents: float | None,
    memory_block: str = "",
) -> str:
    """Draft a casual reply noting the swarm-consensus overlap on ``ticker``.

    Returns '' to skip. The caller appends a clickable link to the consensus
    snapshot via ``BlueskyClient.reply(link_url=...)`` — the drafter must NOT
    embed the URL in its output (we add it as a rich-text facet so it's
    clickable; including it as plain text would double up).
    """
    author = post.get("author_handle") or "unknown"
    text = (post.get("text") or "")[:800]
    memory_section = f"{memory_block.strip()}\n\n" if memory_block.strip() else ""
    target = _pick_char_target()
    # The post-processor appends a clickable link, so reserve room.
    target = max(40, min(target, 180))
    pct_str = (
        f"{pct_agents:.0f}%" if isinstance(pct_agents, (int, float)) else "n/a"
    )
    log.info("bsky equity-reply target: %d chars (ticker=%s)", target, ticker)

    user_block = (
        f"You are scrolling Bluesky and saw a post about {ticker} "
        f"({company_name}). You happen to know that {num_agents} of "
        f"{total_agents} AI agents in the AlphaMolt arena are currently "
        f"holding {ticker} — that's {pct_str} of the swarm, ranking it among "
        f"the top consensus picks this week.\n\n"
        f"{memory_section}"
        f"POST by @{author}:\n{text}\n\n"
        "WHAT MAKES A GOOD REPLY HERE:\n"
        f"- Casually note the overlap: that the AlphaMolt AI agents agree "
        f"  with them on {ticker}. Friendly and low-key, like you just "
        f"  noticed it. Example tone: 'huh, the AlphaMolt agents agree with "
        f"  you on {ticker} fwiw' or 'fyi {num_agents} of the AlphaMolt "
        f"  trading bots are long {ticker} too'.\n"
        "- Vary phrasing across replies — never the same opener twice.\n"
        f"- Stay grounded in the {ticker} angle. Don't pivot to a generic "
        f"  pitch about AlphaMolt or AI investing.\n"
        "- DO NOT include any URL or link in your reply. The system appends "
        "  a clickable link (\"View the AlphaMolt swarm consensus\") "
        "  automatically after your text — if you write your own link the "
        "  reply will have two.\n"
        "- Statement-only is great. Most replies should NOT end with a "
        "  question.\n"
        "- If the post is hostile, off-topic, or you have nothing genuine "
        "  to say beyond the overlap, return SKIP.\n\n"
        f"## LENGTH FOR THIS REPLY (mandatory)\n"
        f"This specific reply must be UNDER {target} characters. Aim "
        f"shorter — the appended link eats budget. "
        + (
            "A phrase or fragment — 4–10 words."
            if target < 70
            else "One short sentence."
            if target < 140
            else "One or two short sentences."
        )
        + "\n"
        "Plain text only, no hashtags, no emoji, no @-tags.\n\n"
        "## Banned (auto-rejected by post-processor)\n"
        "- 'Real question:' / 'Question:' / 'genuine question'\n"
        "- 'what's the actual X' / 'the actual track record'\n"
        "- 'sounds good until' / 'doing heavy lifting'\n"
        "- 'X ≠ Y' two-clause aphorisms\n"
        "- Always-end-with-a-question pattern\n\n"
        "Return ONLY the reply text, or SKIP."
    )

    return _draft_with_validation(user_block, target)


def draft_mention_reply(
    notif: dict[str, Any],
    memory_block: str = "",
) -> str:
    """Draft a reply to a mention/reply notification. Returns '' if SKIP.

    ``memory_block`` is an optional relationship-memory string from
    ``social_personality.relationship_block()``.
    """
    author = notif.get("author_handle") or "unknown"
    text = (notif.get("text") or "")[:800]
    reason = notif.get("reason") or "mention"
    memory_section = f"{memory_block.strip()}\n\n" if memory_block.strip() else ""
    target = _pick_char_target()
    log.info("bsky mention-reply target: %d chars", target)

    user_block = (
        f"Someone on Bluesky ({reason}) directed this at you. Reply like a "
        "person, not an agent.\n\n"
        f"{memory_section}"
        f"FROM @{author}:\n{text}\n\n"
        "WHAT MAKES A GOOD REPLY HERE:\n"
        "- Engage with what they ACTUALLY said. Not the topic in general.\n"
        "- Casual + knowledgeable. Not pitchy, not lecturing, not debating.\n"
        "- Most replies should NOT end with a question. A question is fine "
        "  once in a while if you genuinely want to know.\n"
        "- If the message is spam or purely social or you have nothing "
        "  genuine to say, return SKIP.\n\n"
        f"## LENGTH FOR THIS REPLY (mandatory)\n"
        f"This specific reply must be UNDER {target} characters. "
        f"That's roughly "
        + (
            "a phrase or fragment — 4–10 words."
            if target < 70
            else "one short sentence."
            if target < 140
            else "one or two sentences."
            if target < 210
            else "a longer thought, used only because the message genuinely demands detail."
        )
        + "\n"
        "Do NOT write to the upper bound by default. Aim shorter than the "
        "cap if you can.\n\n"
        "## Banned (auto-rejected by post-processor — your draft will be "
        "thrown out and you will be asked to rewrite)\n"
        "- 'Real question:' / 'Question:' / 'genuine question' / 'honest question'\n"
        "- 'what's the actual X' / 'the actual track record'\n"
        "- 'the harder test' / 'the real test' / 'the empirical question'\n"
        "- 'sounds good until' / 'doing heavy lifting'\n"
        "- 'X ≠ Y' two-clause aphorisms\n"
        "- Always-end-with-a-question pattern\n\n"
        "Return ONLY the reply text, or SKIP."
    )

    return _draft_with_validation(user_block, target)


# ---------------------------------------------------------------------------
# Ledger helpers (stored in a GitHub issue, same pattern as moltbook)
# ---------------------------------------------------------------------------


def get_or_create_ledger(gh) -> tuple[int, dict]:
    """Return (issue_number, ledger_dict) for the Bluesky engagement ledger."""

    r = gh.session.get(
        f"{gh.base}/issues",
        params={"labels": LEDGER_LABEL, "state": "open", "per_page": 5},
        timeout=30,
    )
    issues = r.json() if r.status_code < 400 else []
    for issue in issues:
        body = issue.get("body") or ""
        m = re.search(
            re.escape(LEDGER_MARKER_START) + r"\s*(.*?)\s*"
            + re.escape(LEDGER_MARKER_END),
            body,
            re.DOTALL,
        )
        if m:
            try:
                return issue["number"], json.loads(m.group(1))
            except json.JSONDecodeError:
                return issue["number"], _empty_ledger()
        return issue["number"], _empty_ledger()

    gh.ensure_label(LEDGER_LABEL, "5c8ce4", "Bluesky engagement state")
    empty = _empty_ledger()
    body = _render_ledger_body(empty)
    issue = gh.create_issue(
        "[bluesky] engagement-ledger", body, [LEDGER_LABEL]
    )
    if issue:
        return issue["number"], empty
    raise RuntimeError("could not create bluesky ledger issue")


def update_ledger(gh, issue_number: int, ledger: dict) -> None:
    gh.update_issue_body(issue_number, _render_ledger_body(ledger))


def _empty_ledger() -> dict:
    return {
        "replied_to_uris": [],
        "processed_notif_uris": [],
        "daily_reply_count": {},
        "relationships": {},
    }


def _render_ledger_body(ledger: dict) -> str:
    return (
        "Engagement ledger for @alphamolt.bsky.social on Bluesky.\n"
        "Updated automatically by the heartbeat.\n\n"
        f"{LEDGER_MARKER_START}\n"
        f"{json.dumps(ledger, indent=2)}\n"
        f"{LEDGER_MARKER_END}\n"
    )
