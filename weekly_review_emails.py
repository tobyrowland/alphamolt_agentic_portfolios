#!/usr/bin/env python3
"""
weekly_review_emails.py — the weekly portfolio review, emailed to each owner.

Every week, each human who is running a paper portfolio gets one email: a
model's critique of their book, written from the SAME review pack the
portfolio page's "Copy for AI review" button produces. The pack was designed
to be handed to a different model and asked "what do you think?"; this is
that act, done for the owner, on a schedule.

Why the pack and not a fresh summary: the pack already enforces the honesty
rules a review needs — closed positions and their losses included, marks
stated as closing prices, the sell discipline resolved against its defaults,
the already-fixed defects declared so the reviewer does not re-derive them —
and it ends with the questions worth asking. Rendering it here
(web/scripts/review-pack.mjs, a plain-node wrapper over
web/lib/portfolio-export.ts) means the email and the button can never
describe one book two ways.

Delivery is gated by the send-once ledger (`lifecycle_email_sends`,
migration 050) under a per-ISO-week key (`weekly_review_2026-W38`), so the
job is safe to rerun: a Monday outage is recovered by running it again on
Tuesday, which sends only to whoever was missed. A user can opt out via
`profiles.weekly_review_emails` (migration 092; `--opt-out EMAIL` sets it).
At most one email per user per week, covering every paper portfolio they
own that holds at least one position — a book with nothing in it has
nothing to review, and the A2 setup nudge covers users who never started.

Usage:
    python weekly_review_emails.py                   # send this week's reviews
    python weekly_review_emails.py --dry-run         # plan + render + write the
                                                     # reviews to stdout, send nothing
    python weekly_review_emails.py --to me@test.com  # redirect sends to a test inbox
                                                     # (ledger NOT written)
    python weekly_review_emails.py --user a@b.com    # only this profile
    python weekly_review_emails.py --mark-only       # ledger rows, no emails
    python weekly_review_emails.py --opt-out a@b.com # stop this user's reviews

Env vars:
    SUPABASE_URL / SUPABASE_SERVICE_KEY  Supabase (service role — reads profiles)
    GEMINI_API_KEY                       the reviewing model (default provider)
    REVIEW_EMAIL_LLM_PROVIDER / _MODEL   override the reviewer brain
                                         (defaults: google / gemini-3.1-pro-preview)
    REVIEW_EMAIL_LLM_FALLBACK            model used only if the primary id is
                                         retired (default gemini-2.5-pro)
    RESEND_API_KEY                       Resend API key (re_…)
    LIFECYCLE_EMAIL_FROM                 From address, e.g.
                                         "Toby Rowland <toby@alphamolt.ai>"
    LIFECYCLE_EMAIL_REPLY_TO             Optional Reply-To
"""

from __future__ import annotations

import argparse
import html
import json
import logging
import os
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from db import SupabaseDB
from lifecycle_emails import (
    SITE_URL,
    _mask,
    first_name_of,
    record_send,
    send_via_resend,
)
from llm_providers import LLMProviderError, call_llm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("weekly_review_emails")

ROOT = os.path.dirname(os.path.abspath(__file__))
RENDERER = os.path.join(ROOT, "web", "scripts", "review-pack.mjs")

WEEK_KEY_PREFIX = "weekly_review_"
OPT_OUT_COLUMN = "weekly_review_emails"

# The reviewing brain. Gemini 3.1 Pro at medium depth is the house reviewer's
# own setting (migration 087): deep enough to read a 30k-token pack properly,
# and the fallback is a real model rather than a silent no-op when Google
# retires the preview id (see llm_providers.call_llm).
DEFAULT_PROVIDER = "google"
DEFAULT_MODEL = "gemini-3.1-pro-preview"
DEFAULT_FALLBACK = "gemini-2.5-pro"
DEFAULT_THINKING = "medium"
MAX_REVIEW_TOKENS = 4096

