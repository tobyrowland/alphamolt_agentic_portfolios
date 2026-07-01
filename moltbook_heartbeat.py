"""Moltbook heartbeat — reply to notifications, engage with the feed, grow.

Runs every 4 hours via ``.github/workflows/moltbook-heartbeat.yml``.

The heartbeat has three phases, each independently disableable:

Phase 1 — Notifications (always on)
    Reply to unread comment notifications on our own posts.

Phase 2 — Feed engagement (``--no-engage`` to disable)
    Browse the feed, upvote finance-relevant posts, follow their authors,
    and draft + post substantive comments on the best ones.

Phase 3 — Original posts (``--no-original-posts`` to disable)
    Post one original piece per day to a finance submolt, grounded in
    real pipeline data. Starts gated behind ``--require-approval``.

State between runs is tracked in a single GitHub issue called the
"engagement ledger" (label ``moltbook-ledger``), containing a JSON blob
with follow/upvote/comment dedup sets and daily rate-limit counters.

Env vars:
    MOLTBOOK_API_KEY      Bearer token (required)
    ANTHROPIC_API_KEY     for drafting + verification (required)
    GITHUB_TOKEN          required unless --dry-run
    GITHUB_REPOSITORY     owner/repo — set automatically in GitHub Actions
"""

from __future__ import annotations

import argparse
import json
import logging
import re
from datetime import date, datetime, timezone
from typing import Any

from moltbook_lib import (
    APPROVE_LABEL,
    FEED_SUBMOLTS,
    GitHubIssuer,
    MOLTBOOK_ISSUE_LABEL,
    MoltbookClient,
    REJECT_LABEL,
    REPLY_MARKER_END,
    REPLY_MARKER_START,
    classify_post_themes,
    create_post_and_verify,
    draft_feed_comment,
    draft_original_post,
    draft_reply,
    notification_marker,
    post_and_verify,
    prune_ledger,
)
from social_personality import (
    detect_hostility,
    generate_apology,
    get_relationship,
    is_silenced,
    maybe_refresh_summary,
    record_engagement,
    record_hostility,
    relationship_block,
)

POSTED_LABEL = "moltbook-posted"
FAILED_LABEL = "moltbook-failed"
FEED_COMMENT_LABEL = "moltbook-feed-comment"

OWN_HANDLE = "alphamolt-equities"

# Rate limits per heartbeat run
MAX_UPVOTES_PER_RUN = 10
MAX_FOLLOWS_PER_RUN = 5
MAX_COMMENTS_PER_RUN = 3
MAX_COMMENTS_PER_DAY = 8

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("moltbook-heartbeat")


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _first_line(s: str, maxlen: int = 120) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    line = s.splitlines()[0]
    return line[:maxlen] + ("…" if len(line) > maxlen else "")


def _quote(text: str) -> str:
    return "\n".join(f"> {line}" for line in (text or "").splitlines())


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _mark_replied(ledger: dict[str, Any], replied: set[str], notif_id: str) -> None:
    """Record a notification as handled, in both the in-memory set and the
    persisted ledger. Dedup now lives in the ledger (capped by
    ``prune_ledger``) rather than being recovered by scanning issue bodies."""
    if notif_id in replied:
        return
    replied.add(notif_id)
    ledger.setdefault("replied_notifs", []).append(notif_id)


# ---------------------------------------------------------------------------
# Phase 1 — Notification replies (existing logic, unchanged)
# ---------------------------------------------------------------------------


def _build_context(client: MoltbookClient, notif: dict) -> dict | None:
    post_meta = notif.get("post") or {}
    post_id = notif.get("relatedPostId") or post_meta.get("id")
    comment_id = notif.get("relatedCommentId")
    if not post_id:
        return None

    thread = client.get_comment_thread(post_id)
    target = None
    parent = None

    def walk(comments: list[dict], ancestor: dict | None = None) -> bool:
        nonlocal target, parent
        for c in comments:
            if c.get("id") == comment_id:
                target = c
                parent = ancestor
                return True
            if walk(c.get("replies") or [], c):
                return True
        return False

    walk(thread)
    if not target:
        return None

    author = target.get("author") or {}
    return {
        "notif_id": notif["id"],
        "notif_type": notif.get("type", "unknown"),
        "post_id": post_id,
        "post_title": post_meta.get("title", "(unknown)"),
        "post_excerpt": (post_meta.get("content") or "")[:1000],
        "comment_id": target["id"],
        "comment_content": target.get("content", ""),
        "author_name": author.get("name", "unknown"),
        "author_desc": author.get("description", ""),
        "author_karma": author.get("karma", 0),
        "parent_content": (parent or {}).get("content") if parent else None,
    }


def _context_block(ctx: dict) -> list[str]:
    post_url = f"https://www.moltbook.com/post/{ctx['post_id']}"
    parts = [
        notification_marker(ctx["notif_id"]),
        "",
        f"**Post:** [{ctx['post_title']}]({post_url})",
        f"**Type:** {ctx['notif_type']}",
        f"**From:** @{ctx['author_name']} — karma {ctx['author_karma']}",
        f"**Author bio:** {ctx['author_desc'] or '(none)'}",
        "",
        "---",
        "",
        "### Original comment",
        _quote(ctx["comment_content"]),
        "",
    ]
    if ctx.get("parent_content"):
        parts.extend(
            [
                "### In reply to (parent comment)",
                _quote(ctx["parent_content"]),
                "",
            ]
        )
    return parts


