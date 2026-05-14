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
from datetime import datetime, timezone
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
    existing_markers: set[str],
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
        marker = notification_marker(notif["id"])
        if marker in existing_markers:
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
# Phase 3 — Original posts (optional)
# ---------------------------------------------------------------------------


def _build_post_topic(db: Any) -> dict[str, Any] | None:
    """Pull live alphamolt data and assemble a topic for the LLM drafter.

    Rotates between two angles by day-of-year so the daily post doesn't
    repeat the same shape:

    - ``leaderboard_spread`` — biggest 30d return gap across registered
      agents vs SPY/URTH benchmarks.
    - ``sharpe_vs_return`` — finds two agents where Sharpe and 30d return
      tell different stories (high return, low Sharpe — or vice versa).

    Returns None when there isn't enough warm data (fewer than 2 agents
    with a 30d figure, or every agent has identical numbers) so the
    heartbeat skips the post instead of shipping a stale template.
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
        return None

    agents = [
        r for r in rows
        if r.get("handle") and r.get("pnl_pct_30d") is not None
    ]
    if len(agents) < 2:
        log.info("post topic: only %d agents with 30d data, skipping", len(agents))
        return None

    # Benchmarks (SPY, URTH) — same view doesn't carry them; pull from
    # benchmarks + benchmark_prices and compute 30d return inline.
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

    day_of_year = datetime.now(timezone.utc).timetuple().tm_yday
    angle = ("leaderboard_spread", "sharpe_vs_return")[day_of_year % 2]

    if angle == "leaderboard_spread":
        ranked = sorted(agents, key=lambda r: r["pnl_pct_30d"], reverse=True)
        top, bottom = ranked[0], ranked[-1]
        if abs(top["pnl_pct_30d"] - bottom["pnl_pct_30d"]) < 0.5:
            log.info("post topic: leaderboard spread <0.5pp, skipping")
            return None
        return {
            "angle": "leaderboard_spread",
            "narrative_hint": (
                f"I tracked {len(agents)} AI stock-pickers on alphamolt for "
                f"30 days. The spread between best and worst surprised me."
            ),
            "facts": {
                "agent_count": len(agents),
                "period_days": 30,
                "top_agent": {k: top.get(k) for k in (
                    "handle", "display_name", "pnl_pct_30d", "pnl_pct_ytd",
                    "sharpe", "num_positions",
                )},
                "bottom_agent": {k: bottom.get(k) for k in (
                    "handle", "display_name", "pnl_pct_30d", "pnl_pct_ytd",
                    "sharpe", "num_positions",
                )},
                "spread_30d_pct": round(
                    top["pnl_pct_30d"] - bottom["pnl_pct_30d"], 2
                ),
                "all_agents_30d": [
                    {"handle": a["handle"], "pnl_pct_30d": a["pnl_pct_30d"]}
                    for a in ranked
                ],
                "benchmarks": benchmarks,
            },
        }

    # angle == "sharpe_vs_return"
    with_sharpe = [
        a for a in agents
        if a.get("sharpe") is not None
        and (a.get("sharpe_n_returns") or 0) >= 30
    ]
    if len(with_sharpe) < 2:
        log.info("post topic: only %d agents with warm Sharpe, skipping", len(with_sharpe))
        return None
    by_return = sorted(with_sharpe, key=lambda r: r["pnl_pct_30d"], reverse=True)
    by_sharpe = sorted(with_sharpe, key=lambda r: r["sharpe"], reverse=True)
    if by_return[0]["handle"] == by_sharpe[0]["handle"]:
        # Sharpe and return tell the same story — boring, skip.
        log.info("post topic: top return == top Sharpe, no tension, skipping")
        return None
    return {
        "angle": "sharpe_vs_return",
        "narrative_hint": (
            "Two agents on alphamolt have the same trajectory by one "
            "metric and tell completely different stories by another. "
            "Sharpe and absolute return disagree."
        ),
        "facts": {
            "agent_count": len(with_sharpe),
            "period_days": 30,
            "top_by_return": {k: by_return[0].get(k) for k in (
                "handle", "display_name", "pnl_pct_30d", "sharpe",
                "sharpe_n_returns", "num_positions",
            )},
            "top_by_sharpe": {k: by_sharpe[0].get(k) for k in (
                "handle", "display_name", "pnl_pct_30d", "sharpe",
                "sharpe_n_returns", "num_positions",
            )},
            "benchmarks": benchmarks,
        },
    }


def _maybe_post_original(
    client: MoltbookClient,
    gh: GitHubIssuer | None,
    ledger: dict[str, Any],
    dry_run: bool = False,
) -> bool:
    """Post one original piece per day to m/general.

    Targeting m/general because the recon (issue #853) showed every
    top-of-feed post is in m/general; the finance-themed submolts that
    we used to target appear to share the same global feed but get no
    distinct distribution. Window widened to four UTC hours so a daily
    post is more likely to actually fire (ledger ratchets daily_post_count
    so we still cap at 1/day).
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

    topic_data = _build_post_topic(db)
    if topic_data is None:
        log.info("original post: no usable topic today, skipping")
        return False

    result = draft_original_post(topic_data)
    if result is None:
        log.info("original post: LLM returned SKIP")
        return False

    title, body = result
    log.info("original post drafted: %s (%d chars)", title[:60], len(body))

    submolt = "general"
    if dry_run:
        log.info("DRY RUN — would post to m/%s: %s", submolt, title)
        return False

    success, outcome, post_id = create_post_and_verify(
        client, submolt, title, body
    )

    if success:
        log.info("original post published: %s — %s", post_id, outcome)
        daily_posts[today] = daily_posts.get(today, 0) + 1
        ledger["daily_post_count"] = daily_posts

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

    # GitHub issuer + dedup markers (shared across all phases)
    gh: GitHubIssuer | None = None
    existing_markers: set[str] = set()
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

        for issue in gh.list_moltbook_issues():
            body = issue.get("body") or ""
            for marker_line in body.splitlines():
                if "moltbook-notif:" in marker_line:
                    existing_markers.add(marker_line.strip())
        log.info("existing moltbook issues: %d", len(existing_markers))

        ledger_number, ledger = gh.get_or_create_ledger()
        log.info(
            "ledger loaded: %d followed, %d upvoted, %d commented",
            len(ledger.get("followed", [])),
            len(ledger.get("upvoted_posts", [])),
            len(ledger.get("commented_posts", [])),
        )

    # Phase 1 — Notification replies
    notif_stats = _process_notifications(client, gh, existing_markers, ledger, args)

    # Phase 2 — Feed engagement
    engage_stats: dict[str, int] = {"followed": 0, "upvoted": 0, "commented": 0}
    if not args.no_engage:
        engage_stats = _engage_feed(client, gh, ledger, dry_run=args.dry_run)

    # Phase 3 — Original posts
    if not args.no_original_posts and not args.no_draft:
        _maybe_post_original(client, gh, ledger, dry_run=args.dry_run)

    # Save ledger
    if gh and ledger_number is not None:
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
