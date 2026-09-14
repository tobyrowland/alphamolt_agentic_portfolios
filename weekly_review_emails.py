#!/usr/bin/env python3
"""
weekly_review_emails.py — the weekly portfolio review, emailed to each owner.

Every week, each human who is running a paper portfolio gets one email: a
30-day chart of the book against the S&P 500, the week's trades, and a
model's short critique — a headline, two paragraphs and a numbered list of
changes to make — written from the SAME review pack the portfolio page's
"Copy for AI review" button produces. The pack was designed to be handed to
a different model and asked "what do you think?"; this is that act, done
for the owner, on a schedule.

Why the pack and not a fresh summary: the pack already enforces the honesty
rules a review needs — closed positions and their losses included, marks
stated as closing prices, the sell discipline resolved against its defaults,
the already-fixed defects declared so the reviewer does not re-derive them —
and it ends with the questions worth asking. Rendering it here
(web/scripts/review-pack.mjs, a plain-node wrapper over
web/lib/portfolio-export.ts) means the email and the button can never
describe one book two ways. The chart and the trade table are NOT the
model's: the chart is drawn from `agent_portfolio_history` + `benchmark_
prices`, the trades are the pack's own tape rows, and the numbers in the
header are computed here — figures the model is never asked to derive, so
it cannot misquote them.

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
    python weekly_review_emails.py --dry-run         # plan + render, send nothing
    python weekly_review_emails.py --dry-run --preview-dir out/
                                                     # ...and write each email as
                                                     # .html/.txt to look at
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
import base64
import html
import io
import json
import logging
import os
import re
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
from llm_providers import LLMProviderError, call_llm, parse_json_response

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("weekly_review_emails")

ROOT = os.path.dirname(os.path.abspath(__file__))
RENDERER = os.path.join(ROOT, "web", "scripts", "review-pack.mjs")

WEEK_KEY_PREFIX = "weekly_review_"
OPT_OUT_COLUMN = "weekly_review_emails"
CHART_DAYS = 30

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

# The framing, in Toby's voice — what this is and who wrote the opinion. One
# short paragraph: the chart and the trades speak for themselves below it.
INTRO_TEXT = (
    "Toby here with your weekly review. Every Monday a model that isn't one of "
    "your agents reads your whole book — the brief, the screen, every position "
    "and its thesis, every trade — and says what it thinks. Here's this week's."
)
INTRO_HTML = (
    "<p>Toby here with your weekly review. Every Monday a model that isn't one of "
    "your agents reads your whole book &mdash; the brief, the screen, every "
    "position and its thesis, every trade &mdash; and says what it thinks. "
    "Here's this week's.</p>"
)


# ---------------------------------------------------------------------------
# The prompt — what a weekly review has to do with the pack
# ---------------------------------------------------------------------------

REVIEW_SYSTEM = """\
You write the weekly review that AlphaMolt emails to the human owner of a paper \
portfolio run by a team of AI agents. You are given the portfolio's review pack: \
its mandate, the agents and their briefs, the screen they pick from, the sell \
discipline, every position with its thesis and break signals, every trade, the \
closed positions, what the record cannot tell you, and a list of questions worth \
asking a reviewer. The pack also says how the book is run — read that before \
judging any single position.

The owner reads this on a phone. The email already shows them a chart, the \
week's numbers and the week's trades, so do not restate those. Be short.

Answer with ONE JSON object and nothing else:
{
  "headline": "one sentence — the single most important thing about this book right now",
  "paragraphs": ["...", "..."],
  "recommendations": [{"action": "...", "why": "..."}]
}

"paragraphs": exactly two, each under 60 words, plain text, no markdown. The \
first says whether the positions match the mandate (name the tickers that do \
not fit) and names the weakest thesis on the evidence, including any break \
signal that is firing, cannot be evaluated, or was already true when written. \
The second says where this process is most likely to go wrong next: the \
screen's filters, the ranking weights, the per-name judgement, or the sell rules.