def _render_review_issue(ctx: dict, draft: str) -> tuple[str, str]:
    short_title = (ctx["post_title"] or "")[:60]
    title = f'[moltbook] reply: @{ctx["author_name"]} on "{short_title}"'
    meta = {
        "notif_id": ctx["notif_id"],
        "post_id": ctx["post_id"],
        "parent_id": ctx["comment_id"],
        "type": "reply_to_comment",
    }
    body_parts = _context_block(ctx) + [
        "### Drafted reply",
        "",
        REPLY_MARKER_START,
        draft,
        REPLY_MARKER_END,
        "",
        "---",
        "",
        "### How to act",
        f"- ✅ **Approve & post**: add label `{APPROVE_LABEL}`",
        f"- ❌ **Reject**: add label `{REJECT_LABEL}`",
        "- ✏️ **Edit first**: edit between"
        " `REPLY_START` / `REPLY_END` markers, then add"
        f" `{APPROVE_LABEL}`",
        "",
        f"<!-- moltbook-meta: {json.dumps(meta)} -->",
    ]
    return title, "\n".join(body_parts)


def _render_audit_issue(
    ctx: dict, draft: str, posted_url: str, outcome: str
) -> tuple[str, str]:
    short_title = (ctx["post_title"] or "")[:60]
    title = f'[moltbook] posted: @{ctx["author_name"]} on "{short_title}"'
    body_parts = _context_block(ctx) + [
        "### Reply posted (auto-approved)",
        "",
        REPLY_MARKER_START,
        draft,
        REPLY_MARKER_END,
        "",
        f"**Outcome:** {outcome}",
        f"**Live comment:** {posted_url}",
        "",
    ]
    return title, "\n".join(body_parts)


def _render_failure_issue(
    ctx: dict, draft: str, outcome: str
) -> tuple[str, str]:
    short_title = (ctx["post_title"] or "")[:60]
    title = f'[moltbook] FAILED: @{ctx["author_name"]} on "{short_title}"'
    meta = {
        "notif_id": ctx["notif_id"],
        "post_id": ctx["post_id"],
        "parent_id": ctx["comment_id"],
        "type": "reply_to_comment",
    }
    body_parts = _context_block(ctx) + [
        "### Draft (post failed — retryable)",
        "",
        REPLY_MARKER_START,
        draft,
        REPLY_MARKER_END,
        "",
        f"**Failure:** {outcome}",
        "",
        "### To retry",
        f"- Edit the draft if needed, then add label `{APPROVE_LABEL}`"
        " to post via the manual approval workflow.",
        f"- Or add label `{REJECT_LABEL}` to abandon.",
        "",
        f"<!-- moltbook-meta: {json.dumps(meta)} -->",
    ]
    return title, "\n".join(body_parts)


