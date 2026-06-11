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

Usage:
    python user_report.py                      # print digest to console
    python user_report.py --slack              # also POST to SLACK_WEBHOOK_URL
    python user_report.py --email              # also email via SMTP_* vars
    python user_report.py --days 7             # only users who signed up in 7d
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
from datetime import datetime, timezone
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
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - d).days
    except (ValueError, TypeError):
        return None


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
        resp = (
            self.c.table("agent_portfolio_history")
            .select("snapshot_date, total_value_usd, pnl_pct, num_positions")
            .eq("portfolio_id", portfolio_id)
            .order("snapshot_date", desc=True)
            .limit(1)
            .execute()
        )
        return (resp.data or [None])[0]

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
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            ok = 200 <= resp.status < 300
        logger.info("Resend email %s to %s", "ok" if ok else "failed", recipient)
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
    parser.add_argument("--days", type=int, default=None,
                        help="Only users who signed up within N days")
    parser.add_argument("--slack", action="store_true",
                        help="Also POST the digest to SLACK_WEBHOOK_URL")
    parser.add_argument("--email", nargs="?", const=True, default=False,
                        help="Also email the digest (optional recipient override)")
    parser.add_argument("--quiet", action="store_true",
                        help="Suppress the console print (delivery only)")
    args = parser.parse_args()

    db = SupabaseDB()
    data = ReportData(db)
    report, counts = build_report(data, args.days)

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