"recommendations": two to four. Each "action" is an imperative under 15 words \
the owner can do on their portfolio page — edit an agent's brief, add or change \
a screen filter or weight, adjust the sell discipline, or sell a name by hand. \
Each "why" is one sentence. Most important first.

Rules. Use only what is in the pack; where it cannot tell you something, say so \
rather than guess. Quote figures as they appear and remember the prices are \
closing marks, not live. Trades dated inside the week named below are this \
week's. Do not restate the pack's "What has already been fixed" entries as \
findings. No praise for its own sake, no padding. Direct, specific, plain-spoken, \
like a sharp friend who has run money. Do not say that you are an AI or that you \
are reading a document. This is a paper portfolio: never give advice about real \
money.
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
# The week's numbers, the chart series, the trades — pure
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


def rebased_points(
    snapshots: list[dict], value_key: str = "total_value_usd", index_key: str = "twr_index"
) -> list[tuple[str, float]]:
    """[(date, level)] with the first point at 100 — the chart's portfolio line.

    Reads the time-weighted index when EVERY row carries one (so a deposit
    is not drawn as a jump), otherwise the raw value: the index backfill can
    lag, and on a paper book the two are the same curve.
    """
    rows = sorted((r for r in snapshots if r.get("snapshot_date")),
                  key=lambda r: r["snapshot_date"])
    key = index_key if rows and all(_num(r.get(index_key)) is not None for r in rows) else value_key
    pts = [(r["snapshot_date"], _num(r.get(key))) for r in rows]
    pts = [(d, v) for d, v in pts if v is not None and v > 0]
    if not pts:
        return []
    base = pts[0][1]
    return [(d, v / base * 100) for d, v in pts]


def series_points(series: dict[str, float], start: date, end: date) -> list[tuple[str, float]]:
    """[(date, level)] from a {date_iso: close} series inside [start, end],
    rebased to 100 at the first point — the chart's benchmark line."""
    pts = sorted((d, c) for d, c in series.items()
                 if start.isoformat() <= d <= end.isoformat() and c and c > 0)
    if not pts:
        return []
    base = pts[0][1]
    return [(d, c / base * 100) for d, c in pts]


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


def week_trades(trades: list[dict], start: date, end: date) -> list[dict]:
    """The pack's tape rows executed inside [start, end], oldest first."""
    lo, hi = start.isoformat(), end.isoformat()
    rows = [t for t in trades if lo <= str(t.get("executedAt") or "")[:10] <= hi]
    return sorted(rows, key=lambda t: str(t.get("executedAt") or ""))


def stats_line(stats: dict) -> str:
    """The computed figures under the portfolio name, as one line."""
    parts: list[str] = []
    if stats.get("total_value") is not None:
        parts.append(f"${stats['total_value']:,.0f}")
    if stats.get("week_pct") is not None:
        wk = f"{stats['week_pct']:+.1f}% this week"
        if stats.get("spy_pct") is not None:
            wk += f" (S&P 500 {stats['spy_pct']:+.1f}%)"
        parts.append(wk)
    if stats.get("since_pct") is not None:
        parts.append(f"{stats['since_pct']:+.1f}% since inception")
    if stats.get("holdings") is not None:
        n = stats["holdings"]
        parts.append(f"{n} position{'s' if n != 1 else ''}")
    return " · ".join(parts)


# ---------------------------------------------------------------------------
# The chart — a PNG the email carries inline
# ---------------------------------------------------------------------------

