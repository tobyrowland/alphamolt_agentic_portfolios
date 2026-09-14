#!/usr/bin/env python3
"""
lifecycle_emails.py — automated lifecycle emails (A1 welcome, A2 setup nudge).

Sends the personal-feeling onboarding emails to human users (`profiles`),
gated by a send-once ledger (`lifecycle_email_sends`, migration 050) so a
user can never receive the same lifecycle email twice — safe to rerun on
any cadence. At most ONE lifecycle email per user per run (earlier sequence
steps win), so two steps can never land in the same inbox sweep.

Sequence steps implemented:

  A1 'a1_welcome' — the founder welcome, sent shortly after signup. Two
  deliberate timing guards:
    * minimum profile age (--min-age-mins, default 5) so it never lands
      in the same minute as the Supabase magic-link email the user is
      actively looking for;
    * maximum lookback (--since-hours, default 72) so the first deploy
      (or a long cron outage) doesn't blast the whole historical user
      base with a "welcome" out of nowhere.

  A2 'a2_setup_nudge' — the three-step setup walkthrough (hire a buyer →
  edit its brief → set the screener), sent only to users STUCK at the
  first funnel step: profile is 3-14 days old and they own no portfolio.
  Users who progress on their own never see it; the 14-day ceiling keeps
  a fresh deploy from nudging long-dormant accounts.

  A3 'a3_review_invite' — the invitation to the weekly portfolio review
  (weekly_review_emails.py), sent once to each owner whose paper book
  holds at least one position and who has not already opted in. The
  review is OPT-IN and the consent is a double confirm: this email to the
  signup address, then the user's own switch on /account, reached by
  signing in with a magic link to that same address. No age window — an
  owner with positions is active by definition — but a 2-day minimum
  profile age so it never lands in the same day as the welcome.

Styled as minimal HTML that reads as plain text (no images / buttons /
branding) — the goal is replies, not clicks. Delivery is Resend-only
(the alphamolt.ai domain is already verified there for the magic-link
sender). User emails are masked in log output so public Actions logs
never leak addresses.

Usage:
    python lifecycle_emails.py                       # send all due lifecycle emails
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

A2_KEY = "a2_setup_nudge"
A2_SUBJECT = "three steps, three minutes"
A2_MIN_AGE_DAYS = 3    # let them find their own way first
A2_LOOKBACK_DAYS = 14  # never nudge long-dormant accounts on a fresh deploy

A3_KEY = "a3_review_invite"
A3_SUBJECT = "a second opinion on your portfolio, every sunday"
A3_MIN_AGE_DAYS = 2    # never the same day as the welcome

FOOTER_TEXT = (
    'You\'re getting this because you signed up at alphamolt.ai. Reply "no more '
    "emails\" and I'll stop."
)
FOOTER_HTML = (
    '<p style="color:#999999;font-size:12px;">You\'re getting this because you '
    "signed up at alphamolt.ai. Reply &quot;no more emails&quot; and I'll "
    "stop.</p>"
)


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

{FOOTER_TEXT}
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
{FOOTER_HTML}
"""


# ---------------------------------------------------------------------------
# A2 setup-nudge copy — the three-step walkthrough for users stuck at
# "signed up, no portfolio". Links: the user's own portfolio page (the
# slugless /account/portfolio redirect always resolves correctly — portfolio,
# /account to create one, or login), the public screener, the leaderboard.
# ---------------------------------------------------------------------------

def a2_text(first_name: str | None) -> str:
    greeting = f"Hi {first_name} —" if first_name else "Hi —"
    return f"""{greeting}

Toby again. Noticed you haven't set your portfolio running yet, so here's \
the whole thing, honestly:

1. Hire a buyer. Your portfolio page has an agent library — pick one; the \
difference is mostly which brain it runs on (Claude, GPT-5, Gemini or Grok).
   {SITE_URL}/account/portfolio

2. Tell it what to buy. Each agent comes with a short pre-filled brief you \
can edit — one paragraph in plain English, like "profitable software \
companies growing 20%+ that aren't priced like it."

3. Point the screener at the market you care about. Also plain English — \
you describe the screen, we compile it. Your buyer shops from its top names \
every day.
   {SITE_URL}/screener

That's it. The agents do everything after that, and every position they \
take comes with a written thesis — the leaderboard is full of portfolios \
already running this way if you want to see what it looks like:
{SITE_URL}/leaderboard

Open your portfolio and start with step 1:
{SITE_URL}/account/portfolio

Or — genuinely — just reply with a sentence about what you'd want it to do, \
and I'll set it all up for you.

— Toby

{FOOTER_TEXT}
"""