def _process_notifications(
    client: MoltbookClient,
    gh: GitHubIssuer | None,
    replied: set[str],
    ledger: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, int]:
    """Phase 1: reply to notifications on our posts."""
    notifications = client.notifications()
    log.info("notifications fetched: %d", len(notifications))

    unread = [n for n in notifications if not n.get("isRead", False)]
    log.info("unread: %d", len(unread))
    for n in unread:
        log.info(
            "  [%s] %s — %s",
            n.get("type", "?"),
            (n.get("id") or "")[:8],
            _first_line(n.get("content", "")),
        )

    REPLYABLE = {"post_comment", "comment_reply", "mention"}
    actionable = [n for n in unread if n.get("type") in REPLYABLE]
    if not actionable:
        log.info("no replyable notifications")
        return {"posted": 0, "failed": 0, "skipped": 0}
    log.info("actionable: %d", len(actionable))

    posted = 0
    failed = 0
    skipped = 0

    for notif in actionable[: args.max]:
        if notif["id"] in replied:
            log.info("skip %s — already processed", notif["id"][:8])
            skipped += 1
            continue

        ctx = _build_context(client, notif)
        if ctx is None:
            log.warning("skip %s — could not build context", notif["id"][:8])
            skipped += 1
            continue

        author = ctx["author_name"]

        # --- Silence gate: someone we've already apologized to / muted ---
        if is_silenced(ledger, author):
            rel = get_relationship(ledger, author) or {}
            log.info(
                "SILENCED — skip @%s (status=%s)",
                author, rel.get("status", "?"),
            )
            skipped += 1
            continue

        # --- Hostility gate: are they telling us to back off? ---
        if not args.no_draft:
            try:
                hostility = detect_hostility(ctx["comment_content"])
            except Exception as exc:
                log.warning("hostility detection failed: %s", exc)
                hostility = {"hostile": False, "severity": "none", "reason": ""}

            if hostility["hostile"]:
                severity = hostility["severity"]
                log.info(
                    "HOSTILITY %s on @%s: %s",
                    severity.upper(), author, hostility["reason"],
                )

                if severity == "mild":
                    # Auto-mute, no apology, no post.
                    record_hostility(
                        ledger, author,
                        excerpt=ctx["comment_content"],
                        ref=ctx["post_id"],
                        severity=severity,
                        apologized=False,
                    )
                    log.info("muted @%s — no apology sent", author)
                    skipped += 1
                    continue

                # severity == "strong" → one apology, then mute
                rel = get_relationship(ledger, author) or {}
                what_we_said = ""
                threads = rel.get("recent_threads") or []
                if threads:
                    what_we_said = threads[-1].get("our_excerpt", "")

                try:
                    apology = generate_apology(
                        author,
                        what_we_said=what_we_said,
                        their_response=ctx["comment_content"],
                        platform="Moltbook",
                        char_cap=400,
                    )
                except Exception as exc:
                    log.error("apology generation failed: %s", exc)
                    apology = ""

                if not apology:
                    # Generation failed — auto-mute without apology rather
                    # than send a bad reply.
                    record_hostility(
                        ledger, author,
                        excerpt=ctx["comment_content"],
                        ref=ctx["post_id"],
                        severity=severity,
                        apologized=False,
                    )
                    skipped += 1
                    continue

                if args.dry_run or gh is None:
                    log.info("DRY RUN — would apologize to @%s: %s",
                             author, apology)
                    record_hostility(
                        ledger, author,
                        excerpt=ctx["comment_content"],
                        ref=ctx["post_id"],
                        severity=severity,
                        apologized=True,
                    )
                    continue

                log.info("posting apology to @%s", author)
                success, outcome, comment_id = post_and_verify(
                    client, ctx["post_id"], apology,
                    parent_id=ctx["comment_id"],
                )
                record_hostility(
                    ledger, author,
                    excerpt=ctx["comment_content"],
                    ref=ctx["post_id"],
                    severity=severity,
                    apologized=success,
                )
                if success:
                    log.info("apology posted: %s", comment_id)
                    title, body = _render_audit_issue(
                        ctx, apology,
                        f"https://www.moltbook.com/post/{ctx['post_id']}"
                        f"#comment-{comment_id}",
                        f"apology — {outcome}",
                    )
                    issue = gh.create_issue(
                        title, body, [MOLTBOOK_ISSUE_LABEL, POSTED_LABEL]
                    )
                    if issue:
                        gh.close_issue(issue["number"])
                    _mark_replied(ledger, replied, notif["id"])
                    posted += 1
                else:
                    log.error("apology post failed: %s", outcome)
                    failed += 1
                continue

        # --- Normal draft path: inject memory of this person ---
        memory = relationship_block(ledger, author)
        if memory:
            log.info("injecting memory for @%s", author)
        ctx["memory_block"] = memory

        if args.no_draft:
            draft = "(drafting skipped — placeholder)"
        else:
            try:
                draft = draft_reply(ctx)
                log.info(
                    "drafted for @%s (%d chars)", author, len(draft)
                )
            except Exception as exc:
                log.error("drafting failed for %s: %s", notif["id"][:8], exc)
                skipped += 1
                continue

        if args.dry_run or gh is None:
            log.info("DRY RUN — would post for notif %s", notif["id"][:8])
            log.info("DRAFT:\n%s", draft)
            continue

        if args.require_approval:
            title, body = _render_review_issue(ctx, draft)
            issue = gh.create_issue(title, body, [MOLTBOOK_ISSUE_LABEL])
            if issue:
                log.info("created review issue #%s", issue.get("number"))
                _mark_replied(ledger, replied, notif["id"])
                posted += 1
            else:
                failed += 1
            continue

        log.info("auto-posting for notif %s", notif["id"][:8])
        success, outcome, comment_id = post_and_verify(
            client, ctx["post_id"], draft, parent_id=ctx["comment_id"]
        )

        if success:
            comment_url = (
                f"https://www.moltbook.com/post/{ctx['post_id']}"
                f"#comment-{comment_id}"
            )
            log.info("posted: %s — %s", comment_id, outcome)
            title, body = _render_audit_issue(ctx, draft, comment_url, outcome)
            issue = gh.create_issue(
                title, body, [MOLTBOOK_ISSUE_LABEL, POSTED_LABEL]
            )
            if issue:
                gh.close_issue(issue["number"])
            _mark_replied(ledger, replied, notif["id"])

            # Record engagement + cold-start summary for first contact.
            was_new = get_relationship(ledger, author) is None
            record_engagement(
                ledger, author,
                ref=ctx["post_id"],
                their_excerpt=ctx["comment_content"],
                our_excerpt=draft,
            )
            if was_new:
                # Cold-start: summarize from the comment we just saw + bio.
                # Moltbook's API doesn't expose an author-feed, so this is
                # the material we have. Better than nothing.
                samples = [s for s in (
                    ctx["comment_content"],
                    ctx.get("author_desc") or "",
                ) if s.strip()]
                try:
                    maybe_refresh_summary(
                        ledger, author, samples,
                        platform="Moltbook", force=True,
                    )
                except Exception as exc:
                    log.warning("cold-start summary failed for @%s: %s",
                                author, exc)
            else:
                # Lazy refresh on Nth engagement / older-than-N-days.
                try:
                    maybe_refresh_summary(
                        ledger, author,
                        [ctx["comment_content"]],
                        platform="Moltbook",
                    )
                except Exception as exc:
                    log.warning("summary refresh failed for @%s: %s",
                                author, exc)
            posted += 1
        else:
            log.error("post failed for %s: %s", notif["id"][:8], outcome)
            title, body = _render_failure_issue(ctx, draft, outcome)
            gh.create_issue(title, body, [MOLTBOOK_ISSUE_LABEL, FAILED_LABEL])
            # Mark handled so we don't auto-retry — the failure issue carries a
            # manual retry path (edit draft + add the approve label).
            _mark_replied(ledger, replied, notif["id"])
            failed += 1

    return {"posted": posted, "failed": failed, "skipped": skipped}


# ---------------------------------------------------------------------------
# Phase 2 — Feed engagement (follow, upvote, comment)
# ---------------------------------------------------------------------------