# A pack is ~20-40k tokens; anything past this is a runaway, not a book.
MAX_PACK_CHARS = 400_000

REVIEW_FOOTER_TEXT = (
    'You\'re getting this weekly because you run a portfolio at alphamolt.ai. '
    'Reply "no more reviews" and I\'ll stop these.'
)
REVIEW_FOOTER_HTML = (
    '<p style="color:#999999;font-size:12px;">You\'re getting this weekly because '
    "you run a portfolio at alphamolt.ai. Reply &quot;no more reviews&quot; and "
    "I'll stop these.</p>"
)


# ---------------------------------------------------------------------------
# The prompt — what a weekly review has to do with the pack
# ---------------------------------------------------------------------------

REVIEW_SYSTEM = """\
You write the weekly review email that AlphaMolt sends to the human owner of a \
paper portfolio run by a team of AI agents. You are given the portfolio's review \
pack: its mandate, the agents and their briefs, the screen they pick from, the \
sell discipline, every position with its thesis and break signals, every trade, \
the closed positions, what the record cannot tell you, and a list of questions \
worth asking a reviewer. The pack also says how the book is run — read that \
before judging any single position.

Write the BODY of the email only: plain text, no markdown, no headings, no \
bullet symbols, no subject line, no greeting, no sign-off (those are added \
around your text). 250-450 words in short paragraphs.

What the review must do, in this order:
1. Open with the single most important thing about this book right now, in the \
first sentence.
2. Say whether the positions match the mandate. Name the tickers that do not \
fit and say why.
3. Name the weakest thesis on the evidence in the pack and what would have to be \
true for it to hold. Call out any break signal that is firing, that cannot be \
evaluated, or that was already true when it was written.
4. Say where this process is most likely to go wrong next: the screen's filters, \
the ranking weights, the per-name judgement, or the sell rules.
5. Close with one or two concrete changes the owner can make on their portfolio \
page: edit an agent's brief, change a screen filter or weight, adjust the sell \
discipline, or sell a name by hand.

Rules. Use only what is in the pack; where it cannot tell you something, say so \
rather than guess. Quote figures as they appear and remember the prices are \
closing marks, not live. Trades dated inside the week named below are this \
week's; refer to them as such. Do not restate the pack's "What has already been \
fixed" entries as findings. Do not praise for its own sake and do not pad. Be \
direct, specific and plain-spoken, like a sharp friend who has run money. Do not \
say that you are an AI or that you are reading a document. This is a paper \
portfolio: never give advice about real money.
"""


def week_key(now: datetime) -> str:
    """`weekly_review_2026-W38` — one send per user per ISO week."""
    year, week, _ = now.isocalendar()
    return f"{WEEK_KEY_PREFIX}{year}-W{week:02d}"


def review_user_prompt(pack_markdown: str, week_end: date) -> str:
    week_start = week_end - timedelta(days=6)
    return (
        f"Week under review: {week_start.isoformat()} to {week_end.isoformat()}.\n\n"
        "The review pack follows.\n\n---\n\n"
        f"{pack_markdown}"
    )


# ---------------------------------------------------------------------------
# Eligibility — pure
# ---------------------------------------------------------------------------

def plan_sends(
    profiles: list[dict],
    portfolios: list[dict],
    holdings_count: dict[str, int],
    sent: set[tuple[str, str]],
    key: str,
) -> list[tuple[dict, list[dict]]]:
    """Who gets an email this week, and which of their books it covers.

    A user is due when they have an email, have not opted out, have not
    already received this week's key, and own at least one PAPER portfolio
    holding a position. Live followers are excluded twice over: they hold no
    decisions of their own (their pack would be the paper twin's with the
    reasoning removed) and they are real money, which the email must never
    discuss.
    """
    by_owner: dict[str, list[dict]] = defaultdict(list)
    for p in portfolios:
        owner = p.get("owner_user_id")
        if not owner or (p.get("mode") or "paper") != "paper":
            continue
        if holdings_count.get(p["id"], 0) <= 0:
            continue
        by_owner[owner].append(p)

    plan: list[tuple[dict, list[dict]]] = []
    for prof in profiles:
        if not prof.get("email"):
            continue
        if prof.get(OPT_OUT_COLUMN) is False:
            continue
        if (prof["id"], key) in sent:
            continue
        books = by_owner.get(prof["id"])
        if not books:
            continue
        plan.append((prof, sorted(books, key=lambda b: b.get("created_at") or "")))
    return plan


