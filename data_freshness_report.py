"""
data_freshness_report.py — daily survey of Level 0 data freshness, emailed.

Answers one question every morning: "is every Level 0 fact still being kept
fresh?" For each data type it reports coverage, the freshest + stalest stamp,
how many rows were refreshed in the last 24h (the pipeline-alive signal), and a
RAG status, then emails the digest (reusing user_report.py's Resend→SMTP
delivery) and/or posts it to Slack.

Status rules (per data type):
  - 🔴 STALE   — no data, OR a daily-cadence feed wrote nothing in 24h, OR the
                 stalest name is well past its expected refresh window.
  - 🟡 WATCH   — stalest name past window, or coverage below the floor.
  - 🟢 OK      — actively refreshing and within window.

Usage:
    python data_freshness_report.py                 # print to stdout
    python data_freshness_report.py --email          # email REPORT_EMAIL_TO
    python data_freshness_report.py --email me@x.com # email an override addr
    python data_freshness_report.py --slack          # post to SLACK_WEBHOOK_URL
"""

import argparse
import json
import logging
import os
import smtplib
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage

from db import SupabaseDB
from user_report import deliver_slack

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger("data_freshness")

OK, WATCH, STALE, INFO = "OK", "WATCH", "STALE", "INFO"
_EMOJI = {OK: "🟢", WATCH: "🟡", STALE: "🔴", INFO: "⚪"}
_COLOR = {OK: "#1a7f37", WATCH: "#9a6700", STALE: "#cf222e", INFO: "#57606a"}

# Which GitHub Action(s) keep each dataset fresh — surfaced in the report so a
# red row points straight at the workflow to check.
SOURCE = {
    "Current price": "intraday-prices.yml",
    "Daily prices": "prices-daily.yml",
    "Valuation / P-S": "daily-price-sales.yml",
    "Fundamentals": "fundamentals-update.yml",
    "AI analysis": "bull-evaluation · bear-evaluation · update-narratives · research-evaluation",
    "Estimates": "— (no ingest)",
    "Events": "— (no ingest)",
}


# ---------------------------------------------------------------------------
# Pure classification (unit-tested)
# ---------------------------------------------------------------------------


def classify(
    *,
    have: int,
    total: int | None,
    stalest_age_days: float | None,
    refreshed_24h: int | None,
    expected_daily: bool,
    max_stale_days: float,
    min_coverage: float,
) -> str:
    """RAG status for one data type. Pure → unit-tested."""
    if have == 0:
        return STALE
    if expected_daily and refreshed_24h is not None and refreshed_24h == 0:
        return STALE
    if stalest_age_days is not None and stalest_age_days > max_stale_days * 1.5:
        return STALE
    if stalest_age_days is not None and stalest_age_days > max_stale_days:
        return WATCH
    if total and (have / total) < min_coverage:
        return WATCH
    return OK


# ---------------------------------------------------------------------------
# Gathering
# ---------------------------------------------------------------------------


@dataclass
class Row:
    name: str
    coverage: str
    freshest: str
    stalest: str
    refreshed_24h: str
    status: str
    note: str = ""
    source: str = ""


def _parse(ts) -> datetime | None:
    """Tolerant ISO/date parser → tz-aware UTC datetime, or None."""
    if not ts:
        return None
    s = str(ts).strip().replace("Z", "+00:00")
    if len(s) == 10:  # date only
        s += "T00:00:00+00:00"
    for cand in (s, s + ":00"):  # tolerate a "+00" offset
        try:
            d = datetime.fromisoformat(cand)
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _age_days(ts, now: datetime) -> float | None:
    d = _parse(ts)
    return None if d is None else (now - d).total_seconds() / 86_400


def _fmt_age(ts, now: datetime) -> str:
    age = _age_days(ts, now)
    if age is None:
        return "—"
    d = _parse(ts)
    datestr = d.strftime("%b %d")
    days = int(age)
    return f"{datestr} ({days}d)" if days > 0 else f"{datestr} (today)"


def _summarize_map(stamps: list[str], now: datetime):
    """(newest_ts, oldest_ts, refreshed_24h) over a list of ISO stamps."""
    parsed = [(s, _parse(s)) for s in stamps if _parse(s) is not None]
    if not parsed:
        return None, None, 0
    parsed.sort(key=lambda p: p[1])
    oldest, newest = parsed[0][0], parsed[-1][0]
    cutoff = now.timestamp() - 86_400
    refreshed = sum(1 for _, d in parsed if d.timestamp() >= cutoff)
    return newest, oldest, refreshed


