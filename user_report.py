#!/usr/bin/env python3
"""
user_report.py — operator digest of signed-up humans and their portfolios.

A read-only "what have they done" report over every human account
(`profiles`) and the portfolios they own (`portfolios.owner_user_id`).
For each user it shows how far they've progressed through the funnel
(signed up → created a portfolio → hired agents → traded → went public),
the team of agents they assembled, current cash/holdings, recent trades,
and the latest mark-to-market return.

Reads with the service-role key, so it sees private and live portfolios
too — this is an OPERATOR tool, not a public surface. Output goes to the
console by default; --slack / --email deliver the same digest elsewhere
when the matching env vars are set.

Two report shapes:
  * default       — a full per-user state digest (snapshot of everyone).
  * --story       — an LLM-written narrative of the last --window-hours (24h
                    by default) from an onboarding POV: who joined, who
                    progressed, who's stuck, notable trades + performance.
                    Needs GEMINI_API_KEY; falls back to a plain summary.

Usage:
    python user_report.py                      # full digest to console
    python user_report.py --story --email      # email the 24h onboarding story
    python user_report.py --story --window-hours 48
    python user_report.py --slack              # also POST to SLACK_WEBHOOK_URL
    python user_report.py --email tobyro@gmail.com   # override recipient

Delivery env vars:
    SLACK_WEBHOOK_URL                Slack incoming-webhook URL (--slack)
    --email prefers Resend, then SMTP:
    RESEND_API_KEY                   Resend API key (re_…); when set, --email
                                     sends via the Resend HTTP API
    REPORT_EMAIL_FROM / _TO          From / To addresses (From must be a
                                     Resend-verified sender)
    SMTP_HOST / SMTP_PORT            SMTP fallback (port default 587, STARTTLS)
    SMTP_USER / SMTP_PASSWORD        SMTP auth (Gmail: an App Password)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import smtplib
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from dotenv import load_dotenv

from db import SupabaseDB

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("user_report")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def safe_float(val) -> float | None:
    """Null-safe float coercion (mirrors SupabaseDB.safe_float / em-dash)."""
    if val is None or val == "—":
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # drop NaN

def _money(v) -> str:
    n = safe_float(v)
    return "—" if n is None else f"${n:,.0f}"


def _pct(v) -> str:
    n = safe_float(v)
    return "—" if n is None else f"{n:+.1f}%"


def _days_since(iso: str | None) -> int | None:
    d = _parse_dt(iso)
    if d is None:
        return None
    return (datetime.now(timezone.utc) - d).days


def _parse_dt(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
    except (ValueError, TypeError):
        return None


def _within(iso: str | None, cutoff: datetime) -> bool:
    d = _parse_dt(iso)
    return d is not None and d >= cutoff


def _ago(iso: str | None) -> str:
    days = _days_since(iso)
    if days is None:
        return "—"
    if days <= 0:
        return "today"
    if days == 1:
        return "1d ago"
    return f"{days}d ago"


def _date(iso: str | None) -> str:
    if not iso:
        return "—"
    return iso[:10]


# ---------------------------------------------------------------------------
# Data access (service-role; sees private + live portfolios)
# ---------------------------------------------------------------------------

class ReportData:
    def __init__(self, db: SupabaseDB):
        self.c = db.client

    def profiles(self) -> list[dict]:
        resp = (
            self.c.table("profiles")
            .select("id, email, display_name, created_at")
            .order("created_at", desc=False)
            .execute()
        )
        return resp.data or []

    def portfolios_for(self, user_id: str) -> list[dict]:
        resp = (
            self.c.table("portfolios")
            .select(
                "id, slug, display_name, description, is_public, mode, "
                "screen_config, created_at"
            )
            .eq("owner_user_id", user_id)
            .order("created_at", desc=False)
            .execute()
        )
        return resp.data or []

    def account(self, portfolio_id: str) -> dict | None:
        resp = (
            self.c.table("portfolio_accounts")
            .select("cash_usd, starting_cash, inception_date")
            .eq("portfolio_id", portfolio_id)
            .limit(1)
            .execute()
        )
        return (resp.data or [None])[0]

    def holdings(self, portfolio_id: str) -> list[dict]:
        resp = (
            self.c.table("portfolio_holdings")
            .select("ticker, quantity, avg_cost_usd, first_bought_at")
            .eq("portfolio_id", portfolio_id)
            .execute()
        )
        return resp.data or []

    def team(self, portfolio_id: str) -> list[dict]:
        # Join agents for the function-first identity. Select defensively —
        # only columns guaranteed on portfolio_agents across migrations.
        resp = (
            self.c.table("portfolio_agents")
            .select(
                "agent_id, joined_at, "
                "agents(handle, display_name, action, powered_by, strategy)"
            )
            .eq("portfolio_id", portfolio_id)
            .order("joined_at", desc=False)
            .execute()
        )
        return resp.data or []

    def trades(self, portfolio_id: str, limit: int = 600) -> list[dict]:
        resp = (
            self.c.table("agent_trades")
            .select("side, ticker, quantity, price_usd, executed_at")
            .eq("portfolio_id", portfolio_id)
            .order("executed_at", desc=True)
            .limit(limit)
            .execute()
        )
        return resp.data or []

    def latest_snapshot(self, portfolio_id: str) -> dict | None:
        return (self.recent_snapshots(portfolio_id, 1) or [None])[0]

    def recent_snapshots(self, portfolio_id: str, n: int = 2) -> list[dict]:
        # Newest first; [0] is today's mark, [1] the prior trading day's —
        # their delta is the ~24h ("on the day") move.
        resp = (
            self.c.table("agent_portfolio_history")
            .select("snapshot_date, total_value_usd, pnl_pct, num_positions")
            .eq("portfolio_id", portfolio_id)
            .order("snapshot_date", desc=True)
            .limit(n)
            .execute()
        )
        return resp.data or []

    def watchlist_count(self, portfolio_id: str) -> int:
        resp = (
            self.c.table("portfolio_watchlist")
            .select("ticker", count="exact", head=True)
            .eq("portfolio_id", portfolio_id)
            .execute()
        )
        return resp.count or 0

    def prices(self, tickers: list[str]) -> dict[str, float | None]:
        out: dict[str, float | None] = {}
        if not tickers:
            return out
        resp = (
            self.c.table("companies")
            .select("ticker, price")
            .in_("ticker", list({t for t in tickers if t}))
            .execute()
        )
        for r in resp.data or []:
            out[r["ticker"]] = safe_float(r.get("price"))
        return out


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------

def _stage(has_portfolio: bool, team_n: int, traded: bool, public: bool) -> str:
    """Furthest funnel step reached, as a short label."""
    if public:
        return "PUBLIC"
    if traded:
        return "TRADING"
    if team_n > 0:
        return "TEAM HIRED"
    if has_portfolio:
        return "PORTFOLIO CREATED"
    return "SIGNED UP"


def build_report(data: ReportData, since_days: int | None) -> tuple[str, dict]:
    profiles = data.profiles()
    lines: list[str] = []
    counts = {"users": 0, "with_portfolio": 0, "trading": 0, "public": 0}

    header = (
        f"AlphaMolt user report · {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}"
    )
    lines.append(header)
    lines.append("=" * len(header))

    shown = 0
    for p in profiles:
        signup_days = _days_since(p.get("created_at"))
        if since_days is not None and (signup_days is None or signup_days > since_days):
            continue
        shown += 1
        counts["users"] += 1

        who = p.get("display_name") or p.get("email") or p.get("id")
        lines.append("")
        lines.append(
            f"● {who}  <{p.get('email') or 'no-email'}>"
            f"   signed up {_ago(p.get('created_at'))} ({_date(p.get('created_at'))})"
        )

        portfolios = data.portfolios_for(p["id"])
        if not portfolios:
            lines.append("    └ stage: SIGNED UP — no portfolio created yet.")
            continue
        counts["with_portfolio"] += 1

        for pf in portfolios:
            _render_portfolio(data, pf, lines, counts)

    if shown == 0:
        lines.append("")
        lines.append("No users match the filter.")

    summary = (
        f"\n{counts['users']} user(s) · {counts['with_portfolio']} with a portfolio · "
        f"{counts['trading']} trading · {counts['public']} public."
    )
    lines.append(summary)
    return "\n".join(lines), counts


def _render_portfolio(data: ReportData, pf: dict, lines: list[str], counts: dict) -> None:
    pid = pf["id"]
    account = data.account(pid)
    holdings = data.holdings(pid)
    team = data.team(pid)
    trades = data.trades(pid)
    snap = data.latest_snapshot(pid)
    wl = data.watchlist_count(pid)

    traded = bool(trades) or bool(holdings)
    public = bool(pf.get("is_public"))
    if traded:
        counts["trading"] += 1
    if public:
        counts["public"] += 1

    stage = _stage(True, len(team), traded, public)
    mode = pf.get("mode") or "paper"
    visibility = "PUBLIC" if public else "private"
    tags = [stage, mode.upper()]
    if visibility not in tags:  # stage may already be PUBLIC — don't repeat it
        tags.append(visibility)

    lines.append(
        f"    └ Portfolio “{pf.get('display_name') or pf.get('slug')}”  [{' · '.join(tags)}]"
        f"   created {_date(pf.get('created_at'))}"
    )

    mandate = (pf.get("description") or "").strip()
    if mandate:
        snippet = mandate if len(mandate) <= 160 else mandate[:159] + "…"
        lines.append(f"        mandate: {snippet}")
    else:
        lines.append("        mandate: — (none written)")

    # Money / performance
    if snap:
        lines.append(
            f"        value: {_money(snap.get('total_value_usd'))} "
            f"({_pct(snap.get('pnl_pct'))} · {snap.get('num_positions', 0)} positions) "
            f"as of {_date(snap.get('snapshot_date'))}"
        )
    if account:
        lines.append(
            f"        cash: {_money(account.get('cash_usd'))} of "
            f"{_money(account.get('starting_cash'))} starting "
            f"· inception {_date(account.get('inception_date'))}"
        )

    # Team
    if team:
        names = []
        for m in team:
            a = m.get("agents") or {}
            label = a.get("display_name") or a.get("handle") or "?"
            action = a.get("action")
            names.append(f"{label}" + (f" [{action}]" if action else ""))
        lines.append(f"        team ({len(team)}): {', '.join(names)}")
    else:
        lines.append("        team: — (no agents hired yet)")

    # Holdings
    if holdings:
        prices = data.prices([h["ticker"] for h in holdings])
        rows = []
        for h in sorted(holdings, key=lambda x: x.get("ticker") or ""):
            qty = safe_float(h.get("quantity")) or 0
            cost = safe_float(h.get("avg_cost_usd"))
            px = prices.get(h["ticker"])
            pnl = ""
            if cost and px:
                pnl = f" ({(px - cost) / cost * 100:+.0f}%)"
            rows.append(f"{h['ticker']} {qty:g}@{_money(cost)}{pnl}")
        lines.append(f"        holdings ({len(holdings)}): {', '.join(rows)}")
    else:
        lines.append("        holdings: — (none)")

    # Activity
    if trades:
        last = trades[0]
        lines.append(
            f"        trades: {len(trades)} total · last {last.get('side')} "
            f"{last.get('ticker')} {_ago(last.get('executed_at'))}"
        )
    else:
        lines.append("        trades: — (none yet)")

    # Screener + watchlist
    extras = []
    extras.append("screener: configured" if pf.get("screen_config") else "screener: default")
    extras.append(f"watchlist: {wl}")
    lines.append(f"        {' · '.join(extras)}")


# ---------------------------------------------------------------------------
# 24-hour activity digest → LLM onboarding story
# ---------------------------------------------------------------------------

# Emails that are the team's own / obvious tests — flagged so the story
# doesn't count them as real traction.
TEST_EMAIL_HINTS = ("@alphamolt.ai", "@cranq.")


def _looks_internal(email: str | None) -> bool:
    return any(h in (email or "").lower() for h in TEST_EMAIL_HINTS)


def _hours_ago(iso: str | None) -> float | None:
    d = _parse_dt(iso)
    if d is None:
        return None
    return round((datetime.now(timezone.utc) - d).total_seconds() / 3600, 1)


def collect_facts(data: ReportData, window_hours: int) -> dict:
    """Structured digest of what changed in the trailing window — the input
    the LLM narrates. Current-state context (totals, stuck cohort) is kept so
    the story has substance even on a quiet day."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    totals = {"users": 0, "with_portfolio": 0, "trading": 0, "public": 0}
    new_signups: list[dict] = []
    advances: list[dict] = []
    trades_in_window: list[dict] = []
    performance: list[dict] = []
    stuck: list[dict] = []

    for p in data.profiles():
        totals["users"] += 1
        email = p.get("email")
        who = p.get("display_name") or (email or "").split("@")[0] or p["id"]
        internal = _looks_internal(email)
        portfolios = data.portfolios_for(p["id"])

        if _within(p.get("created_at"), cutoff):
            new_signups.append({
                "who": who, "email": email, "internal": internal,
                "hours_ago": _hours_ago(p.get("created_at")),
                "created_portfolio": bool(portfolios),
            })

        if not portfolios:
            stuck.append({
                "who": who, "email": email, "internal": internal,
                "days_since_signup": _days_since(p.get("created_at")),
            })
            continue
        totals["with_portfolio"] += 1

        for pf in portfolios:
            pid = pf["id"]
            holdings = data.holdings(pid)
            team = data.team(pid)
            trades = data.trades(pid)
            snaps = data.recent_snapshots(pid, 2)
            name = pf.get("display_name") or pf.get("slug")

            if bool(trades) or bool(holdings):
                totals["trading"] += 1
            if pf.get("is_public"):
                totals["public"] += 1

            # Funnel advances inside the window
            if _within(pf.get("created_at"), cutoff):
                advances.append({"who": who, "internal": internal,
                                 "event": "created portfolio", "detail": name})
            hired = [m for m in team if _within(m.get("joined_at"), cutoff)]
            if hired:
                agents = ", ".join((m.get("agents") or {}).get("display_name", "?") for m in hired)
                advances.append({"who": who, "internal": internal,
                                 "event": "hired agents", "detail": f"{name}: {agents}"})
            window_trades = [t for t in trades if _within(t.get("executed_at"), cutoff)]
            if window_trades and len(window_trades) == len(trades):
                advances.append({"who": who, "internal": internal,
                                 "event": "first trade", "detail": name})

            if window_trades:
                trades_in_window.append({
                    "who": who, "internal": internal, "portfolio": name,
                    "count": len(window_trades),
                    "trades": [{
                        "side": t.get("side"), "ticker": t.get("ticker"),
                        "qty": safe_float(t.get("quantity")),
                        "price": safe_float(t.get("price_usd")),
                        "hours_ago": _hours_ago(t.get("executed_at")),
                    } for t in window_trades[:12]],
                })

            if snaps:
                latest = snaps[0]
                day_change = None
                if len(snaps) > 1:
                    v0 = safe_float(latest.get("total_value_usd"))
                    v1 = safe_float(snaps[1].get("total_value_usd"))
                    if v0 is not None and v1:
                        day_change = round((v0 - v1) / v1 * 100, 2)
                best = worst = None
                if holdings:
                    prices = data.prices([h["ticker"] for h in holdings])
                    moves = []
                    for h in holdings:
                        c = safe_float(h.get("avg_cost_usd"))
                        px = prices.get(h["ticker"])
                        if c and px:
                            moves.append([h["ticker"], round((px - c) / c * 100)])
                    if moves:
                        best = max(moves, key=lambda m: m[1])
                        worst = min(moves, key=lambda m: m[1])
                performance.append({
                    "who": who, "internal": internal, "portfolio": name,
                    "mode": pf.get("mode") or "paper", "public": bool(pf.get("is_public")),
                    "mandate": (pf.get("description") or "").strip()[:200] or None,
                    "value": safe_float(latest.get("total_value_usd")),
                    "pnl_pct": safe_float(latest.get("pnl_pct")),
                    "day_change_pct": day_change,
                    "positions": latest.get("num_positions"),
                    "team": [(m.get("agents") or {}).get("display_name") for m in team],
                    "best_holding": best, "worst_holding": worst,
                })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "window_hours": window_hours,
        "totals": totals,
        "new_signups": new_signups,
        "advances": advances,
        "trades_in_window": trades_in_window,
        "performance": performance,
        "stuck": stuck,
    }


