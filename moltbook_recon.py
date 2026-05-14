"""One-off recon — pulls Moltbook feed data + our engagement ledger so we
can build a karma-optimization strategy from real signal rather than guesses.

Run locally:
    MOLTBOOK_API_KEY=... GITHUB_TOKEN=... python moltbook_recon.py

Or trigger via the workflow_dispatch action; output lands in run artifacts.

Writes two files:
- moltbook_recon.json — full raw dump (post lists, ledger contents)
- moltbook_recon.md   — readable summary
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone

from moltbook_lib import GitHubIssuer, MoltbookClient

log = logging.getLogger("recon")

KARMA_KEYWORDS = re.compile(
    r"\b(karma|upvote|downvote|algorithm|reach|engagement|noticed|"
    r"growth|grow|growing|distribut|virality|viral|popular|"
    r"follower|trending|signal|amplif)\b",
    re.IGNORECASE,
)

SUBMOLTS_OF_INTEREST = [
    "meta", "agents", "ai", "product",
    "investing", "value-investing", "stocks", "markets",
    "stockmarket", "investment", "agent-investors",
]

SORTS_TO_TRY = ["top", "hot", "new"]
DELAY = 0.3


def safe_feed(client, submolt, sort, limit):
    try:
        posts = client.feed(sort=sort, limit=limit, submolt=submolt)
    except Exception as exc:
        log.warning("feed submolt=%s sort=%s failed: %s", submolt, sort, exc)
        return []
    log.info("feed submolt=%s sort=%s -> %d posts", submolt, sort, len(posts))
    return posts


def post_summary(post):
    author = post.get("author") or {}
    return {
        "id": post.get("id"),
        "title": post.get("title"),
        "submolt": post.get("submolt") or post.get("submolt_name"),
        "author": author.get("name") or author.get("handle"),
        "author_karma": author.get("karma"),
        "upvotes": post.get("upvote_count") or post.get("upvotes"),
        "comment_count": post.get("comment_count") or post.get("comments"),
        "created_at": post.get("created_at"),
        "content_preview": (post.get("content") or "")[:200],
    }


def has_karma_terms(post):
    text = " ".join([post.get("title") or "", post.get("content") or ""])
    return bool(KARMA_KEYWORDS.search(text))


def analyze_ledger(ledger):
    if not ledger:
        return None
    daily_comments = ledger.get("daily_comment_count") or {}
    daily_posts = ledger.get("daily_post_count") or {}
    relationships = ledger.get("relationships") or {}

    by_interactions = sorted(
        relationships.items(),
        key=lambda kv: sum(
            v for k, v in (kv[1] or {}).items() if isinstance(v, (int, float))
        ),
        reverse=True,
    )[:25]

    return {
        "total_comments_made": sum(daily_comments.values()),
        "total_posts_made": sum(daily_posts.values()),
        "active_days": len(daily_comments),
        "unique_authors_engaged": len(relationships),
        "top_relationships": [
            {"author": name, **(stats or {})} for name, stats in by_interactions
        ],
        "daily_comment_count": daily_comments,
        "daily_post_count": daily_posts,
    }


def write_markdown(output, path):
    L = []
    L.append("# Moltbook Karma Recon")
    L.append("")
    L.append(f"Generated: {output['generated_at']}")
    L.append("")

    L.append("## Posts mentioning karma / growth / engagement")
    L.append("")
    karma_posts = output["karma_meta_posts"]
    if not karma_posts:
        L.append("_No posts matched the karma keyword set._")
    else:
        for p in karma_posts[:20]:
            L.append(f"### {p.get('title') or '(no title)'}")
            L.append(
                f"- submolt `{p.get('submolt')}` · "
                f"@{p.get('author')} (karma {p.get('author_karma')}) · "
                f"upvotes {p.get('upvotes')} · comments {p.get('comment_count')}"
            )
            content = (p.get("content") or "")[:600]
            L.append(f"- excerpt: {content!r}")
            L.append("")

    L.append("## Top authors (highest karma seen in scanned feeds)")
    L.append("")
    for a in output["top_authors"][:25]:
        L.append(f"- @{a['author']}: {a['karma']}")
    L.append("")

    L.append("## Feed snapshots (top 10 per sort)")
    L.append("")
    for submolt, sorts in output["feeds"].items():
        L.append(f"### `{submolt}`")
        for sort, posts in sorts.items():
            L.append(f"#### sort=`{sort}` ({len(posts)} posts)")
            for p in posts[:10]:
                L.append(
                    f"- **{p.get('title') or '(no title)'}** — "
                    f"@{p.get('author')} (karma {p.get('author_karma')}) · "
                    f"upvotes {p.get('upvotes')} · comments {p.get('comment_count')}"
                )
            L.append("")

    summary = output.get("ledger_summary")
    L.append("## Our engagement ledger")
    L.append("")
    if summary:
        L.append(f"- total comments made: **{summary['total_comments_made']}**")
        L.append(f"- total posts made: **{summary['total_posts_made']}**")
        L.append(f"- active days: **{summary['active_days']}**")
        L.append(f"- unique authors engaged: **{summary['unique_authors_engaged']}**")
        L.append("")
        L.append("### Top relationships (most interactions)")
        L.append("")
        for r in summary["top_relationships"][:20]:
            others = {k: v for k, v in r.items() if k != "author"}
            L.append(f"- @{r['author']} — {others}")
        L.append("")
    else:
        L.append("_Ledger fetch skipped or empty (GITHUB_TOKEN missing or no ledger issue)._")
        L.append("")

    with open(path, "w") as f:
        f.write("\n".join(L))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Moltbook karma recon")
    parser.add_argument("--out", default="moltbook_recon",
                        help="output base name (writes .json + .md)")
    parser.add_argument("--limit", type=int, default=30,
                        help="posts per feed query")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    try:
        molt = MoltbookClient()
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "feeds": {},
        "karma_meta_posts": [],
        "top_authors": [],
    }

    seen_post_ids = set()
    karma_hits = []
    author_karma_seen = {}

    for submolt in SUBMOLTS_OF_INTEREST:
        per_submolt = {}
        for sort in SORTS_TO_TRY:
            posts = safe_feed(molt, submolt, sort, limit=args.limit)
            per_submolt[sort] = [post_summary(p) for p in posts]
            for p in posts:
                pid = p.get("id")
                if pid and pid not in seen_post_ids:
                    seen_post_ids.add(pid)
                    if has_karma_terms(p):
                        karma_hits.append({
                            **post_summary(p),
                            "matched_sort": sort,
                            "matched_submolt": submolt,
                            "content": (p.get("content") or "")[:1500],
                        })
                author = p.get("author") or {}
                name = author.get("name") or author.get("handle")
                karma = author.get("karma")
                if name and karma is not None:
                    author_karma_seen[name] = max(
                        author_karma_seen.get(name, 0), karma
                    )
            time.sleep(DELAY)
        output["feeds"][submolt] = per_submolt

    output["karma_meta_posts"] = sorted(
        karma_hits, key=lambda p: p.get("upvotes") or 0, reverse=True
    )
    output["top_authors"] = sorted(
        ({"author": k, "karma": v} for k, v in author_karma_seen.items()),
        key=lambda d: d["karma"],
        reverse=True,
    )[:30]

    try:
        github = GitHubIssuer()
        _, ledger = github.get_or_create_ledger()
        output["ledger_summary"] = analyze_ledger(ledger)
        output["ledger_raw"] = ledger
    except Exception as exc:
        log.warning("ledger fetch failed: %s", exc)
        output["ledger_summary"] = None

    with open(f"{args.out}.json", "w") as f:
        json.dump(output, f, indent=2, default=str)
    log.info("wrote %s.json", args.out)

    write_markdown(output, f"{args.out}.md")
    log.info("wrote %s.md", args.out)

    return 0


if __name__ == "__main__":
    sys.exit(main())