def render_chart_png(
    portfolio: list[tuple[str, float]],
    benchmark: list[tuple[str, float]],
    name: str,
) -> bytes | None:
    """30-day line of the book against the S&P 500, both rebased to 100.

    Returns PNG bytes, or None when there is nothing worth drawing (fewer
    than two portfolio points) or matplotlib is unavailable — the email
    then simply has no chart rather than no email.
    """
    if len(portfolio) < 2:
        return None
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.dates as mdates
        import matplotlib.pyplot as plt
    except Exception as exc:  # noqa: BLE001 — the chart is a nicety
        logger.warning("chart skipped: matplotlib unavailable (%s)", exc)
        return None

    def to_dt(d: str) -> datetime:
        return datetime.fromisoformat(d)

    fig, ax = plt.subplots(figsize=(6.4, 2.4), dpi=160)
    ax.plot([to_dt(d) for d, _ in portfolio], [v for _, v in portfolio],
            color="#111111", linewidth=1.8, label=name)
    if len(benchmark) >= 2:
        ax.plot([to_dt(d) for d, _ in benchmark], [v for _, v in benchmark],
                color="#8a8a8a", linewidth=1.2, linestyle="--", label="S&P 500")
    ax.axhline(100, color="#dddddd", linewidth=0.8)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color("#cccccc")
    ax.tick_params(colors="#666666", labelsize=8)
    ax.xaxis.set_major_locator(mdates.WeekdayLocator(byweekday=mdates.MO))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
    ax.yaxis.set_major_formatter(lambda v, _: f"{v:.0f}")
    ax.grid(axis="y", color="#eeeeee", linewidth=0.8)
    ax.set_title(f"Last {CHART_DAYS} days, rebased to 100", fontsize=9,
                 color="#666666", loc="left")
    ax.legend(frameon=False, fontsize=8, loc="best")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Email rendering — pure
# ---------------------------------------------------------------------------

def email_subject(reviews: list[dict]) -> str:
    if len(reviews) == 1:
        return f"this week's review of {reviews[0]['name']}"
    return f"this week's review of your {len(reviews)} portfolios"


def _money(n: float | None, signed: bool = False) -> str:
    if n is None:
        return "—"
    sign = "-" if n < 0 else ("+" if signed and n > 0 else "")
    return f"{sign}${abs(n):,.0f}"


def _trade_line(t: dict) -> str:
    side = str(t.get("side", "")).upper()
    qty = _num(t.get("quantity")) or 0
    px = _num(t.get("price")) or 0
    who = t.get("agent") or "—"
    line = (f"{str(t.get('executedAt', ''))[:10]}  {side:<4} "
            f"{str(t.get('ticker', '')):<6} {qty:,.0f} @ ${px:,.2f}")
    if side == "SELL":
        line += f"  realised {_money(_num(t.get('realisedUsd')), signed=True)}"
    return f"{line}  ({who})"


def email_text(first_name: str | None, reviews: list[dict], model_label: str) -> str:
    greeting = f"Hi {first_name} —" if first_name else "Hi —"
    out = [greeting, "", INTRO_TEXT, ""]
    for r in reviews:
        rv = r["review"]
        out.append(f"{r['name']} — {SITE_URL}/portfolios/{r['slug']}")
        line = stats_line(r.get("stats") or {})
        if line:
            out.append(line)
        out += ["", "This week's trades"]
        trades = r.get("trades") or []
        out += [_trade_line(t) for t in trades] if trades else ["None."]
        out += ["", "The review", rv["headline"], ""]
        for para in rv["paragraphs"]:
            out += [para, ""]
        out.append("What I'd change")
        for i, rec in enumerate(rv["recommendations"], 1):
            out.append(f"{i}. {rec['action']} — {rec['why']}")
        out.append("")
    out.append(
        f"The reviewer was {model_label}, reading the same pack you get from "
        '"Copy for AI review" on your portfolio page — paste it into any model for a '
        "second opinion. Paper portfolio; nothing here is advice about real money."
    )
    out += ["", "— Toby", "", REVIEW_FOOTER_TEXT, ""]
    return "\n".join(out)