STORY_BRIEF = """You are writing AlphaMolt's daily internal "onboarding digest" — a short email to the founder.

What AlphaMolt is: a public web app where a person signs up, writes a plain-English investment mandate, hires a team of AI agents into a $1M paper-trading portfolio, and those agents trade US stocks and compete on a public leaderboard ranked by return vs the S&P 500. The onboarding funnel is: signed up -> created a portfolio -> wrote a mandate -> hired agents -> first trade -> went public.

Your job: tell the story of the last {window_hours} hours as an engaging, honest narrative from an onboarding / growth point of view. Celebrate genuine successes and call out failures and drop-off without spin.

Guidance:
- Lead with what actually changed in the window (new signups, funnel advances, trades, notable performance moves). If it was a quiet window, say so plainly and give the current state of play.
- Be specific: use names/handles and real numbers from the data. Never invent anything that isn't in the data.
- Accounts flagged "internal": true are the team's own / test accounts — do not count them as real traction; mention them only briefly, as tests.
- Highlight friction: people stuck at "signed up" with no portfolio (especially the older ones) are the core onboarding problem.
- Note standout portfolios: best / worst day move, big winning or losing holdings, who is actually trading versus idle.
- End with 1-2 concrete, specific suggestions to improve onboarding conversion, grounded in what you saw.

Tone: sharp, concise, a little wry. About 250-400 words. Plain text for an email — short paragraphs, no markdown headings or tables, no subject line.

Here is the data (JSON):
"""


