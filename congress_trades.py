"""Congressional trade ingester — House Periodic Transaction Reports (PTRs).

Fetches and parses a member of Congress's disclosed stock transactions from the
**authoritative, free** source: the Office of the Clerk of the U.S. House of
Representatives. No API key, no third-party aggregator.

Pipeline:

1. Download the yearly filing index ``{YEAR}FD.zip`` (an XML list of every
   disclosure: member, filing type, date, DocID).
2. Keep the target member's ``FilingType='P'`` rows — the Periodic Transaction
   Reports (the trade disclosures).
3. For each PTR DocID not already ingested, download the PDF
   (``/public_disc/ptr-pdfs/{YEAR}/{DocID}.pdf``) and parse its transactions.
   The electronically-filed PTRs carry selectable text, so a tolerant regex
   over the extracted text yields one row per transaction.
4. Upsert into ``congress_trades`` (idempotent on a content hash).

Each parsed transaction records: owner (SP/JT/DC/self), the underlying ticker,
the asset-type code, buy/sell direction, the transaction date, the disclosed
dollar band, whether it is an option, and whether it is a gift / charitable
contribution (so the mirror strategy can ignore non-market disposals).

The downstream ``pelosi_mirror`` strategy reads ``congress_trades`` — this
script never trades. Run it on a cron *before* the heartbeat.

CLI::

    python congress_trades.py                       # ingest Nancy Pelosi, current year
    python congress_trades.py --years 2024 2025
    python congress_trades.py --politician "Nancy Pelosi" --dry-run
    python congress_trades.py --last Pelosi --first Nancy
"""

from __future__ import annotations

import argparse
import hashlib
import io
import logging
import re
import sys
import time
import zipfile
from dataclasses import dataclass
from datetime import date, datetime
from xml.etree import ElementTree as ET

import requests

from db import SupabaseDB

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("congress_trades")

HOUSE_BASE = "https://disclosures-clerk.house.gov/public_disc"
INDEX_URL = HOUSE_BASE + "/financial-pdfs/{year}FD.zip"
PTR_PDF_URL = HOUSE_BASE + "/ptr-pdfs/{year}/{doc_id}.pdf"
# A browser-ish UA — the clerk site 403s an empty agent.
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; alphamolt-congress-ingest/1.0)"}
DELAY_BETWEEN_CALLS = 1.0  # be polite to a .gov host

SOURCE = "house-clerk"


# ---------------------------------------------------------------------------
# Parsing (pure — unit-tested against real Pelosi filings)
# ---------------------------------------------------------------------------

# Anchors on the reliable tail of every transaction row:
#   (TICKER) [XX] <code> MM/DD/YYYYMM/DD/YYYY $min - $max
# The two dates are concatenated and the amount band may wrap a line; \s
# matches the intervening newlines. NUL padding in field labels is normalised
# away by `_clean` before this runs.
_CORE = re.compile(
    r"\((?P<ticker>[A-Z]{1,5}(?:\.[A-Z]+)?)\)\s*\[(?P<atype>[A-Z]{2})\]\s+"
    r"(?P<code>S \(partial\)|P|S|E)\s+"
    r"(?P<txn>\d{2}/\d{2}/\d{4})(?P<notif>\d{2}/\d{2}/\d{4})\s*"
    r"\$?(?P<amin>[\d,]+)\s*-\s*\$?(?P<amax>[\d,]+)"
)
_GIFT = re.compile(r"contribut|gift|charit|donat", re.I)
_OWNER = re.compile(r"\b(SP|JT|DC)\b")


def _clean(text: str) -> str:
    """Normalise extracted PTR text: the clerk PDFs pad field labels with NUL
    bytes (``D\\x00\\x00...:``) rather than spaces."""
    return text.replace("\x00", " ")