_H = html.escape
_MUTED = 'style="color:#666666;font-size:14px;"'
_LABEL = ('style="color:#999999;font-size:11px;letter-spacing:0.08em;'
          'text-transform:uppercase;margin:22px 0 6px;"')
_TD = 'style="padding:4px 8px 4px 0;border-bottom:1px solid #eeeeee;font-size:13px;"'


def _trades_table_html(trades: list[dict]) -> str:
    if not trades:
        return f"<p {_MUTED}>None.</p>"
    rows = []
    for t in trades:
        side = str(t.get("side", "")).upper()
        qty = _num(t.get("quantity")) or 0
        px = _num(t.get("price")) or 0
        colour = "#1a7f37" if side == "BUY" else "#b42318"
        pnl = ""
        if side == "SELL":
            realised = _num(t.get("realisedUsd"))
            pnl_colour = "#b42318" if (realised or 0) < 0 else "#1a7f37"
            pnl = f'<span style="color:{pnl_colour};">{_H(_money(realised, signed=True))}</span>'
        rows.append(
            "<tr>"
            f"<td {_TD}>{_H(str(t.get('executedAt', ''))[:10])}</td>"
            f'<td {_TD}><span style="color:{colour};font-weight:600;">{_H(side)}</span> '
            f"<strong>{_H(str(t.get('ticker', '')))}</strong></td>"
            f"<td {_TD}>{qty:,.0f} @ ${px:,.2f}</td>"
            f'<td {_TD} align="right">{pnl}</td>'
            f'<td {_TD}><span style="color:#666666;">{_H(t.get("agent") or "")}</span></td>'
            "</tr>"
        )
    return ('<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;'
            'width:100%;">' + "".join(rows) + "</table>")


def email_html(
    first_name: str | None, reviews: list[dict], model_label: str,
    inline_charts: bool = False,
) -> str:
    """The HTML body. Charts are referenced as `cid:` inline attachments; with
    `inline_charts` they are embedded as data URIs instead (for a preview
    file — mail clients block data URIs, Resend carries the cid)."""
    greeting = f"Hi {_H(first_name)} &mdash;" if first_name else "Hi &mdash;"
    out = ['<div style="max-width:600px;font-family:-apple-system,Segoe UI,Helvetica,Arial,'
           'sans-serif;font-size:15px;line-height:1.5;color:#111111;">',
           f"<p>{greeting}</p>", INTRO_HTML]
    for r in reviews:
        rv = r["review"]
        url = f"{SITE_URL}/portfolios/{r['slug']}"
        out.append(
            f'<p style="margin:18px 0 2px;font-size:18px;"><strong>'
            f'<a href="{url}" style="color:#111111;">{_H(r["name"])}</a></strong></p>'
        )
        line = stats_line(r.get("stats") or {})
        if line:
            out.append(f'<p {_MUTED.replace("font-size", "margin:0 0 8px;font-size")}>'
                       f"{_H(line)}</p>")
        chart = r.get("chart")
        if chart and chart.get("png"):
            src = (f"data:image/png;base64,{base64.b64encode(chart['png']).decode()}"
                   if inline_charts else f"cid:{chart['cid']}")
            out.append(f'<img src="{src}" alt="{_H(r["name"])} — last {CHART_DAYS} days vs the '
                       f'S&amp;P 500" width="600" style="display:block;width:100%;max-width:600px;'
                       f'height:auto;margin:6px 0 4px;">')
        out.append(f"<p {_LABEL}>This week's trades</p>")
        out.append(_trades_table_html(r.get("trades") or []))
        out.append(f"<p {_LABEL}>The review</p>")
        out.append(f'<p style="margin:0 0 10px;"><strong>{_H(rv["headline"])}</strong></p>')
        for para in rv["paragraphs"]:
            out.append(f"<p>{_H(para)}</p>")
        out.append(f"<p {_LABEL}>What I'd change</p>")
        out.append('<ol style="padding-left:20px;margin:0;">')
        for rec in rv["recommendations"]:
            out.append(f'<li style="margin-bottom:8px;"><strong>{_H(rec["action"])}</strong>'
                       f' <span {_MUTED}>{_H(rec["why"])}</span></li>')
        out.append("</ol>")
    out.append(
        f'<p style="margin-top:26px;color:#666666;font-size:13px;">The reviewer was '
        f"{_H(model_label)}, reading the same pack you get from &quot;Copy for AI review&quot; "
        "on your portfolio page &mdash; paste it into any model for a second opinion. Paper "
        "portfolio; nothing here is advice about real money.</p>"
    )
    out += ["<p>&mdash; Toby</p>", REVIEW_FOOTER_HTML, "</div>"]
    return "\n".join(out) + "\n"