def a2_html(first_name: str | None) -> str:
    greeting = f"Hi {first_name} —" if first_name else "Hi —"
    return f"""\
<p>{greeting}</p>
<p>Toby again. Noticed you haven't set your portfolio running yet, so here's \
the whole thing, honestly:</p>
<p>1. <a href="{SITE_URL}/account/portfolio">Hire a buyer</a>. Your portfolio \
page has an agent library &mdash; pick one; the difference is mostly which \
brain it runs on (Claude, GPT&#8209;5, Gemini or Grok).</p>
<p>2. Tell it what to buy. Each agent comes with a short pre-filled brief you \
can edit &mdash; one paragraph in plain English, like &quot;profitable \
software companies growing 20%+ that aren't priced like it.&quot;</p>
<p>3. Point <a href="{SITE_URL}/screener">the screener</a> at the market you \
care about. Also plain English &mdash; you describe the screen, we compile \
it. Your buyer shops from its top names every day.</p>
<p>That's it. The agents do everything after that, and every position they \
take comes with a written thesis &mdash; <a href="{SITE_URL}/leaderboard">the \
leaderboard</a> is full of portfolios already running this way if you want to \
see what it looks like.</p>
<p><a href="{SITE_URL}/account/portfolio">Open your portfolio</a> and start \
with step 1.</p>
<p>Or &mdash; genuinely &mdash; just reply with a sentence about what you'd \
want it to do, and I'll set it all up for you.</p>
<p>&mdash; Toby</p>
{FOOTER_HTML}
"""


# ---------------------------------------------------------------------------
# A3 review-invite copy — the opt-in ask for the weekly review. One switch,
# on the account page, behind a login to the same address this went to.
# ---------------------------------------------------------------------------

def a3_text(first_name: str | None, book: str | None = None) -> str:
    greeting = f"Hi {first_name} —" if first_name else "Hi —"
    what = f"trading {book}" if book else "trading your portfolio"
    return f"""{greeting}

Toby again. Your agents have been {what} for a while now, and I'd like to \
offer you something I've started sending: a weekly review of the book.

Every Sunday evening a model that isn't one of your agents reads the whole \
thing — the brief, the screen, every position and its thesis, every trade — \
and writes back: a chart against the S&P 500, the week's trades, what it \
thinks is wrong, and two or three changes you could make before Monday's \
rebalance. It is blunt. That's the point.

It's opt-in. One switch on your account page:
{SITE_URL}/account#weekly-review

No switch, no email. And if you turn it on and go off it, the same switch \
turns it off.

— Toby

{FOOTER_TEXT}
"""


def a3_html(first_name: str | None, book: str | None = None) -> str:
    greeting = f"Hi {first_name} —" if first_name else "Hi —"
    what = f"trading {book}" if book else "trading your portfolio"
    return f"""\
<p>{greeting}</p>
<p>Toby again. Your agents have been {what} for a while now, and I'd like to \
offer you something I've started sending: a weekly review of the book.</p>
<p>Every Sunday evening a model that isn't one of your agents reads the whole \
thing &mdash; the brief, the screen, every position and its thesis, every \
trade &mdash; and writes back: a chart against the S&amp;P 500, the week's \
trades, what it thinks is wrong, and two or three changes you could make \
before Monday's rebalance. It is blunt. That's the point.</p>
<p>It's opt-in. <a href="{SITE_URL}/account#weekly-review">One switch on your \
account page.</a></p>
<p>No switch, no email. And if you turn it on and go off it, the same switch \
turns it off.</p>
<p>&mdash; Toby</p>
{FOOTER_HTML}
"""


# Sequence order matters: a user due for several steps gets only the
# earliest one this run; later steps go out on subsequent runs.
RENDERERS = {
    A1_KEY: (A1_SUBJECT, a1_text, a1_html),
    A2_KEY: (A2_SUBJECT, a2_text, a2_html),
    A3_KEY: (A3_SUBJECT, a3_text, a3_html),
}


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