def gather(db: SupabaseDB) -> list[Row]:
    now = datetime.now(timezone.utc)

    secs = db.get_all_securities(
        columns="ticker,is_tier1,price,price_asof", status="active")
    tier1 = [s for s in secs if s.get("is_tier1")]
    total = len(tier1)
    rows: list[Row] = []

    # 1. Current price (securities.price) — the headline canary, intraday cadence.
    priced = [s for s in tier1 if db.safe_float(s.get("price"))]
    newest, oldest, r24 = _summarize_map([s.get("price_asof") for s in priced], now)
    rows.append(_row(
        "Current price", have=len(priced), total=total,
        newest=newest, oldest=oldest, refreshed_24h=r24, now=now,
        expected_daily=True, max_stale_days=4, min_coverage=0.5,
    ))

    # 2. Daily prices (prices_daily) — EOD layer. Newest date + recent coverage.
    newest_pd = None
    try:
        resp = (db.client.table("prices_daily").select("date")
                .order("date", desc=True).limit(1).execute())
        newest_pd = (resp.data or [{}])[0].get("date")
    except Exception as exc:  # noqa: BLE001
        logger.warning("prices_daily newest read failed: %s", exc)
    recent_since = (now.date().fromordinal(now.date().toordinal() - 5)).isoformat()
    try:
        recent = db.get_tickers_with_recent_prices(recent_since)
    except Exception:  # noqa: BLE001
        recent = set()
    age = _age_days(newest_pd, now)
    status = STALE if newest_pd is None else (WATCH if (age or 0) > 4 else OK)
    rows.append(Row(
        "Daily prices", coverage=f"{len(recent)} (last 5d)",
        freshest=_fmt_age(newest_pd, now), stalest="—",
        refreshed_24h="—", status=status,
        note="EOD; today's bar lands after the close",
    ))

    # 3. Valuation / P-S (valuation) — daily full-universe via price_sales_updater.
    val = db.get_all_valuation_latest()
    newest, oldest, r24 = _summarize_map(
        [v.get("fetched_at") for v in val.values()], now)
    rows.append(_row(
        "Valuation / P-S", have=len(val), total=total,
        newest=newest, oldest=oldest, refreshed_24h=r24, now=now,
        expected_daily=True, max_stale_days=4, min_coverage=0.5,
    ))

    # 4. Fundamentals (fundamentals) — daily ROTATION (~universe/batch days).
    fund = db.get_fundamentals_freshness()
    newest, oldest, r24 = _summarize_map(list(fund.values()), now)
    rows.append(_row(
        "Fundamentals", have=len(fund), total=total,
        newest=newest, oldest=oldest, refreshed_24h=r24, now=now,
        expected_daily=True, max_stale_days=30, min_coverage=0.5,
        note="rotation: stalest nears the cycle length by design",
    ))

    # 5. AI analysis (ai_analysis) — rotation (bull/bear/narrative clocks).
    ai = db.get_ai_analysis_freshness()
    newest, oldest, r24 = _summarize_map(list(ai.values()), now)
    rows.append(_row(
        "AI analysis", have=len(ai), total=total,
        newest=newest, oldest=oldest, refreshed_24h=r24, now=now,
        expected_daily=True, max_stale_days=30, min_coverage=0.3,
        note="rotation",
    ))

    # 6. Estimates / Events — not ingested yet (informational).
    for label, table in (("Estimates", "estimates"), ("Events", "events")):
        try:
            resp = db.client.table(table).select("ticker", count="exact", head=True).execute()
            n = resp.count or 0
        except Exception:  # noqa: BLE001
            n = 0
        rows.append(Row(label, coverage=f"{n} rows", freshest="—", stalest="—",
                        refreshed_24h="—", status=INFO,
                        note="no ingest job yet"))

    for r in rows:
        r.source = SOURCE.get(r.name, "—")
    return rows


def _row(name, *, have, total, newest, oldest, refreshed_24h, now,
         expected_daily, max_stale_days, min_coverage, note="") -> Row:
    status = classify(
        have=have, total=total,
        stalest_age_days=_age_days(oldest, now),
        refreshed_24h=refreshed_24h, expected_daily=expected_daily,
        max_stale_days=max_stale_days, min_coverage=min_coverage,
    )
    return Row(
        name=name,
        coverage=f"{have} / {total}" if total else str(have),
        freshest=_fmt_age(newest, now),
        stalest=_fmt_age(oldest, now),
        refreshed_24h=str(refreshed_24h),
        status=status,
        note=note,
    )


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _issue_count(rows: list[Row]) -> int:
    return sum(1 for r in rows if r.status in (WATCH, STALE))