def narrate(facts: dict, window_hours: int) -> str | None:
    """Turn the facts into a story via Gemini. Returns None on failure so the
    caller can fall back to a plain-text summary."""
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        logger.warning("--story needs GEMINI_API_KEY; falling back to plain summary.")
        return None
    prompt = STORY_BRIEF.format(window_hours=window_hours) + json.dumps(facts, default=str)
    model = os.environ.get("REPORT_LLM_MODEL", "gemini-2.5-flash").strip()
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
        f":generateContent?key={api_key}"
    )
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                url, data=body, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read())
            if "error" in data:
                raise RuntimeError(str(data["error"]))
            text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
            if text:
                return text
        except Exception as exc:  # noqa: BLE001
            logger.warning("Gemini story attempt %d/3 failed: %s", attempt + 1, exc)
    return None


def story_header(facts: dict) -> str:
    t = facts["totals"]
    return (
        f"AlphaMolt onboarding digest · last {facts['window_hours']}h · "
        f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}\n"
        f"{t['users']} users · {t['with_portfolio']} with a portfolio · "
        f"{t['trading']} trading · {t['public']} public\n"
        + "=" * 60
        + "\n\n"
    )


def facts_to_text(facts: dict) -> str:
    """Plain-text fallback if the LLM is unavailable — never leaves the email empty."""
    lines: list[str] = []
    ns = [s for s in facts["new_signups"] if not s["internal"]]
    lines.append(f"New signups in window: {len(ns)}")
    for s in ns:
        lines.append(f"  - {s['who']} <{s['email']}> ({s['hours_ago']}h ago)"
                     + (" — created a portfolio" if s["created_portfolio"] else " — no portfolio yet"))
    adv = [a for a in facts["advances"] if not a["internal"]]
    lines.append(f"\nFunnel advances: {len(adv)}")
    for a in adv:
        lines.append(f"  - {a['who']}: {a['event']} ({a['detail']})")
    tw = [t for t in facts["trades_in_window"] if not t["internal"]]
    lines.append(f"\nPortfolios trading in window: {len(tw)}")
    for t in tw:
        lines.append(f"  - {t['who']} / {t['portfolio']}: {t['count']} trades")
    stuck = [s for s in facts["stuck"] if not s["internal"]]
    lines.append(f"\nStuck (signed up, no portfolio): {len(stuck)}")
    for s in sorted(stuck, key=lambda x: x["days_since_signup"] or 0, reverse=True):
        lines.append(f"  - {s['who']} <{s['email']}> — {s['days_since_signup']}d ago")
    return "\n".join(lines)