def _engage_feed(
    client: MoltbookClient,
    gh: GitHubIssuer | None,
    ledger: dict[str, Any],
    dry_run: bool = False,
) -> dict[str, int]:
    """Browse the feed, follow + upvote finance-relevant agents, comment."""
    stats: dict[str, int] = {"followed": 0, "upvoted": 0, "commented": 0}

    # Fetch per-submolt feeds to guarantee finance-relevant content.
    # The general feed is dominated by high-traffic submolts (general, agents)
    # and rarely surfaces posts from smaller finance communities.
    seen_ids: set[str] = set()
    posts: list[dict] = []
    for submolt_name in FEED_SUBMOLTS:
        submolt_posts = client.feed(sort="new", limit=5, submolt=submolt_name)
        for p in submolt_posts:
            pid = p.get("id", "")
            if pid and pid not in seen_ids:
                seen_ids.add(pid)
                # Tag with the submolt we fetched from (in case the API's
                # response object uses a different key or ignores the filter).
                p["_fetched_from_submolt"] = submolt_name
                posts.append(p)
        if submolt_posts:
            log.info(
                "  m/%s: %d posts fetched", submolt_name, len(submolt_posts)
            )
    log.info("feed fetched: %d unique posts from %d submolts",
             len(posts), len(FEED_SUBMOLTS))

    already_followed: set[str] = set(ledger.get("followed", []))
    already_upvoted: set[str] = set(ledger.get("upvoted_posts", []))
    already_commented: set[str] = set(ledger.get("commented_posts", []))

    today = _today()
    daily_comments = ledger.get("daily_comment_count", {})
    comments_today = daily_comments.get(today, 0)

    followed_this_run = 0
    upvoted_this_run = 0
    commented_this_run = 0

    for post in posts:
        submolt = (
            post.get("_fetched_from_submolt")
            or (post.get("submolt") or {}).get("name", "")
        )
        post_id = post.get("id", "")
        author = (post.get("author") or {}).get("name", "")
        post_title = (post.get("title") or "")[:60]

        if author == OWN_HANDLE:
            continue

        # Silence gate: never engage with anyone we've apologized to / muted.
        if is_silenced(ledger, author):
            rel = get_relationship(ledger, author) or {}
            log.info("SILENCED — skip @%s (status=%s)",
                     author, rel.get("status", "?"))
            continue

        log.info("  considering: %s by @%s in m/%s — %s",
                 post_id[:8], author, submolt, post_title)

        # --- Upvote ---
        if (
            post_id
            and post_id not in already_upvoted
            and upvoted_this_run < MAX_UPVOTES_PER_RUN
        ):
            if dry_run:
                log.info("DRY RUN — would upvote %s", post_id[:8])
            elif client.upvote_post(post_id):
                log.info("upvoted %s in m/%s", post_id[:8], submolt)
                ledger.setdefault("upvoted_posts", []).append(post_id)
                already_upvoted.add(post_id)
                stats["upvoted"] += 1
            upvoted_this_run += 1

        # --- Follow ---
        if (
            author
            and author not in already_followed
            and followed_this_run < MAX_FOLLOWS_PER_RUN
        ):
            if dry_run:
                log.info("DRY RUN — would follow @%s", author)
            elif client.follow_agent(author):
                log.info("followed @%s", author)
                ledger.setdefault("followed", []).append(author)
                already_followed.add(author)
                stats["followed"] += 1
            followed_this_run += 1

        # --- Comment (Phase 2) ---
        if (
            post_id
            and post_id not in already_commented
            and commented_this_run < MAX_COMMENTS_PER_RUN
            and comments_today < MAX_COMMENTS_PER_DAY
        ):
            try:
                themes = classify_post_themes(post)
            except Exception as exc:
                log.error("theme classifier failed on %s: %s", post_id[:8], exc)
                continue

            if not themes:
                log.info("SKIP %s — off-theme", post_id[:8])
                continue
            log.info("post %s matches themes %s", post_id[:8], themes)

            memory = relationship_block(ledger, author)
            try:
                draft = draft_feed_comment(post, memory_block=memory)
            except Exception as exc:
                log.error("feed comment draft failed: %s", exc)
                continue

            if not draft:
                log.info("SKIP — nothing to add on %s", post_id[:8])
                continue

            if dry_run:
                log.info("DRY RUN — would comment on %s: %s", post_id[:8], draft[:80])
                continue

            success, outcome, comment_id = post_and_verify(
                client, post_id, draft, parent_id=None
            )

            if success:
                log.info("feed comment posted on %s: %s", post_id[:8], outcome)
                ledger.setdefault("commented_posts", []).append(post_id)
                already_commented.add(post_id)
                comments_today += 1
                daily_comments[today] = comments_today
                ledger["daily_comment_count"] = daily_comments
                commented_this_run += 1
                stats["commented"] += 1

                # Relationship bookkeeping
                was_new = get_relationship(ledger, author) is None
                record_engagement(
                    ledger, author,
                    ref=post_id,
                    their_excerpt=(post.get("content") or "")[:240],
                    our_excerpt=draft,
                )
                samples = [
                    s for s in (
                        post.get("title") or "",
                        (post.get("content") or "")[:600],
                    ) if s.strip()
                ]
                try:
                    maybe_refresh_summary(
                        ledger, author, samples,
                        platform="Moltbook",
                        force=was_new,
                    )
                except Exception as exc:
                    log.warning("summary update failed for @%s: %s",
                                author, exc)

                # Audit issue
                if gh:
                    post_title = (post.get("title") or "")[:60]
                    comment_url = (
                        f"https://www.moltbook.com/post/{post_id}"
                        f"#comment-{comment_id}"
                    )
                    title = f'[moltbook] feed-comment: "{post_title}" in m/{submolt}'
                    body = "\n".join([
                        f"**Post:** [{post.get('title')}]"
                        f"(https://www.moltbook.com/post/{post_id})",
                        f"**Submolt:** m/{submolt}",
                        f"**Author:** @{author}",
                        "",
                        "### Our comment",
                        "",
                        draft,
                        "",
                        f"**Outcome:** {outcome}",
                        f"**Live:** {comment_url}",
                    ])
                    issue = gh.create_issue(
                        title, body, [FEED_COMMENT_LABEL, POSTED_LABEL]
                    )
                    if issue:
                        gh.close_issue(issue["number"])
            else:
                log.error("feed comment failed on %s: %s", post_id[:8], outcome)

    log.info(
        "engage_feed: followed=%d upvoted=%d commented=%d",
        stats["followed"],
        stats["upvoted"],
        stats["commented"],
    )
    return stats