def render_text(rows: list[Row]) -> tuple[str, int]:
    """Plain-text report (stdout + Slack + email text-fallback)."""
    now = datetime.now(timezone.utc)
    issues = _issue_count(rows)
    headline = "✅ all data fresh" if issues == 0 else f"⚠️ {issues} item(s) need attention"

    w_name = max(len("Data"), *(len(r.name) for r in rows))
    w_cov = max(len("Coverage"), *(len(r.coverage) for r in rows))
    w_fresh = max(len("Freshest"), *(len(r.freshest) for r in rows))
    w_stale = max(len("Stalest"), *(len(r.stalest) for r in rows))
    w_24 = max(len("24h"), *(len(r.refreshed_24h) for r in rows))

    lines = [
        f"AlphaMolt — Level 0 data freshness · {now:%Y-%m-%d %H:%M UTC}",
        headline,
        "",
        f"  {'Data':<{w_name}}  {'Coverage':<{w_cov}}  {'Freshest':<{w_fresh}}  "
        f"{'Stalest':<{w_stale}}  {'24h':>{w_24}}  Status",
        f"  {'-'*w_name}  {'-'*w_cov}  {'-'*w_fresh}  {'-'*w_stale}  {'-'*w_24}  ------",
    ]
    for r in rows:
        lines.append(
            f"  {r.name:<{w_name}}  {r.coverage:<{w_cov}}  {r.freshest:<{w_fresh}}  "
            f"{r.stalest:<{w_stale}}  {r.refreshed_24h:>{w_24}}  {_EMOJI[r.status]} {r.status}"
        )
    lines += ["", "Maintained by:"]
    lines += [f"  · {r.name}: {r.source}" for r in rows]
    notes = [f"  · {r.name}: {r.note}" for r in rows if r.note and r.status != OK]
    if notes:
        lines += ["", "Notes:"] + notes
    lines += [
        "",
        "Legend: Coverage = names with this fact / Tier-1 universe. "
        "24h = rows refreshed in the last day (pipeline-alive signal).",
    ]
    return "\n".join(lines), issues


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def render_html(rows: list[Row]) -> str:
    """Styled HTML email — table with colored status badges + the maintaining
    Action per dataset. Inline styles only (email-client-safe)."""
    now = datetime.now(timezone.utc)
    issues = _issue_count(rows)
    banner_bg, banner_fg, banner = (
        ("#dafbe1", "#1a7f37", "✅ All data fresh")
        if issues == 0
        else ("#fff8c5", "#9a6700", f"⚠️ {issues} item(s) need attention")
    )

    th = ('style="text-align:left;padding:8px 10px;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;'
          'color:#57606a;border-bottom:2px solid #d0d7de;text-transform:uppercase;letter-spacing:.04em"')
    td = 'style="padding:8px 10px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#1f2328;border-bottom:1px solid #eaeef2;vertical-align:top"'
    tdmuted = 'style="padding:8px 10px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#57606a;border-bottom:1px solid #eaeef2;vertical-align:top"'

    body = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:760px;margin:0 auto;color:#1f2328">',
        f'<h2 style="margin:0 0 2px;font-size:18px">AlphaMolt — Level&nbsp;0 data freshness</h2>',
        f'<p style="margin:0 0 14px;color:#57606a;font-size:13px">{now:%Y-%m-%d %H:%M UTC}</p>',
        f'<div style="display:inline-block;padding:6px 12px;border-radius:6px;background:{banner_bg};'
        f'color:{banner_fg};font-weight:600;font-size:14px;margin-bottom:16px">{banner}</div>',
        '<table style="border-collapse:collapse;width:100%">',
        f'<tr><th {th}>Data</th><th {th}>Maintained by</th><th {th}>Coverage</th>'
        f'<th {th}>Freshest</th><th {th}>Stalest</th><th {th}>24h</th><th {th}>Status</th></tr>',
    ]
    for r in rows:
        badge = (f'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-weight:600;'
                 f'font-size:12px;color:#fff;background:{_COLOR[r.status]}">{_EMOJI[r.status]} {r.status}</span>')
        body.append(
            f"<tr><td {td}><b>{_esc(r.name)}</b></td>"
            f"<td {tdmuted}>{_esc(r.source)}</td>"
            f"<td {td}>{_esc(r.coverage)}</td>"
            f"<td {td}>{_esc(r.freshest)}</td>"
            f"<td {td}>{_esc(r.stalest)}</td>"
            f"<td {td}>{_esc(r.refreshed_24h)}</td>"
            f"<td {td}>{badge}</td></tr>"
        )
    body.append("</table>")

    notes = [r for r in rows if r.note and r.status != OK]
    if notes:
        body.append('<p style="margin:16px 0 4px;font-weight:600;font-size:13px">Notes</p><ul style="margin:0;padding-left:18px;color:#57606a;font-size:13px">')
        body += [f"<li><b>{_esc(r.name)}:</b> {_esc(r.note)}</li>" for r in notes]
        body.append("</ul>")

    body.append(
        '<p style="margin:18px 0 0;color:#8c959f;font-size:12px">'
        "Coverage = names with this fact / Tier-1 universe. "
        "24h = rows refreshed in the last day (pipeline-alive signal). "
        "Rotation feeds (fundamentals, AI) refresh a slice daily, so their stalest age "
        "nears the cycle length by design.</p>"
        "</div>"
    )
    return "\n".join(body)