# ---------------------------------------------------------------------------
# The week's numbers — pure
# ---------------------------------------------------------------------------

def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # NaN → None


def window_change_pct(
    snapshots: list[dict], value_key: str = "total_value_usd", index_key: str = "twr_index"
) -> float | None:
    """Return over a run of daily snapshots, oldest to newest.

    Uses the time-weighted index where both ends carry one (migration 090 —
    the only return that survives a deposit); otherwise the value ratio,
    which on a paper book is the same number.
    """
    rows = [r for r in snapshots if r.get("snapshot_date")]
    if len(rows) < 2:
        return None
    rows.sort(key=lambda r: r["snapshot_date"])
    first, last = rows[0], rows[-1]
    a, b = _num(first.get(index_key)), _num(last.get(index_key))
    if a is None or b is None:
        a, b = _num(first.get(value_key)), _num(last.get(value_key))
    if a is None or b is None or a <= 0:
        return None
    return (b / a - 1) * 100


def series_change_pct(series: dict[str, float], start: date, end: date) -> float | None:
    """Change in a {date_iso: close} series between the last closes on or
    before `start` and `end` — Friday's close still answers a Monday email."""
    def close_on_or_before(day: date) -> float | None:
        best: str | None = None
        for d in series:
            if d <= day.isoformat() and (best is None or d > best):
                best = d
        return series.get(best) if best else None

    a, b = close_on_or_before(start), close_on_or_before(end)
    if a is None or b is None or a <= 0:
        return None
    return (b / a - 1) * 100


def week_line(
    total_value: float | None,
    week_pct: float | None,
    spy_pct: float | None,
    since_inception_pct: float | None,
    holdings: int | None,
) -> str:
    """The one computed sentence above the model's text — figures the model
    is not asked to derive, so they cannot be misquoted."""
    parts: list[str] = []
    if total_value is not None:
        parts.append(f"Value ${total_value:,.0f}")
    if holdings is not None:
        parts.append(f"{holdings} position{'s' if holdings != 1 else ''}")
    if week_pct is not None:
        wk = f"{week_pct:+.1f}% on the week"
        if spy_pct is not None:
            wk += f" (S&P 500 {spy_pct:+.1f}%)"
        parts.append(wk)
    if since_inception_pct is not None:
        parts.append(f"{since_inception_pct:+.1f}% since inception")
    return ". ".join(parts) + "." if parts else ""


# ---------------------------------------------------------------------------
# Email rendering — pure
# ---------------------------------------------------------------------------

def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in text.replace("\r\n", "\n").split("\n\n") if p.strip()]


def email_subject(reviews: list[dict]) -> str:
    if len(reviews) == 1:
        return f"this week's review of {reviews[0]['name']}"
    return f"this week's review of your {len(reviews)} portfolios"


def email_text(first_name: str | None, reviews: list[dict], model_label: str) -> str:
    greeting = f"Hi {first_name} —" if first_name else "Hi —"
    blocks = [greeting, ""]
    for r in reviews:
        blocks.append(f"{r['name']} — {SITE_URL}/portfolios/{r['slug']}")
        if r.get("week_line"):
            blocks.append(r["week_line"])
        blocks.append("")
        blocks.append(r["review"].strip())
        blocks.append("")
    blocks.append(
        f"This review was written by {model_label} from the same review pack you can "
        'copy from your portfolio page ("Copy for AI review") — paste it into any model '
        "for a second opinion. Paper portfolio; nothing here is advice about real money."
    )
    blocks += ["", "— Toby", "", REVIEW_FOOTER_TEXT, ""]
    return "\n".join(blocks)