def build_story(data: ReportData, window_hours: int) -> str:
    facts = collect_facts(data, window_hours)
    body = narrate(facts, window_hours) or facts_to_text(facts)
    return story_header(facts) + body


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------

def deliver_slack(report: str) -> bool:
    url = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not url:
        logger.warning("--slack set but SLACK_WEBHOOK_URL is empty; skipping Slack.")
        return False
    payload = json.dumps({"text": f"```\n{report}\n```"}).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            ok = 200 <= resp.status < 300
        logger.info("Slack delivery %s", "ok" if ok else "failed")
        return ok
    except Exception as exc:  # noqa: BLE001 — report-only, never fatal
        logger.error("Slack delivery failed: %s", exc)
        return False


def deliver_email(report: str, to_override: str | None) -> bool:
    """Email the digest. Prefers the Resend HTTP API when RESEND_API_KEY is
    set; otherwise falls back to SMTP (SMTP_* vars)."""
    subject = f"AlphaMolt user report · {datetime.now(timezone.utc):%Y-%m-%d}"
    recipient = (to_override or os.environ.get("REPORT_EMAIL_TO", "")).strip()

    if os.environ.get("RESEND_API_KEY", "").strip():
        return _deliver_resend(report, subject, recipient)
    if os.environ.get("SMTP_HOST", "").strip():
        return _deliver_smtp(report, subject, recipient)
    logger.warning(
        "--email skipped; set RESEND_API_KEY (+ REPORT_EMAIL_FROM/_TO) or the SMTP_* vars."
    )
    return False


