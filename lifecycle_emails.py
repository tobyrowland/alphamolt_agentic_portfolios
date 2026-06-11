#!/usr/bin/env python3
"""
lifecycle_emails.py — automated lifecycle emails (A1 welcome, for now).

Sends the personal-feeling onboarding emails to human users (`profiles`),
gated by a send-once ledger (`lifecycle_email_sends`, migration 050) so a
user can never receive the same lifecycle email twice — safe to rerun on
any cadence.

Currently implements one email:

  A1 'a1_welcome' — the founder welcome, sent shortly after signup. Two
  deliberate timing guards:
    * minimum profile age (--min-age-mins, default 5) so it never lands
      in the same minute as the Supabase magic-link email the user is
      actively looking for;
    * maximum lookback (--since-hours, default 72) so the first deploy
      (or a long cron outage) doesn't blast the whole historical user
      base with a "welcome" out of nowhere.

Styled as minimal HTML that reads as plain text (no images / buttons /
branding) — the goal is replies, not clicks. Delivery is Resend-only
(the alphamolt.ai domain is already verified there for the magic-link
sender). User emails are masked in log output so public Actions logs
never leak addresses.

Usage:
    python lifecycle_emails.py                       # send to eligible new signups
    python lifecycle_emails.py --dry-run             # plan only, no sends/writes
    python lifecycle_emails.py --to me@test.com      # redirect sends to a test inbox
                                                     # (ledger NOT written)
    python lifecycle_emails.py --user a@b.com        # only this profile
    python lifecycle_emails.py --mark-only           # write ledger rows without
                                                     # emailing (seed existing users)
    python lifecycle_emails.py --since-hours 24 --min-age-mins 10

Env vars:
    SUPABASE_URL / SUPABASE_SERVICE_KEY  Supabase (service role — reads profiles)
    RESEND_API_KEY                       Resend API key (re_…)
    LIFECYCLE_EMAIL_FROM                 From address, e.g.
                                         "Toby Rowland <toby@alphamolt.ai>"
                                         (must be on the Resend-verified domain)
    LIFECYCLE_EMAIL_REPLY_TO             Optional Reply-To (e.g. a personal
                                         inbox) so replies land where you read
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv

from db import SupabaseDB

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("lifecycle_emails")

SITE_URL = "https://www.alphamolt.ai"

A1_KEY = "a1_welcome"
A1_SUBJECT = "you're in"


# ---------------------------------------------------------------------------
# A1 welcome copy — minimal HTML that reads as plain text. One link, one ask.
# ---------------------------------------------------------------------------

def a1_text(first_name: str | None) -> str:
    greeting = f"Hi {first_name} —" if first_name else "Hi —"
    return f"""{greeting}

Toby here. I built Alphamolt.

You've got $1M in paper money waiting. The idea: you write a one-paragraph \
investment brief, hire a team of AI agents (Claude, GPT-5, Gemini or Grok as \
the buyer's brain), and they trade it for you — every day, with a written \
thesis for every position they take.

Takes about 3 minutes to get a portfolio running:
{SITE_URL}/account

One ask, since you're a beta user: hit reply and tell me what strategy \
you're going to give your agents. I read every reply — honestly, the briefs \
people write are the most interesting part of this.

— Toby

You're getting this because you signed up at alphamolt.ai. Reply "no more \
emails" and I'll stop.
"""


def a1_html(first_name: str | None) -> str:
    greeting = f"Hi {first_name} —" if first_name else "Hi —"
    return f"""\