def email_html(first_name: str | None, reviews: list[dict], model_label: str) -> str:
    greeting = f"Hi {html.escape(first_name)} &mdash;" if first_name else "Hi &mdash;"
    out = [f"<p>{greeting}</p>"]
    for r in reviews:
        url = f"{SITE_URL}/portfolios/{r['slug']}"
        out.append(
            f'<p><strong><a href="{url}">{html.escape(r["name"])}</a></strong>'
            + (f"<br>{html.escape(r['week_line'])}" if r.get("week_line") else "")
            + "</p>"
        )
        for para in _paragraphs(r["review"]):
            out.append(f"<p>{html.escape(para)}</p>")
    out.append(
        f"<p>This review was written by {html.escape(model_label)} from the same review "
        "pack you can copy from your portfolio page (&quot;Copy for AI review&quot;) "
        "&mdash; paste it into any model for a second opinion. Paper portfolio; nothing "
        "here is advice about real money.</p>"
    )
    out += ["<p>&mdash; Toby</p>", REVIEW_FOOTER_HTML]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# Rendering the pack (node) and the review (LLM)
# ---------------------------------------------------------------------------

def render_packs(slugs: list[str], timeout: int = 300) -> dict[str, dict]:
    """{slug: {markdown, ...} | {error}} via web/scripts/review-pack.mjs."""
    if not slugs:
        return {}
    node = shutil.which("node")
    if node is None:
        return {s: {"error": "node not available"} for s in slugs}
    try:
        proc = subprocess.run(
            [node, "--experimental-strip-types", RENDERER, *slugs],
            capture_output=True, text=True, cwd=ROOT, timeout=timeout,
            env={**os.environ, "NODE_NO_WARNINGS": "1"},
        )
    except subprocess.TimeoutExpired:
        return {s: {"error": f"renderer timed out after {timeout}s"} for s in slugs}
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[-600:]
        logger.error("review-pack renderer failed (%s): %s", proc.returncode, detail)
        return {s: {"error": f"renderer exit {proc.returncode}"} for s in slugs}
    if proc.stderr.strip():
        logger.debug("renderer stderr: %s", proc.stderr.strip()[-600:])
    return parse_render_output(proc.stdout, slugs)


def parse_render_output(stdout: str, slugs: list[str]) -> dict[str, dict]:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return {s: {"error": f"unparseable renderer output: {exc}"} for s in slugs}
    return {s: data.get(s) or {"error": "missing from renderer output"} for s in slugs}


def reviewer_config() -> dict:
    return {
        "provider": os.environ.get("REVIEW_EMAIL_LLM_PROVIDER", DEFAULT_PROVIDER).strip(),
        "model": os.environ.get("REVIEW_EMAIL_LLM_MODEL", DEFAULT_MODEL).strip(),
        "fallback_model": os.environ.get("REVIEW_EMAIL_LLM_FALLBACK", DEFAULT_FALLBACK).strip()
        or None,
        "thinking_level": os.environ.get("REVIEW_EMAIL_THINKING_LEVEL", DEFAULT_THINKING).strip()
        or None,
    }


def write_review(pack_markdown: str, week_end: date, cfg: dict) -> tuple[str, str]:
    """(review text, model that wrote it). Raises LLMProviderError."""
    if len(pack_markdown) > MAX_PACK_CHARS:
        raise LLMProviderError(f"pack is {len(pack_markdown)} chars — refusing to send")
    resp = call_llm(
        provider=cfg["provider"], model=cfg["model"],
        system=REVIEW_SYSTEM, user=review_user_prompt(pack_markdown, week_end),
        max_tokens=MAX_REVIEW_TOKENS, temperature=0.7,
        thinking_level=cfg.get("thinking_level"), fallback_model=cfg.get("fallback_model"),
    )
    text = (resp.text or "").strip()
    if len(text) < 200:
        raise LLMProviderError(f"review too short ({len(text)} chars): {text[:120]!r}")
    return text, resp.model