def chart_attachment(review: dict) -> dict | None:
    """Resend attachment object for a review's chart, or None."""
    chart = review.get("chart")
    if not chart or not chart.get("png"):
        return None
    return {
        "filename": f"{review['slug']}-{CHART_DAYS}d.png",
        "content": base64.b64encode(chart["png"]).decode(),
        "content_type": "image/png",
        "content_id": chart["cid"],
    }


def chart_cid(slug: str) -> str:
    return "chart-" + re.sub(r"[^a-z0-9-]", "-", slug.lower())


# ---------------------------------------------------------------------------
# Rendering the pack (node) and the review (LLM)
# ---------------------------------------------------------------------------

def render_packs(slugs: list[str], timeout: int = 300) -> dict[str, dict]:
    """{slug: {markdown, trades, ...} | {error}} via web/scripts/review-pack.mjs."""
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


def parse_review(text: str) -> dict:
    """The model's JSON, checked for shape: a headline, the paragraphs asked
    for (1-3 tolerated), 2-4 recommendations each with action + why.
    Anything else is an error, not an email."""
    data = parse_json_response(text)
    headline = str(data.get("headline") or "").strip()
    paragraphs = [str(p).strip() for p in (data.get("paragraphs") or []) if str(p).strip()]
    recs = []
    for r in data.get("recommendations") or []:
        if not isinstance(r, dict):
            continue
        action = str(r.get("action") or "").strip().rstrip(".")
        why = str(r.get("why") or "").strip()
        if action and why:
            recs.append({"action": action, "why": why})
    if not headline or not 1 <= len(paragraphs) <= 3 or not 2 <= len(recs) <= 4:
        raise LLMProviderError(
            f"review has the wrong shape: headline={bool(headline)} "
            f"paragraphs={len(paragraphs)} recommendations={len(recs)}"
        )
    return {"headline": headline, "paragraphs": paragraphs, "recommendations": recs}


def write_review(pack_markdown: str, week_end: date, cfg: dict) -> tuple[dict, str]:
    """(review dict, model that wrote it). Raises LLMProviderError."""
    if len(pack_markdown) > MAX_PACK_CHARS:
        raise LLMProviderError(f"pack is {len(pack_markdown)} chars — refusing to send")
    resp = call_llm(
        provider=cfg["provider"], model=cfg["model"],
        system=REVIEW_SYSTEM, user=review_user_prompt(pack_markdown, week_end),
        max_tokens=MAX_REVIEW_TOKENS, temperature=0.7,
        thinking_level=cfg.get("thinking_level"), fallback_model=cfg.get("fallback_model"),
    )
    return parse_review(resp.text), resp.model


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