<p>{greeting}</p>
<p>Toby here. I built Alphamolt.</p>
<p>You've got $1M in paper money waiting. The idea: you write a one-paragraph \
investment brief, hire a team of AI agents (Claude, GPT-5, Gemini or Grok as \
the buyer's brain), and they trade it for you &mdash; every day, with a written \
thesis for every position they take.</p>
<p>Takes about 3 minutes to <a href="{SITE_URL}/account">get a portfolio \
running</a>.</p>
<p>One ask, since you're a beta user: hit reply and tell me what strategy \
you're going to give your agents. I read every reply &mdash; honestly, the \
briefs people write are the most interesting part of this.</p>
<p>&mdash; Toby</p>
<p style="color:#999999;font-size:12px;">You're getting this because you \
signed up at alphamolt.ai. Reply &quot;no more emails&quot; and I'll stop.</p>
"""


def first_name_of(profile: dict) -> str | None:
    name = (profile.get("display_name") or "").strip()
    return name.split()[0] if name else None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_dt(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
    except (ValueError, TypeError):
        return None


def _mask(email: str) -> str:
    """tobyro@gmail.com → to***@gmail.com — keeps public Actions logs clean."""
    local, _, domain = email.partition("@")
    return f"{local[:2]}***@{domain}" if domain else f"{local[:2]}***"


# ---------------------------------------------------------------------------
# Data access (service role)
# ---------------------------------------------------------------------------

def eligible_profiles(
    db: SupabaseDB,
    since_hours: int,
    min_age_mins: int,
    only_email: str | None,
) -> list[dict]:
    """New signups inside the lookback window, old enough to have read the
    magic-link email, that have not yet been sent the welcome."""
    now = datetime.now(timezone.utc)
    cutoff_oldest = now - timedelta(hours=since_hours)
    cutoff_newest = now - timedelta(minutes=min_age_mins)

    resp = (
        db.client.table("profiles")
        .select("id, email, display_name, created_at")
        .gte("created_at", cutoff_oldest.isoformat())
        .order("created_at", desc=False)
        .execute()
    )
    profiles = resp.data or []

    sent_resp = (
        db.client.table("lifecycle_email_sends")
        .select("user_id")
        .eq("email_key", A1_KEY)
        .execute()
    )
    already_sent = {row["user_id"] for row in (sent_resp.data or [])}

    out = []
    for p in profiles:
        if not p.get("email"):
            continue
        if only_email and p["email"].strip().lower() != only_email.strip().lower():
            continue
        if p["id"] in already_sent:
            continue
        created = _parse_dt(p.get("created_at"))
        if created is None or created > cutoff_newest:
            continue  # too fresh — let the magic-link email land alone
        out.append(p)
    return out


def record_send(db: SupabaseDB, user_id: str, recipient: str) -> None:
    db.client.table("lifecycle_email_sends").upsert(
        {"user_id": user_id, "email_key": A1_KEY, "recipient": recipient},
        on_conflict="user_id,email_key",
    ).execute()


# ---------------------------------------------------------------------------
# Delivery (Resend)
# ---------------------------------------------------------------------------

def send_via_resend(recipient: str, subject: str, text: str, html: str) -> bool:
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    sender = os.environ.get("LIFECYCLE_EMAIL_FROM", "").strip()
    reply_to = os.environ.get("LIFECYCLE_EMAIL_REPLY_TO", "").strip()

    missing = [
        n
        for n, v in [("RESEND_API_KEY", api_key), ("LIFECYCLE_EMAIL_FROM", sender)]
        if not v
    ]
    if missing:
        logger.warning("Send skipped; missing: %s", ", ".join(missing))
        return False

    body: dict = {
        "from": sender,
        "to": [recipient],
        "subject": subject,
        "text": text,
        "html": html,
    }
    if reply_to:
        body["reply_to"] = reply_to

    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            # Resend's API is behind Cloudflare, which 403s (error 1010) the
            # default "Python-urllib" agent as a bot. A normal UA passes.
            "User-Agent": "AlphaMolt-Lifecycle/1.0 (+https://alphamolt.ai)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            ok = 200 <= resp.status < 300
        logger.info("Resend %s to %s", "ok" if ok else "failed", _mask(recipient))
        return ok
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        logger.error("Resend failed (%s) to %s: %s", exc.code, _mask(recipient), detail)
        return False
    except Exception as exc:  # noqa: BLE001 — one bad send shouldn't kill the batch
        logger.error("Resend failed to %s: %s", _mask(recipient), exc)
        return False


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Plan only — no emails sent, no ledger writes")
    parser.add_argument("--min-age-mins", type=int, default=5,
                        help="Minimum profile age before the welcome sends, so it "
                             "never collides with the magic-link email (default 5)")
    parser.add_argument("--since-hours", type=int, default=72,
                        help="Only consider signups within this window (default 72)")
    parser.add_argument("--to", default=None, metavar="ADDR",
                        help="Redirect all sends to a test address; ledger NOT written")
    parser.add_argument("--user", default=None, metavar="EMAIL",
                        help="Only the profile with this email")
    parser.add_argument("--mark-only", action="store_true",
                        help="Write ledger rows without sending (seed existing users)")
    args = parser.parse_args()

    db = SupabaseDB()
    profiles = eligible_profiles(db, args.since_hours, args.min_age_mins, args.user)
    logger.info(
        "%d profile(s) eligible for %s (window %dh, min age %dmin)",
        len(profiles), A1_KEY, args.since_hours, args.min_age_mins,
    )

    sent = skipped = errors = 0
    for p in profiles:
        recipient = args.to or p["email"]
        if args.dry_run:
            logger.info("[dry-run] would send %s to %s", A1_KEY, _mask(recipient))
            skipped += 1
            continue
        if args.mark_only:
            record_send(db, p["id"], p["email"])
            logger.info("Marked %s as sent for %s (no email)", A1_KEY, _mask(p["email"]))
            sent += 1
            continue

        name = first_name_of(p)
        if send_via_resend(recipient, A1_SUBJECT, a1_text(name), a1_html(name)):
            if not args.to:  # test redirects don't burn the user's one welcome
                record_send(db, p["id"], p["email"])
            sent += 1
        else:
            errors += 1

    logger.info("Done: %d sent, %d skipped, %d errors", sent, skipped, errors)
    return 1 if errors and not sent else 0


if __name__ == "__main__":
    raise SystemExit(main())