# ---------------------------------------------------------------------------
# Data access (service role)
# ---------------------------------------------------------------------------

def fetch_profiles(db: SupabaseDB, only_email: str | None) -> list[dict]:
    """All profiles with the opt-out flag. Fails soft if migration 092 has not
    been applied yet: the flag is read as opted-in for everyone and a warning
    says so, rather than the whole run dying on a missing column."""
    base = "id, email, display_name, created_at"
    try:
        resp = db.client.table("profiles").select(f"{base}, {OPT_OUT_COLUMN}").execute()
    except Exception as exc:  # noqa: BLE001 — PostgREST 42703 on a pre-092 schema
        if OPT_OUT_COLUMN not in str(exc):
            raise
        logger.warning(
            "profiles.%s missing — migration 092 not applied; nobody can opt out yet",
            OPT_OUT_COLUMN,
        )
        resp = db.client.table("profiles").select(base).execute()
    out = []
    for p in resp.data or []:
        if not p.get("email"):
            continue
        if only_email and p["email"].strip().lower() != only_email.strip().lower():
            continue
        out.append(p)
    return out


def fetch_paper_portfolios(db: SupabaseDB) -> list[dict]:
    resp = (
        db.client.table("portfolios")
        .select("id, slug, display_name, owner_user_id, mode, created_at")
        .not_.is_("owner_user_id", "null")
        .eq("mode", "paper")
        .execute()
    )
    return resp.data or []


def fetch_holdings_count(db: SupabaseDB, portfolio_ids: list[str]) -> dict[str, int]:
    if not portfolio_ids:
        return {}
    resp = (
        db.client.table("portfolio_holdings")
        .select("portfolio_id")
        .in_("portfolio_id", portfolio_ids)
        .gt("quantity", 0)
        .execute()
    )
    return dict(Counter(r["portfolio_id"] for r in (resp.data or [])))


def fetch_sent_for_key(db: SupabaseDB, key: str) -> set[tuple[str, str]]:
    resp = (
        db.client.table("lifecycle_email_sends")
        .select("user_id, email_key")
        .eq("email_key", key)
        .execute()
    )
    return {(r["user_id"], r["email_key"]) for r in (resp.data or [])}


def fetch_week_snapshots(db: SupabaseDB, portfolio_id: str, week_end: date) -> list[dict]:
    resp = (
        db.client.table("agent_portfolio_history")
        .select("snapshot_date, total_value_usd, twr_index")
        .eq("portfolio_id", portfolio_id)
        .gte("snapshot_date", (week_end - timedelta(days=7)).isoformat())
        .lte("snapshot_date", week_end.isoformat())
        .order("snapshot_date")
        .execute()
    )
    return resp.data or []