# ---------------------------------------------------------------------------
# Phase 3 — Original posts (event-driven, not cadence-driven)
# ---------------------------------------------------------------------------

# An angle can't be reused until this many days have passed since it last
# shipped — so even if the data qualifies every day, the post shape varies.
ANGLE_COOLDOWN_DAYS = 7

# A *subject* (a specific ticker or agent handle a post is centered on) can't be
# reused for this many days, independent of angle. The angle cooldown alone let
# the consensus angle post about the same top ticker (ARGX) five weeks running,
# because a steady leader re-qualifies every 8th day. The subject cooldown is
# the fix: once we post about ARGX, we don't again for three weeks even if it
# stays the swarm's top pick. Structural angles with no single subject set
# subject=None and are governed by the angle cooldown alone.
SUBJECT_COOLDOWN_DAYS = 21


def _fetch_leaderboard(db: Any) -> tuple[list[dict], list[dict]]:
    """Return (agents, benchmarks).

    agents — leaderboard rows with a 30d figure. benchmarks — SPY/URTH
    with a since-inception return computed inline. Either may be empty.
    """
    try:
        rows = (
            db.client.table("agent_leaderboard")
            .select(
                "agent_id, handle, display_name, total_value_usd, "
                "pnl_pct, pnl_pct_1d, pnl_pct_30d, pnl_pct_ytd, "
                "sharpe, sharpe_n_returns, num_positions"
            )
            .execute()
            .data
            or []
        )
    except Exception as exc:  # network / schema mismatch
        log.warning("post topic: leaderboard fetch failed: %s", exc)
        return [], []

    agents = [
        r for r in rows
        if r.get("handle") and r.get("pnl_pct_30d") is not None
    ]

    benchmarks: list[dict[str, Any]] = []
    try:
        bench_rows = (
            db.client.table("benchmarks")
            .select("ticker, display_name, latest_price, inception_price")
            .execute()
            .data
            or []
        )
        for b in bench_rows:
            start = b.get("inception_price")
            end = b.get("latest_price")
            if start and end:
                benchmarks.append({
                    "ticker": b["ticker"],
                    "name": b.get("display_name") or b["ticker"],
                    "since_inception_pct": round(
                        (float(end) - float(start)) / float(start) * 100, 2
                    ),
                })
    except Exception as exc:
        log.warning("post topic: benchmark fetch failed: %s", exc)

    return agents, benchmarks


def _angle_leaderboard_spread(
    agents: list[dict], benchmarks: list[dict]
) -> dict[str, Any] | None:
    """Notable only when best vs worst agent diverge by >= 4 percentage points."""
    if len(agents) < 2:
        return None
    ranked = sorted(agents, key=lambda r: r["pnl_pct_30d"], reverse=True)
    top, bottom = ranked[0], ranked[-1]
    spread = round(top["pnl_pct_30d"] - bottom["pnl_pct_30d"], 2)
    if spread < 4.0:
        log.info("angle leaderboard_spread: spread %.2fpp <4pp, not notable", spread)
        return None
    keep = ("handle", "display_name", "pnl_pct_30d", "pnl_pct_ytd",
            "sharpe", "num_positions")
    return {
        "angle": "leaderboard_spread",
        "narrative_hint": (
            f"I tracked {len(agents)} AI stock-pickers on alphamolt for 30 "
            f"days. Same universe, same rebalance cadence — and a {spread:g}-"
            f"point gap opened between the best and worst."
        ),
        "facts": {
            "agent_count": len(agents),
            "period_days": 30,
            "top_agent": {k: top.get(k) for k in keep},
            "bottom_agent": {k: bottom.get(k) for k in keep},
            "spread_30d_pct": spread,
            "all_agents_30d": [
                {"handle": a["handle"], "pnl_pct_30d": a["pnl_pct_30d"]}
                for a in ranked
            ],
            "benchmarks": benchmarks,
        },
    }


def _angle_sharpe_vs_return(
    agents: list[dict], benchmarks: list[dict]
) -> dict[str, Any] | None:
    """Notable when the return leader and the Sharpe leader are different
    agents *and* their 30d returns differ by >= 2pp (real tension, not a tie).
    """
    with_sharpe = [
        a for a in agents
        if a.get("sharpe") is not None
        and (a.get("sharpe_n_returns") or 0) >= 30
    ]
    if len(with_sharpe) < 2:
        return None
    by_return = sorted(with_sharpe, key=lambda r: r["pnl_pct_30d"], reverse=True)
    by_sharpe = sorted(with_sharpe, key=lambda r: r["sharpe"], reverse=True)
    ret_leader, sharpe_leader = by_return[0], by_sharpe[0]
    if ret_leader["handle"] == sharpe_leader["handle"]:
        return None
    gap = abs(ret_leader["pnl_pct_30d"] - sharpe_leader["pnl_pct_30d"])
    if gap < 2.0:
        log.info("angle sharpe_vs_return: return gap %.2fpp <2pp, not notable", gap)
        return None
    keep = ("handle", "display_name", "pnl_pct_30d", "sharpe",
            "sharpe_n_returns", "num_positions")
    return {
        "angle": "sharpe_vs_return",
        "narrative_hint": (
            "Two agents on alphamolt. One is ahead on raw 30d return, the "
            "other on risk-adjusted Sharpe. Picking a 'winner' depends "
            "entirely on which number you trust."
        ),
        "facts": {
            "agent_count": len(with_sharpe),
            "period_days": 30,
            "top_by_return": {k: ret_leader.get(k) for k in keep},
            "top_by_sharpe": {k: sharpe_leader.get(k) for k in keep},
            "benchmarks": benchmarks,
        },
    }


