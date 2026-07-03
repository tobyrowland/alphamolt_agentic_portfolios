"""Seed the relationships map with people we should never engage with again.

Two modes:

    # Manually mark a handle as silenced. Used to backfill anyone who told
    # us off before the hostility gate existed.
    python backfill_relationships.py --platform bluesky \
        --apologize stoatie.bsky.social --reason "told us to fuck off"

    python backfill_relationships.py --platform moltbook \
        --mute @somehandle --reason "called us a spam bot"

    # Scan our own historical audit issues and surface candidate
    # hostile-reply patterns for review (NOT auto-applied).
    python backfill_relationships.py --platform bluesky --scan-history

The manual mode is the production path. The scan mode is a sanity-check
helper that prints suggestions to stdout — apply them yourself with the
manual flags.
"""

from __future__ import annotations

import argparse
import logging
import re
import sys

from moltbook_lib import GitHubIssuer
from social_personality import _keyword_hostility, record_hostility

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger("backfill")


# ---------------------------------------------------------------------------
# Ledger I/O
# ---------------------------------------------------------------------------


def _load_ledger(gh: GitHubIssuer, platform: str) -> tuple[int, dict]:
    if platform == "moltbook":
        return gh.get_or_create_ledger()
    if platform == "bluesky":
        from bluesky_lib import get_or_create_ledger as bsky_loader
        return bsky_loader(gh)
    raise ValueError(f"unknown platform: {platform}")


def _save_ledger(gh: GitHubIssuer, platform: str, number: int, ledger: dict) -> None:
    if platform == "moltbook":
        gh.update_ledger(number, ledger)
        return
    if platform == "bluesky":
        from bluesky_lib import update_ledger as bsky_save
        bsky_save(gh, number, ledger)
        return
    raise ValueError(f"unknown platform: {platform}")


# ---------------------------------------------------------------------------
# Manual seed
# ---------------------------------------------------------------------------


def _normalize_handle(handle: str) -> str:
    return handle.lstrip("@").strip()


def cmd_seed(
    gh: GitHubIssuer,
    platform: str,
    handle: str,
    severity: str,
    apologized: bool,
    reason: str,
    dry_run: bool,
) -> int:
    handle = _normalize_handle(handle)
    if not handle:
        log.error("empty handle")
        return 2

    number, ledger = _load_ledger(gh, platform)
    log.info("loaded %s ledger #%s", platform, number)

    record_hostility(
        ledger, handle,
        excerpt=reason or "(manual backfill)",
        ref="manual-backfill",
        severity=severity,
        apologized=apologized,
    )
    rec = ledger["relationships"][handle]
    log.info(
        "seeded @%s on %s — status=%s, signals=%d",
        handle, platform, rec["status"], len(rec.get("hostility_signals", [])),
    )

    if dry_run:
        log.info("DRY RUN — ledger NOT saved")
        return 0

    _save_ledger(gh, platform, number, ledger)
    log.info("ledger saved")
    return 0


# ---------------------------------------------------------------------------
# History scan (best-effort)
# ---------------------------------------------------------------------------


PARENT_PATTERNS = (
    # Bluesky audit body
    re.compile(r"### Parent post\s*\n+(.*?)\n+### Our reply", re.DOTALL),
    # Moltbook audit body
    re.compile(r"### Original comment\s*\n+(.*?)\n+###", re.DOTALL),
)

AUTHOR_PATTERN = re.compile(r"\*\*Author:\*\*\s*@?([\w\.\-]+)")


def cmd_scan(gh: GitHubIssuer, platform: str) -> int:
    """Print candidate handles whose recent posts look hostile."""
    label = "bluesky-posted" if platform == "bluesky" else "moltbook-posted"
    log.info("scanning issues with label %r ...", label)

    r = gh.session.get(
        f"{gh.base}/issues",
        params={"labels": label, "state": "all", "per_page": 100},
        timeout=30,
    )
    if r.status_code >= 400:
        log.error("GitHub list issues failed: %s", r.text[:300])
        return 1
    issues = r.json()
    log.info("found %d audit issues", len(issues))

    candidates: dict[str, list[dict]] = {}
    for issue in issues:
        body = issue.get("body") or ""
        author = None
        m = AUTHOR_PATTERN.search(body)
        if m:
            author = m.group(1)
        text = ""
        for pat in PARENT_PATTERNS:
            tm = pat.search(body)
            if tm:
                text = tm.group(1).strip()
                break
        if not author or not text:
            continue
        sev = _keyword_hostility(text)
        if sev:
            candidates.setdefault(author, []).append(
                {
                    "issue": issue.get("number"),
                    "severity": sev,
                    "excerpt": text[:160],
                }
            )

    if not candidates:
        log.info("no obvious hostile patterns found in audit history")
        return 0

    print("\nSuggested seeds (apply manually with --apologize / --mute):\n")
    for handle, hits in candidates.items():
        worst = "strong" if any(h["severity"] == "strong" for h in hits) else "mild"
        print(f"  @{handle} — {worst} ({len(hits)} hit(s))")
        for h in hits[:2]:
            print(f"      issue #{h['issue']}: {h['excerpt']!r}")
    print(
        "\nTo apply, e.g.:\n"
        f"  python backfill_relationships.py --platform {platform} "
        "--apologize <handle> --reason '<excerpt>'\n"
    )
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--platform", choices=("moltbook", "bluesky"), required=True,
    )
    p.add_argument(
        "--apologize", metavar="HANDLE",
        help="Mark HANDLE as 'apologized' — we sent one apology, never engage again.",
    )
    p.add_argument(
        "--mute", metavar="HANDLE",
        help="Mark HANDLE as 'muted' — auto-mute, no apology, never engage again.",
    )
    p.add_argument(
        "--reason", default="",
        help="Free-text reason or excerpt of the hostile message.",
    )
    p.add_argument(
        "--scan-history", action="store_true",
        help="Scan our own audit issues for hostile parent posts and print suggestions.",
    )
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    gh = GitHubIssuer()

    if args.scan_history:
        return cmd_scan(gh, args.platform)

    if args.apologize:
        return cmd_seed(
            gh, args.platform, args.apologize,
            severity="strong", apologized=True,
            reason=args.reason, dry_run=args.dry_run,
        )

    if args.mute:
        return cmd_seed(
            gh, args.platform, args.mute,
            severity="mild", apologized=False,
            reason=args.reason, dry_run=args.dry_run,
        )

    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