def set_opt_out(db: SupabaseDB, email: str) -> bool:
    resp = (
        db.client.table("profiles")
        .update({OPT_OUT_COLUMN: False})
        .eq("email", email.strip().lower())
        .execute()
    )
    return bool(resp.data)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Plan, render and write the reviews to stdout; send nothing, "
                             "write nothing")
    parser.add_argument("--to", default=None, metavar="ADDR",
                        help="Redirect all sends to a test address; ledger NOT written")
    parser.add_argument("--user", default=None, metavar="EMAIL",
                        help="Only the profile with this email")
    parser.add_argument("--mark-only", action="store_true",
                        help="Write this week's ledger rows without emailing")
    parser.add_argument("--opt-out", default=None, metavar="EMAIL",
                        help="Set profiles.weekly_review_emails=false for this user and exit")
    parser.add_argument("--week-end", default=None, metavar="YYYY-MM-DD",
                        help="Treat this date as the end of the week under review "
                             "(default: yesterday)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Send to at most N users this run")
    args = parser.parse_args()

    db = SupabaseDB()

    if args.opt_out:
        ok = set_opt_out(db, args.opt_out)
        logger.info("Opt-out %s for %s", "recorded" if ok else "found no profile",
                    _mask(args.opt_out))
        return 0 if ok else 1

    now = datetime.now(timezone.utc)
    key = week_key(now)
    week_end = date.fromisoformat(args.week_end) if args.week_end else (now - timedelta(days=1)).date()

    profiles = fetch_profiles(db, args.user)
    portfolios = fetch_paper_portfolios(db)
    holdings = fetch_holdings_count(db, [p["id"] for p in portfolios])
    sent = fetch_sent_for_key(db, key)
    plan = plan_sends(profiles, portfolios, holdings, sent, key)
    if args.limit is not None:
        plan = plan[: args.limit]
    logger.info(
        "%s: %d user(s) due across %d profile(s), %d paper portfolio(s) with positions",
        key, len(plan), len(profiles), sum(1 for p in portfolios if holdings.get(p["id"], 0) > 0),
    )
    if not plan:
        return 0

    if args.mark_only:
        for prof, _ in plan:
            record_send(db, prof["id"], key, prof["email"])
            logger.info("Marked %s as sent for %s (no email)", key, _mask(prof["email"]))
        return 0

    cfg = reviewer_config()
    try:
        spy = db.get_benchmark_series("SPY.US")
    except Exception as exc:  # noqa: BLE001 — the benchmark line is a nicety
        logger.warning("SPY series unavailable: %s", exc)
        spy = {}
    spy_pct = series_change_pct(spy, week_end - timedelta(days=7), week_end)

    sent_n = skipped = errors = 0
    for prof, books in plan:
        recipient = args.to or prof["email"]
        packs = render_packs([b["slug"] for b in books])
        reviews: list[dict] = []
        model_used = cfg["model"]
        for b in books:
            pack = packs.get(b["slug"]) or {}
            if "error" in pack or not pack.get("markdown"):
                logger.error("Pack for %s failed: %s", b["slug"], pack.get("error", "empty"))
                continue
            try:
                snaps = fetch_week_snapshots(db, b["id"], week_end)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Snapshots for %s unavailable: %s", b["slug"], exc)
                snaps = []
            try:
                text, model_used = write_review(pack["markdown"], week_end, cfg)
            except LLMProviderError as exc:
                logger.error("Review for %s failed: %s", b["slug"], exc)
                continue
            reviews.append({
                "name": b.get("display_name") or b["slug"],
                "slug": b["slug"],
                "review": text,
                "week_line": week_line(
                    pack.get("totalValue"), window_change_pct(snaps), spy_pct,
                    pack.get("returnPct"), pack.get("holdings"),
                ),
            })
        if not reviews:
            # Nothing rendered → no ledger row, so the next run retries them.
            errors += 1
            continue

        subject = email_subject(reviews)
        name = first_name_of(prof)
        text = email_text(name, reviews, model_used)
        body_html = email_html(name, reviews, model_used)
        if args.dry_run:
            logger.info("[dry-run] would send %r to %s (%d review(s))",
                        subject, _mask(recipient), len(reviews))
            sys.stdout.write(f"\n===== {_mask(recipient)} · {subject} =====\n{text}\n")
            skipped += 1
            continue
        if send_via_resend(recipient, subject, text, body_html):
            if not args.to:  # a test redirect must not burn the user's week
                record_send(db, prof["id"], key, prof["email"])
            sent_n += 1
        else:
            errors += 1

    logger.info("Done: %d sent, %d skipped, %d errors", sent_n, skipped, errors)
    return 1 if errors and not sent_n and not skipped else 0


if __name__ == "__main__":
    raise SystemExit(main())