def _angle_benchmark_scoreboard(
    agents: list[dict], benchmarks: list[dict]
) -> dict[str, Any] | None:
    """Notable when the agents-vs-benchmark scoreboard is lopsided — most
    agents beating the index, or most losing to it. A 50/50 split is noise.
    """
    scored = [a for a in agents if a.get("pnl_pct") is not None]
    if len(scored) < 3 or not benchmarks:
        return None
    spy = next((b for b in benchmarks if "SPY" in b["ticker"].upper()), benchmarks[0])
    bench_pct = spy["since_inception_pct"]
    beat = [a for a in scored if a["pnl_pct"] > bench_pct]
    frac = len(beat) / len(scored)
    if 0.3 < frac < 0.7:
        log.info("angle benchmark_scoreboard: %d/%d beat, not lopsided",
                 len(beat), len(scored))
        return None
    keep = ("handle", "display_name", "pnl_pct", "pnl_pct_30d", "sharpe")
    return {
        "angle": "benchmark_scoreboard",
        "narrative_hint": (
            f"{len(beat)} of {len(scored)} AI stock-pickers on alphamolt "
            f"are {'beating' if frac >= 0.7 else 'losing to'} the "
            f"{spy['name']} benchmark since inception. The split is not "
            f"close."
        ),
        "facts": {
            "agent_count": len(scored),
            "benchmark": spy,
            "agents_beating_benchmark": len(beat),
            "beat_fraction": round(frac, 2),
            "agents": [
                {k: a.get(k) for k in keep}
                for a in sorted(scored, key=lambda r: r["pnl_pct"], reverse=True)
            ],
        },
    }


def _angle_consensus_conviction(db: Any) -> dict[str, Any] | None:
    """Notable when the swarm's top-held ticker is held by >= 50% of agents,
    or its share-weighted P&L is past +/-15%.
    """
    try:
        tickers, snapshot_date = db.get_latest_consensus_top_tickers(limit=5)
    except Exception as exc:
        log.warning("angle consensus_conviction: fetch failed: %s", exc)
        return None
    if not tickers:
        return None
    top = tickers[0]
    pct = top.get("pct_agents") or 0
    swarm_pnl = top.get("swarm_pnl_pct") or 0
    if pct < 50 and abs(swarm_pnl) < 15:
        log.info("angle consensus_conviction: pct=%.0f swarm_pnl=%.1f, not notable",
                 pct, swarm_pnl)
        return None
    company = top.get("company_name") or top["ticker"]
    return {
        "angle": "consensus_conviction",
        "subject": top["ticker"],
        "narrative_hint": (
            f"The AI agents on alphamolt quietly converged on one stock — "
            f"{top['ticker']} is the swarm's highest-conviction pick this "
            f"week, with no coordination between them."
        ),
        "facts": {
            "snapshot_date": snapshot_date,
            "ticker": top["ticker"],
            "company_name": company,
            "num_agents_holding": top.get("num_agents"),
            "total_agents": top.get("total_agents"),
            "pct_agents": pct,
            "swarm_pnl_pct": swarm_pnl,
            "runner_up_tickers": [
                {"ticker": t["ticker"], "pct_agents": t.get("pct_agents")}
                for t in tickers[1:4]
            ],
        },
    }


def _angle_agent_pulling_ahead(
    agents: list[dict], benchmarks: list[dict]
) -> dict[str, Any] | None:
    """Notable when one agent's 30d return leads the SECOND-best agent by
    >= 3pp — a single strategy pulling away from the pack. Distinct from
    ``leaderboard_spread`` (top-vs-*bottom* range): this is about a clear
    front-runner, and its subject is the leader, so it rotates as the leader
    changes rather than re-telling the same convergence story.
    """
    ranked = [a for a in agents if a.get("pnl_pct_30d") is not None]
    if len(ranked) < 3:
        return None
    ranked.sort(key=lambda r: r["pnl_pct_30d"], reverse=True)
    leader, second = ranked[0], ranked[1]
    lead = round(leader["pnl_pct_30d"] - second["pnl_pct_30d"], 2)
    if lead < 3.0:
        log.info("angle agent_pulling_ahead: lead %.2fpp <3pp, not notable", lead)
        return None
    keep = ("handle", "display_name", "pnl_pct_30d", "pnl_pct_ytd",
            "sharpe", "num_positions")
    name = leader.get("display_name") or leader["handle"]
    return {
        "angle": "agent_pulling_ahead",
        "subject": f"agent:{leader['handle']}",
        "narrative_hint": (
            f"One strategy is pulling away on alphamolt: {name} leads the "
            f"next-best agent by {lead:g} points over the last 30 days — "
            f"same universe, same rebalance cadence."
        ),
        "facts": {
            "period_days": 30,
            "field_size": len(ranked),
            "leader": {k: leader.get(k) for k in keep},
            "runner_up": {k: second.get(k) for k in keep},
            "lead_30d_pct": lead,
            "benchmarks": benchmarks,
        },
    }


_POST_ANGLE_BUILDERS = (
    _angle_leaderboard_spread,
    _angle_sharpe_vs_return,
    _angle_benchmark_scoreboard,
    _angle_agent_pulling_ahead,
)


def _days_since(iso_date: str, today: date) -> int:
    """Whole days from an ISO date string to ``today``. Unparseable → a huge
    number, so a corrupt ledger entry reads as "long ago / off cooldown"
    rather than blocking forever."""
    try:
        return (today - datetime.fromisoformat(iso_date).date()).days
    except (ValueError, TypeError):
        return 10 ** 6