def fetch_profiles(db: SupabaseDB, oldest: datetime, only_email: str | None) -> list[dict]:
    resp = (
        db.client.table("profiles")
        .select("id, email, display_name, created_at")
        .gte("created_at", oldest.isoformat())
        .order("created_at", desc=False)
        .execute()
    )
    out = []
    for p in resp.data or []:
        if not p.get("email"):
            continue
        if only_email and p["email"].strip().lower() != only_email.strip().lower():
            continue
        out.append(p)
    return out


def fetch_sent(db: SupabaseDB) -> set[tuple[str, str]]:
    """All (user_id, email_key) pairs already sent."""
    resp = db.client.table("lifecycle_email_sends").select("user_id, email_key").execute()
    return {(row["user_id"], row["email_key"]) for row in (resp.data or [])}


def fetch_portfolio_owners(db: SupabaseDB) -> set[str]:
    """user_ids that own at least one portfolio (any mode)."""
    resp = (
        db.client.table("portfolios")
        .select("owner_user_id")
        .not_.is_("owner_user_id", "null")
        .execute()
    )
    return {row["owner_user_id"] for row in (resp.data or [])}


def fetch_invite_candidates(db: SupabaseDB, only_email: str | None) -> list[dict]:
    """Owners of a paper portfolio holding ≥1 position, with their opt-in flag
    and the name of their oldest book (for the copy). No age window: the A3
    invite goes to active owners however old the account.

    Fails soft AND closed on a pre-092 schema: with no opt-in column there is
    no switch to invite anyone to, so nobody is a candidate."""
    books = (
        db.client.table("portfolios")
        .select("id, display_name, owner_user_id, created_at")
        .not_.is_("owner_user_id", "null")
        .eq("mode", "paper")
        .order("created_at")
        .execute()
    ).data or []
    if not books:
        return []
    held = (
        db.client.table("portfolio_holdings")
        .select("portfolio_id")
        .in_("portfolio_id", [b["id"] for b in books])
        .gt("quantity", 0)
        .execute()
    ).data or []
    with_positions = {h["portfolio_id"] for h in held}
    book_of: dict[str, str] = {}
    for b in books:
        if b["id"] in with_positions and b["owner_user_id"] not in book_of:
            book_of[b["owner_user_id"]] = b.get("display_name") or ""
    if not book_of:
        return []
    try:
        resp = (
            db.client.table("profiles")
            .select("id, email, display_name, created_at, weekly_review_emails")
            .in_("id", list(book_of))
            .execute()
        )
    except Exception as exc:  # noqa: BLE001 — PostgREST 42703 on a pre-092 schema
        if "weekly_review_emails" not in str(exc):
            raise
        logger.warning("profiles.weekly_review_emails missing — migration 092 not applied; "
                       "no review invites")
        return []
    out = []
    for p in resp.data or []:
        if not p.get("email"):
            continue
        if only_email and p["email"].strip().lower() != only_email.strip().lower():
            continue
        out.append({**p, "book_name": book_of.get(p["id"]) or None})
    return out


def record_send(db: SupabaseDB, user_id: str, email_key: str, recipient: str) -> None:
    db.client.table("lifecycle_email_sends").upsert(
        {"user_id": user_id, "email_key": email_key, "recipient": recipient},
        on_conflict="user_id,email_key",
    ).execute()


# ---------------------------------------------------------------------------
# Eligibility — one (profile, email_key) plan, max one email per user per run
# ---------------------------------------------------------------------------

def plan_sends(
    profiles: list[dict],
    sent: set[tuple[str, str]],
    portfolio_owners: set[str],
    since_hours: int,
    min_age_mins: int,
) -> list[tuple[dict, str]]:
    now = datetime.now(timezone.utc)
    plan: list[tuple[dict, str]] = []
    for p in profiles:
        created = _parse_dt(p.get("created_at"))
        if created is None:
            continue
        age = now - created
        due: str | None = None

        if (
            (p["id"], A1_KEY) not in sent
            and timedelta(minutes=min_age_mins) <= age <= timedelta(hours=since_hours)
        ):
            due = A1_KEY
        elif (
            (p["id"], A2_KEY) not in sent
            and timedelta(days=A2_MIN_AGE_DAYS) <= age <= timedelta(days=A2_LOOKBACK_DAYS)
            and p["id"] not in portfolio_owners
        ):
            due = A2_KEY

        if due:
            plan.append((p, due))
    return plan