# ---------------------------------------------------------------------------
# Delivery (HTML email, reusing the report env vars)
# ---------------------------------------------------------------------------


def deliver_email(text: str, html: str, subject: str, to_override: str | None) -> bool:
    recipient = (to_override or os.environ.get("REPORT_EMAIL_TO", "")).strip()
    if os.environ.get("RESEND_API_KEY", "").strip():
        return _resend_html(text, html, subject, recipient)
    if os.environ.get("SMTP_HOST", "").strip():
        return _smtp_html(text, html, subject, recipient)
    logger.warning("--email skipped; set RESEND_API_KEY (+ REPORT_EMAIL_FROM/_TO) or SMTP_*.")
    return False


def _resend_html(text: str, html: str, subject: str, recipient: str) -> bool:
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    sender = os.environ.get("REPORT_EMAIL_FROM", "").strip()
    if not sender or not recipient:
        logger.warning("Resend email skipped; need REPORT_EMAIL_FROM + REPORT_EMAIL_TO/--email.")
        return False
    payload = json.dumps(
        {"from": sender, "to": [recipient], "subject": subject, "html": html, "text": text}
    ).encode()
    req = urllib.request.Request(
        "https://api.resend.com/emails", data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            # Resend sits behind Cloudflare, which 403s the default urllib UA.
            "User-Agent": "AlphaMolt-FreshnessReport/1.0 (+https://alphamolt.ai)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            ok = 200 <= resp.status < 300
        logger.info("Resend email %s to %s", "accepted" if ok else "rejected", recipient)
        return ok
    except urllib.error.HTTPError as exc:
        logger.error("Resend email failed (%s): %s", exc.code, exc.read().decode(errors="replace")[:300])
        return False
    except Exception as exc:  # noqa: BLE001
        logger.error("Resend email failed: %s", exc)
        return False


def _smtp_html(text: str, html: str, subject: str, recipient: str) -> bool:
    host = os.environ.get("SMTP_HOST", "").strip()
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").strip()
    sender = os.environ.get("REPORT_EMAIL_FROM", user).strip()
    port = int(os.environ.get("SMTP_PORT", "587"))
    if not (host and user and password and recipient):
        logger.warning("SMTP email skipped; need SMTP_HOST/USER/PASSWORD + recipient.")
        return False
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, sender, recipient
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
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


def main() -> int:
    ap = argparse.ArgumentParser(description="Daily Level 0 data-freshness report")
    ap.add_argument("--email", nargs="?", const="", metavar="ADDR",
                    help="email the report (optional override recipient)")
    ap.add_argument("--slack", action="store_true", help="post to SLACK_WEBHOOK_URL")
    args = ap.parse_args()

    db = SupabaseDB()
    rows = gather(db)
    text, issues = render_text(rows)
    print(text)

    if args.slack:
        deliver_slack(text)
    if args.email is not None:
        subject = (f"AlphaMolt data freshness · {datetime.now(timezone.utc):%Y-%m-%d}"
                   f" · {'all green' if issues == 0 else f'{issues} issue(s)'}")
        deliver_email(text, render_html(rows), subject, args.email or None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