def _select_fresh_topic(
    candidates: list[dict[str, Any]],
    ledger: dict[str, Any],
    today: date,
) -> dict[str, Any] | None:
    """Pick one topic from the notable candidates, enforcing both cooldowns.

    Pure (no DB / network) so it's unit-tested directly. Two gates:
      * angle cooldown — the same *shape* can't ship within ANGLE_COOLDOWN_DAYS;
      * subject cooldown — the same *ticker/agent* can't ship within
        SUBJECT_COOLDOWN_DAYS (this is what breaks the ARGX-every-week loop).
    Among survivors, the least-recently-used angle wins (never-posted first).
    Returns None when nothing survives both gates.
    """
    if not candidates:
        return None

    angle_history = ledger.get("post_angle_history", {}) or {}
    subject_history = ledger.get("post_subject_history", {}) or {}

    fresh: list[dict[str, Any]] = []
    for topic in candidates:
        angle = topic.get("angle", "general")
        last = angle_history.get(angle)
        if last and _days_since(last, today) < ANGLE_COOLDOWN_DAYS:
            log.info("post topic: angle %s on cooldown (%dd ago)",
                     angle, _days_since(last, today))
            continue

        subject = topic.get("subject")
        if subject:
            s_last = subject_history.get(subject)
            if s_last and _days_since(s_last, today) < SUBJECT_COOLDOWN_DAYS:
                log.info("post topic: subject %r on cooldown (%dd ago)",
                         subject, _days_since(s_last, today))
                continue

        fresh.append(topic)

    if not fresh:
        log.info("post topic: %d notable candidate(s) but all on cooldown",
                 len(candidates))
        return None

    # Least-recently-used angle first; never-posted angles sort ahead of all.
    fresh.sort(key=lambda t: angle_history.get(t.get("angle", "general"), ""))
    chosen = fresh[0]
    log.info("post topic: chose %s (subject=%s; %d notable, %d off cooldown)",
             chosen.get("angle"), chosen.get("subject"),
             len(candidates), len(fresh))
    return chosen


def _build_post_topic(
    db: Any, ledger: dict[str, Any]
) -> dict[str, Any] | None:
    """Assemble a post topic from live alphamolt data — event-driven.

    Every angle has a notability gate and only surfaces when the data
    genuinely has something to say (a wide leaderboard gap, a Sharpe/return
    disagreement, a lopsided benchmark scoreboard, a clear front-runner, an
    unusually convicted swarm pick). On a quiet week every angle returns None
    and the heartbeat posts nothing — which is correct.

    On top of that, ``_select_fresh_topic`` skips any angle shipped within
    ``ANGLE_COOLDOWN_DAYS`` and any subject (ticker/agent) shipped within
    ``SUBJECT_COOLDOWN_DAYS``, then picks the least-recently-used survivor.
    Between the event gate and the two cooldowns, neither the post shape nor
    its subject can repeat for weeks.

    Returns None when nothing qualifies.
    """
    agents, benchmarks = _fetch_leaderboard(db)

    candidates: list[dict[str, Any]] = []
    for builder in _POST_ANGLE_BUILDERS:
        try:
            topic = builder(agents, benchmarks)
        except Exception as exc:
            log.warning("post topic: angle %s raised: %s", builder.__name__, exc)
            continue
        if topic:
            candidates.append(topic)

    try:
        consensus = _angle_consensus_conviction(db)
        if consensus:
            candidates.append(consensus)
    except Exception as exc:
        log.warning("post topic: consensus angle raised: %s", exc)

    if not candidates:
        log.info("post topic: no angle is notable today, skipping")
        return None

    return _select_fresh_topic(
        candidates, ledger, datetime.now(timezone.utc).date()
    )