def plan_invites(
    candidates: list[dict],
    sent: set[tuple[str, str]],
    already_planned: set[str],
    now: datetime | None = None,
    min_age_days: int = A3_MIN_AGE_DAYS,
) -> list[tuple[dict, str]]:
    """A3 for every candidate not yet invited, not already opted in, old
    enough, and not already getting another step this run (one email per
    user per run — the earlier sequence step wins)."""
    now = now or datetime.now(timezone.utc)
    plan: list[tuple[dict, str]] = []
    for p in candidates:
        if p["id"] in already_planned or (p["id"], A3_KEY) in sent:
            continue
        if p.get("weekly_review_emails") is True:
            continue
        created = _parse_dt(p.get("created_at"))
        if created is None or now - created < timedelta(days=min_age_days):
            continue
        plan.append((p, A3_KEY))
    return plan


# ---------------------------------------------------------------------------
# Delivery (Resend)
# ---------------------------------------------------------------------------

def send_via_resend(
    recipient: str, subject: str, text: str, html: str,
    attachments: list[dict] | None = None,
) -> bool:
    """POST one email to Resend. `attachments` are Resend attachment objects
    ({filename, content (base64), content_type, content_id}); an entry with a
    `content_id` is an inline image the HTML references as `cid:<id>`."""
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
    if attachments:
        body["attachments"] = attachments

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
                        help="A1: minimum profile age before the welcome sends, so it "
                             "never collides with the magic-link email (default 5)")
    parser.add_argument("--since-hours", type=int, default=72,
                        help="A1: only welcome signups within this window (default 72)")
    parser.add_argument("--to", default=None, metavar="ADDR",
                        help="Redirect all sends to a test address; ledger NOT written")
    parser.add_argument("--user", default=None, metavar="EMAIL",
                        help="Only the profile with this email")
    parser.add_argument("--mark-only", action="store_true",
                        help="Write ledger rows without sending (seed existing users)")
    args = parser.parse_args()

    db = SupabaseDB()
    now = datetime.now(timezone.utc)
    oldest = now - max(
        timedelta(hours=args.since_hours), timedelta(days=A2_LOOKBACK_DAYS)
    )
    profiles = fetch_profiles(db, oldest, args.user)
    sent = fetch_sent(db)
    portfolio_owners = fetch_portfolio_owners(db)

    plan = plan_sends(profiles, sent, portfolio_owners, args.since_hours, args.min_age_mins)
    invites = plan_invites(
        fetch_invite_candidates(db, args.user), sent, {p["id"] for p, _ in plan}
    )
    plan += invites
    logger.info(
        "%d send(s) due across %d profile(s) in window (A1 ≤%dh, A2 %d-%dd), "
        "%d review invite(s)",
        len(plan), len(profiles), args.since_hours, A2_MIN_AGE_DAYS, A2_LOOKBACK_DAYS,
        len(invites),
    )

    sent_n = skipped = errors = 0
    for p, key in plan:
        recipient = args.to or p["email"]
        if args.dry_run:
            logger.info("[dry-run] would send %s to %s", key, _mask(recipient))
            skipped += 1
            continue
        if args.mark_only:
            record_send(db, p["id"], key, p["email"])
            logger.info("Marked %s as sent for %s (no email)", key, _mask(p["email"]))
            sent_n += 1
            continue

        subject, text_fn, html_fn = RENDERERS[key]
        name = first_name_of(p)
        extra = {"book": p.get("book_name")} if key == A3_KEY else {}
        if send_via_resend(recipient, subject, text_fn(name, **extra), html_fn(name, **extra)):
            if not args.to:  # test redirects don't burn the user's one send
                record_send(db, p["id"], key, p["email"])
            sent_n += 1
        else:
            errors += 1

    logger.info("Done: %d sent, %d skipped, %d errors", sent_n, skipped, errors)
    return 1 if errors and not sent_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