def _deliver_resend(report: str, subject: str, recipient: str) -> bool:
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    sender = os.environ.get("REPORT_EMAIL_FROM", "").strip()
    missing = [
        n
        for n, v in [
            ("REPORT_EMAIL_FROM", sender),
            ("recipient (REPORT_EMAIL_TO/--email)", recipient),
        ]
        if not v
    ]
    if missing:
        logger.warning("Resend email skipped; missing: %s", ", ".join(missing))
        return False

    payload = json.dumps(
        {"from": sender, "to": [recipient], "subject": subject, "text": report}
    ).encode()
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            # Resend's API is behind Cloudflare, which 403s (error 1010) the
            # default "Python-urllib" agent as a bot. A normal UA passes.
            "User-Agent": "AlphaMolt-UserReport/1.0 (+https://alphamolt.ai)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            ok = 200 <= resp.status < 300
            raw = resp.read().decode(errors="replace")
        msg_id = None
        try:
            msg_id = json.loads(raw).get("id")
        except (ValueError, AttributeError):
            pass
        # Accepted by Resend ≠ delivered. Trace this id in the Resend
        # dashboard (Emails) to see delivered / bounced / dropped + reason.
        logger.info(
            "Resend email %s to %s (id=%s) — check Resend dashboard for delivery status",
            "accepted" if ok else "rejected", recipient, msg_id,
        )
        return ok
    except urllib.error.HTTPError as exc:  # surface Resend's error body
        body = exc.read().decode(errors="replace")[:300]
        logger.error("Resend email failed (%s): %s", exc.code, body)
        return False
    except Exception as exc:  # noqa: BLE001
        logger.error("Resend email failed: %s", exc)
        return False