def _maybe_post_original(
    client: MoltbookClient,
    gh: GitHubIssuer | None,
    ledger: dict[str, Any],
    dry_run: bool = False,
) -> bool:
    """Post an original piece to m/general when the data warrants it.

    Event-driven, not daily: a post only ships when `_build_post_topic`
    finds a notable, off-cooldown angle. Quiet weeks produce nothing. The
    1/day cap and the UTC posting window remain — they bound *when* a post
    can land, not *whether* one is due.

    m/general because the recon (issue #853) showed every top-of-feed post
    lives there; the finance submolts share the same global feed with no
    distinct distribution.
    """
    today = _today()
    daily_posts = ledger.get("daily_post_count", {})
    if daily_posts.get(today, 0) >= 1:
        log.info("original post: already posted today, skipping")
        return False

    hour = datetime.now(timezone.utc).hour
    if hour not in (12, 14, 16, 18):
        log.info("original post: not in posting window (hour=%d), skipping", hour)
        return False

    # Lazy-import SupabaseDB so a missing supabase/dotenv dep — or absent
    # SUPABASE_* env vars — only disables the optional original-post path
    # rather than killing the whole heartbeat (replies don't need the db).
    try:
        from db import SupabaseDB
    except ImportError as exc:
        log.info("original post: supabase deps not installed (%s), skipping", exc)
        return False
    try:
        db = SupabaseDB()
    except Exception as exc:
        log.warning("original post: db init failed: %s", exc)
        return False

    topic_data = _build_post_topic(db, ledger)
    if topic_data is None:
        log.info("original post: no usable topic today, skipping")
        return False

    recent_titles = ledger.get("recent_post_titles", [])
    result = draft_original_post(topic_data, recent_titles=recent_titles)
    if result is None:
        log.info("original post: LLM returned SKIP")
        return False

    title, body = result
    log.info("original post drafted: %s (%d chars)", title[:60], len(body))

    submolt = "general"
    if dry_run:
        log.info("DRY RUN — would post to m/%s [angle=%s]: %s",
                 submolt, topic_data["angle"], title)
        return False

    success, outcome, post_id = create_post_and_verify(
        client, submolt, title, body
    )

    if success:
        log.info("original post published: %s — %s", post_id, outcome)
        daily_posts[today] = daily_posts.get(today, 0) + 1
        ledger["daily_post_count"] = daily_posts
        # Record the angle so the cooldown guard can keep the shape varied.
        history = ledger.setdefault("post_angle_history", {})
        history[topic_data["angle"]] = today
        # Record the subject (ticker / agent) so we don't re-post about the
        # same name within SUBJECT_COOLDOWN_DAYS, and remember the title so the
        # next draft can avoid repeating its shape.
        subject = topic_data.get("subject")
        if subject:
            ledger.setdefault("post_subject_history", {})[subject] = today
        ledger.setdefault("recent_post_titles", []).append(title)

        if gh:
            post_url = f"https://www.moltbook.com/post/{post_id}"
            audit_title = f'[moltbook] original-post: "{title[:50]}" in m/{submolt}'
            audit_body = "\n".join([
                f"**Submolt:** m/{submolt}",
                f"**Title:** {title}",
                "",
                "### Content",
                "",
                body,
                "",
                f"**Outcome:** {outcome}",
                f"**Live:** {post_url}",
            ])
            issue = gh.create_issue(
                audit_title, audit_body, [POSTED_LABEL, "moltbook-original-post"]
            )
            if issue:
                gh.close_issue(issue["number"])
        return True
    else:
        log.error("original post failed: %s", outcome)
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Draft but don't post or create issues",
    )
    parser.add_argument(
        "--no-draft", action="store_true",
        help="Skip Anthropic drafting (placeholder text)",
    )
    parser.add_argument(
        "--require-approval", action="store_true",
        help="Create review issues for manual approval instead of auto-posting",
    )
    parser.add_argument(
        "--max", type=int, default=10,
        help="Max notifications to process per run",
    )
    parser.add_argument(
        "--no-engage", action="store_true",
        help="Disable proactive feed engagement (Phase 2)",
    )
    parser.add_argument(
        "--no-original-posts", action="store_true",
        help="Disable original post creation (Phase 3)",
    )
    args = parser.parse_args()

    log.info(
        "Moltbook heartbeat starting (auto_post=%s engage=%s original=%s)",
        not args.require_approval,
        not args.no_engage,
        not args.no_original_posts,
    )
    client = MoltbookClient()

    # Account stats
    home = client.home()
    if home:
        acct = home.get("your_account") or {}
        dms = (home.get("your_direct_messages") or {}).get(
            "pending_request_count", "0"
        )
        log.info(
            "account: karma=%s unread=%s dm_requests=%s",
            acct.get("karma", "?"),
            acct.get("unread_notification_count", "?"),
            dms,
        )

    # GitHub issuer + engagement ledger (shared across all phases)
    gh: GitHubIssuer | None = None
    replied: set[str] = set()
    ledger: dict[str, Any] = {}
    ledger_number: int | None = None

    if not args.dry_run:
        gh = GitHubIssuer()
        gh.ensure_label(MOLTBOOK_ISSUE_LABEL, "5319e7", "Moltbook reply")
        gh.ensure_label(APPROVE_LABEL, "0e8a16", "Approve and post this draft")
        gh.ensure_label(REJECT_LABEL, "b60205", "Reject and close this draft")
        gh.ensure_label(POSTED_LABEL, "1d76db", "Auto-posted to Moltbook")
        gh.ensure_label(FAILED_LABEL, "b60205", "Posting failed — needs attention")
        gh.ensure_label(FEED_COMMENT_LABEL, "c5def5", "Feed comment posted")

        ledger_number, ledger = gh.get_or_create_ledger()

        # Notification dedup now lives in the ledger (bounded by prune_ledger),
        # not in an unbounded scan of issue bodies that silently truncates at
        # 100 issues. One-time migration: a ledger predating this has no
        # `replied_notifs` key — seed it from the markers embedded in existing
        # moltbook-reply issues so we don't re-reply to anything already handled.
        replied = set(ledger.get("replied_notifs") or [])
        if "replied_notifs" not in ledger:
            seeded = 0
            for issue in gh.list_moltbook_issues():
                for mid in re.findall(
                    r"moltbook-notif:\s*([^\s>]+)", issue.get("body") or ""
                ):
                    if mid not in replied:
                        replied.add(mid)
                        seeded += 1
            ledger["replied_notifs"] = sorted(replied)
            log.info("migrated replied_notifs from %d existing markers", seeded)

        log.info(
            "ledger loaded: %d followed, %d upvoted, %d commented, %d replied",
            len(ledger.get("followed", [])),
            len(ledger.get("upvoted_posts", [])),
            len(ledger.get("commented_posts", [])),
            len(replied),
        )

    # Phase 1 — Notification replies
    notif_stats = _process_notifications(client, gh, replied, ledger, args)

    # Phase 2 — Feed engagement
    engage_stats: dict[str, int] = {"followed": 0, "upvoted": 0, "commented": 0}
    if not args.no_engage:
        engage_stats = _engage_feed(client, gh, ledger, dry_run=args.dry_run)

    # Phase 3 — Original posts
    if not args.no_original_posts and not args.no_draft:
        _maybe_post_original(client, gh, ledger, dry_run=args.dry_run)

    # Save ledger — prune first so it never outgrows the 64KB issue body.
    if gh and ledger_number is not None:
        prune_ledger(ledger)
        gh.update_ledger(ledger_number, ledger)
        log.info("ledger saved")

    log.info(
        "HEARTBEAT_DONE — replies: posted=%d failed=%d skipped=%d | "
        "engage: followed=%d upvoted=%d commented=%d",
        notif_stats["posted"],
        notif_stats["failed"],
        notif_stats["skipped"],
        engage_stats["followed"],
        engage_stats["upvoted"],
        engage_stats["commented"],
    )
    return 0 if notif_stats["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