def _description(block: str) -> str:
    """Pull the ``Description:`` free text from a transaction's trailing block.

    Field labels render as a single leading letter + colon (``D : ...``,
    ``F S : New``, ``L : US``) after NUL normalisation. The description can wrap
    onto continuation lines; stop at the next labelled line / next row / footer.
    """
    m = re.search(
        r"^\s*D\s*:\s*(.+(?:\n(?!\s*[A-Z]\s*:|\*|SP |JT |DC ).+)*)",
        block, re.M,
    )
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


@dataclass
class ParsedTxn:
    owner: str
    ticker: str
    asset_type: str
    raw_txn_code: str
    txn_type: str          # 'buy' | 'sell'
    txn_date: str | None   # ISO yyyy-mm-dd
    notification_date: str | None
    amount_min: int
    amount_max: int
    is_option: bool
    is_gift: bool
    description: str


def _iso(mdy: str) -> str | None:
    try:
        return datetime.strptime(mdy, "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


def parse_ptr_text(text: str) -> list[ParsedTxn]:
    """Parse all transactions from one PTR's extracted (NUL-padded) text."""
    text = _clean(text)
    matches = list(_CORE.finditer(text))
    out: list[ParsedTxn] = []
    for i, m in enumerate(matches):
        header = text[(matches[i - 1].end() if i else 0): m.start()]
        owners = _OWNER.findall(header)
        owner = owners[-1] if owners else "self"
        block = text[m.end():(matches[i + 1].start() if i + 1 < len(matches) else len(text))]
        desc = _description(block)
        code = m.group("code")
        txn_type = "buy" if code.startswith("P") else ("sell" if code.startswith("S") else "other")
        atype = m.group("atype")
        out.append(ParsedTxn(
            owner=owner,
            ticker=m.group("ticker").upper(),
            asset_type=atype,
            raw_txn_code=code,
            txn_type=txn_type,
            txn_date=_iso(m.group("txn")),
            notification_date=_iso(m.group("notif")),
            amount_min=int(m.group("amin").replace(",", "")),
            amount_max=int(m.group("amax").replace(",", "")),
            # The asset-type code is authoritative: [OP] is an option position.
            # An [ST] row whose description mentions "call options" is a stock
            # transaction (an exercise yielding shares), so it stays is_option=False.
            is_option=(atype == "OP"),
            is_gift=bool(_GIFT.search(desc)),
            description=desc[:500],
        ))
    return out


def _dedupe_hash(politician: str, doc_id: str, t: ParsedTxn) -> str:
    key = "|".join([politician, doc_id, t.ticker, t.raw_txn_code,
                    t.txn_date or "", t.owner, str(t.amount_min), str(t.amount_max)])
    return hashlib.sha256(key.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def fetch_index(year: int) -> list[dict]:
    """Return the year's filing index as a list of member-filing dicts."""
    url = INDEX_URL.format(year=year)
    resp = requests.get(url, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    xml_name = next(n for n in zf.namelist() if n.lower().endswith(".xml"))
    root = ET.fromstring(zf.read(xml_name))
    rows = []
    for m in root.findall("Member"):
        rows.append({
            "last": (m.findtext("Last") or "").strip(),
            "first": (m.findtext("First") or "").strip(),
            "filing_type": (m.findtext("FilingType") or "").strip(),
            "filing_date": (m.findtext("FilingDate") or "").strip(),
            "doc_id": (m.findtext("DocID") or "").strip(),
            "year": year,
        })
    return rows


def fetch_ptr_text(year: int, doc_id: str) -> str:
    """Download a PTR PDF and return its extracted text (best-effort)."""
    from pypdf import PdfReader  # local import: only needed when ingesting

    url = PTR_PDF_URL.format(year=year, doc_id=doc_id)
    resp = requests.get(url, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    reader = PdfReader(io.BytesIO(resp.content))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def member_ptrs(index: list[dict], last: str, first: str | None) -> list[dict]:
    """Filter an index to one member's Periodic Transaction Reports (type P)."""
    last_l = last.lower()
    first_l = (first or "").lower()
    out = []
    for row in index:
        if row["filing_type"] != "P":
            continue
        if last_l not in row["last"].lower():
            continue
        if first_l and first_l not in row["first"].lower():
            continue
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------


def ingest(
    db: SupabaseDB,
    *,
    politician: str,
    last: str,
    first: str | None,
    years: list[int],
    dry_run: bool = False,
    limit: int | None = None,
) -> dict:
    """Ingest a member's PTR transactions across the given years.

    Skips DocIDs already fully ingested (any ``congress_trades`` row carrying
    that ``doc_id`` for this politician), so re-runs only fetch new filings.
    Returns a small stats dict.
    """
    stats = {"filings_seen": 0, "filings_fetched": 0, "txns_parsed": 0,
             "txns_written": 0, "errors": 0}
    known_docs = db.get_known_congress_doc_ids(politician)

    payload: list[dict] = []
    for year in years:
        try:
            index = fetch_index(year)
        except Exception as exc:  # noqa: BLE001
            logger.warning("index fetch failed for %s: %s", year, exc)
            stats["errors"] += 1
            continue
        ptrs = member_ptrs(index, last, first)
        logger.info("%s %s: %d PTR filing(s) in %s index", first or "", last, len(ptrs), year)
        for row in ptrs:
            stats["filings_seen"] += 1
            doc_id = row["doc_id"]
            if doc_id in known_docs:
                continue
            if limit and stats["filings_fetched"] >= limit:
                break
            try:
                text = fetch_ptr_text(year, doc_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("PTR %s fetch failed: %s", doc_id, exc)
                stats["errors"] += 1
                continue
            stats["filings_fetched"] += 1
            txns = parse_ptr_text(text)
            stats["txns_parsed"] += len(txns)
            logger.info("  PTR %s (%s): %d transaction(s)", doc_id, row["filing_date"], len(txns))
            for t in txns:
                payload.append({
                    "politician": politician,
                    "doc_id": doc_id,
                    "filing_date": _iso(row["filing_date"]) if "/" in row["filing_date"] else None,
                    "owner": t.owner,
                    "ticker": t.ticker,
                    "asset_type": t.asset_type,
                    "raw_txn_code": t.raw_txn_code,
                    "txn_type": t.txn_type,
                    "txn_date": t.txn_date,
                    "notification_date": t.notification_date,
                    "amount_min": t.amount_min,
                    "amount_max": t.amount_max,
                    "is_option": t.is_option,
                    "is_gift": t.is_gift,
                    "description": t.description,
                    "source": SOURCE,
                    "dedupe_hash": _dedupe_hash(politician, doc_id, t),
                })
            time.sleep(DELAY_BETWEEN_CALLS)

    if dry_run:
        logger.info("[dry-run] would upsert %d transaction row(s)", len(payload))
        for p in payload:
            logger.info("  %-6s %-4s %-12s %s $%s-$%s%s%s",
                        p["ticker"], p["txn_type"], p["raw_txn_code"], p["txn_date"],
                        f"{p['amount_min']:,}", f"{p['amount_max']:,}",
                        " [opt]" if p["is_option"] else "",
                        " [gift]" if p["is_gift"] else "")
        stats["txns_written"] = 0
        return stats

    if payload:
        stats["txns_written"] = db.upsert_congress_trades(payload)
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Ingest a member of Congress's disclosed trades.")
    ap.add_argument("--politician", default="Nancy Pelosi",
                    help="Display name stored on each row (default: Nancy Pelosi).")
    ap.add_argument("--last", default="Pelosi", help="Surname to match in the index.")
    ap.add_argument("--first", default="Nancy", help="First name to match (substring).")
    ap.add_argument("--years", type=int, nargs="*", help="Years to ingest (default: current).")
    ap.add_argument("--limit", type=int, default=None, help="Max NEW filings to fetch this run.")
    ap.add_argument("--dry-run", action="store_true", help="Parse + print, write nothing.")
    args = ap.parse_args(argv)

    years = args.years or [date.today().year]
    db = SupabaseDB()
    stats = ingest(db, politician=args.politician, last=args.last, first=args.first,
                   years=years, dry_run=args.dry_run, limit=args.limit)
    logger.info("done: %s", stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())