def _deliver_smtp(report: str, subject: str, recipient: str) -> bool:
    host = os.environ.get("SMTP_HOST", "").strip()
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").strip()
    sender = os.environ.get("REPORT_EMAIL_FROM", user).strip()
    port = int(os.environ.get("SMTP_PORT", "587"))

    missing = [
        n
        for n, v in [
            ("SMTP_HOST", host),
            ("SMTP_USER", user),
            ("SMTP_PASSWORD", password),
            ("recipient (REPORT_EMAIL_TO/--email)", recipient),
        ]
        if not v
    ]
    if missing:
        logger.warning("SMTP email skipped; missing: %s", ", ".join(missing))
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient
    msg.set_content(report)
    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls()
            s.login(user, password)
            s.send_message(msg)
        logger.info("SMTP email delivered to %s", recipient)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.error("SMTP email delivery failed: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--story", action="store_true",
                        help="Emit an LLM-written onboarding story of the trailing window")
    parser.add_argument("--window-hours", type=int, default=24,
                        help="Activity window for --story (default 24)")
    parser.add_argument("--days", type=int, default=None,
                        help="Full report: only users who signed up within N days")
    parser.add_argument("--slack", action="store_true",
                        help="Also POST the digest to SLACK_WEBHOOK_URL")
    parser.add_argument("--email", nargs="?", const=True, default=False,
                        help="Also email the digest (optional recipient override)")
    parser.add_argument("--quiet", action="store_true",
                        help="Suppress the console print (delivery only)")
    args = parser.parse_args()

    db = SupabaseDB()
    data = ReportData(db)
    if args.story:
        report = build_story(data, args.window_hours)
    else:
        report, _counts = build_report(data, args.days)

    if not args.quiet:
        print(report)

    if args.slack:
        deliver_slack(report)
    if args.email is not False:
        to = args.email if isinstance(args.email, str) else None
        deliver_email(report, to)

    return 0


if __name__ == "__main__":
    sys.exit(main())