def fetch_snapshots(db: SupabaseDB, portfolio_id: str, start: date, end: date) -> list[dict]:
    resp = (
        db.client.table("agent_portfolio_history")
        .select("snapshot_date, total_value_usd, twr_index")
        .eq("portfolio_id", portfolio_id)
        .gte("snapshot_date", start.isoformat())
        .lte("snapshot_date", end.isoformat())
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
# Assembling one book's review
# ---------------------------------------------------------------------------

def build_review(
    book: dict, pack: dict, snapshots: list[dict], spy: dict[str, float],
    week_end: date, cfg: dict,
) -> tuple[dict, str]:
    """Everything the email shows for one portfolio. Raises LLMProviderError."""
    week_start = week_end - timedelta(days=6)
    review, model = write_review(pack["markdown"], week_end, cfg)
    week_snaps = [s for s in snapshots
                  if s.get("snapshot_date", "") >= (week_end - timedelta(days=7)).isoformat()]
    stats = {
        "total_value": _num(pack.get("totalValue")),
        "week_pct": window_change_pct(week_snaps),
        "spy_pct": series_change_pct(spy, week_end - timedelta(days=7), week_end),
        "since_pct": _num(pack.get("returnPct")),
        "holdings": pack.get("holdings"),
    }
    name = book.get("display_name") or book["slug"]
    png = render_chart_png(
        rebased_points(snapshots),
        series_points(spy, week_end - timedelta(days=CHART_DAYS), week_end),
        name,
    )
    return {
        "name": name,
        "slug": book["slug"],
        "stats": stats,
        "chart": {"cid": chart_cid(book["slug"]), "png": png} if png else None,
        "trades": week_trades(pack.get("trades") or [], week_start, week_end),
        "review": review,
    }, model


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Plan and render every due review; send nothing, write nothing")
    parser.add_argument("--preview-dir", default=None, metavar="DIR",
                        help="Also write each email as <slug>.html / .txt here")
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
    week_end = (date.fromisoformat(args.week_end) if args.week_end
                else (now - timedelta(days=1)).date())

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
    except Exception as exc:  # noqa: BLE001 — the benchmark is a nicety
        logger.warning("SPY series unavailable: %s", exc)
        spy = {}
    if args.preview_dir:
        os.makedirs(args.preview_dir, exist_ok=True)

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
                snaps = fetch_snapshots(db, b["id"], week_end - timedelta(days=CHART_DAYS), week_end)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Snapshots for %s unavailable: %s", b["slug"], exc)
                snaps = []
            try:
                review, model_used = build_review(b, pack, snaps, spy, week_end, cfg)
            except LLMProviderError as exc:
                logger.error("Review for %s failed: %s", b["slug"], exc)
                continue
            reviews.append(review)
        if not reviews:
            # Nothing rendered → no ledger row, so the next run retries them.
            errors += 1
            continue

        subject = email_subject(reviews)
        name = first_name_of(prof)
        text = email_text(name, reviews, model_used)
        body_html = email_html(name, reviews, model_used)
        attachments = [a for a in (chart_attachment(r) for r in reviews) if a]
        if args.preview_dir:
            stem = os.path.join(args.preview_dir, reviews[0]["slug"])
            with open(f"{stem}.html", "w", encoding="utf-8") as fh:
                fh.write(email_html(name, reviews, model_used, inline_charts=True))
            with open(f"{stem}.txt", "w", encoding="utf-8") as fh:
                fh.write(f"Subject: {subject}\n\n{text}")
            logger.info("Preview written: %s.html", stem)
        if args.dry_run:
            logger.info("[dry-run] would send %r to %s (%d review(s), %d chart(s))",
                        subject, _mask(recipient), len(reviews), len(attachments))
            if not args.preview_dir:
                sys.stdout.write(f"\n===== {_mask(recipient)} · {subject} =====\n{text}\n")
            skipped += 1
            continue
        if send_via_resend(recipient, subject, text, body_html, attachments=attachments):
            if not args.to:  # a test redirect must not burn the user's week
                record_send(db, prof["id"], key, prof["email"])
            sent_n += 1
        else:
            errors += 1

    logger.info("Done: %d sent, %d skipped, %d errors", sent_n, skipped, errors)
    return 1 if errors and not sent_n and not skipped else 0


if __name__ == "__main__":
    raise SystemExit(main())
