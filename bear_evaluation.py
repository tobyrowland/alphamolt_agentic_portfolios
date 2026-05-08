#!/usr/bin/env python3
"""
Bear Evaluation — Fundamental Sentinel.

Sends 100 in-screen tickers per run to Gemini 2.5 Flash for a forensic
fundamental health audit. Selection is rotation-based: oldest
``bear_eval_at`` first (NULLs first), so every screen ticker is
revisited every ~5 days at the daily cadence.

Schedule: daily 04:00 UTC.
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

from db import SupabaseDB

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_TIMEOUT = 300  # seconds
MAX_RETRIES = 3
RETRY_DELAY = 15
DELAY_BETWEEN_CALLS = 2
TOP_N = 100
NULL_VALUE = "\u2014"

# Columns to EXCLUDE from the data sent to Gemini
EXCLUDED_COLUMNS = {
    "status", "composite_score", "price", "ps_now",
    "price_pct_of_52w_high",
    "perf_52w_vs_spy", "rating", "ai_analyzed_at", "data_updated_at",
    "scored_at", "bear_eval", "bear_eval_at", "bull_eval", "bull_eval_at",
    "history_json", "in_tv_screen", "created_at", "updated_at",
    "sort_order", "flags",
}

# ---------------------------------------------------------------------------
# Bear prompt — The Fundamental Sentinel
# ---------------------------------------------------------------------------

BEAR_PROMPT_TEMPLATE = """\
Role: You are a specialized Forensic Analyst. Your sole mission is to determine \
if a company's fundamental health is likely to deteriorate over the next 12 months. \
You are strictly prohibited from considering valuation (price, P/E ratios, or \
whether a stock is "expensive"). You care only about the operational integrity \
and financial trajectory of the business.

Your Objective: Review every ticker. Assign either a Green Tick (\u2705) or a \
Red Cross (\u274c) to each one based exclusively on the provided text.

The "Red Cross" (\u274c) Criteria:
Assign a \u274c if the provided data or AI analysis indicates a negative \
trajectory in any of these areas:

Margin Erosion: Any mention of rising costs, thinning margins, or inability \
to pass costs to consumers.

Debt & Liquidity Stress: Mention of high leverage, weakening interest coverage, \
or "cash burn" concerns.

Revenue Quality: Evidence of slowing organic demand, reliance on one-off gains, \
or "churn" issues.

Operational Friction: Mention of supply chain breakdowns, management turnover, \
or loss of market share.

Obsolescence: The AI analysis suggests the company's core product is being \
disrupted or losing its "moat."

The "Green Tick" (\u2705) Criteria:
Assign a \u2705 only if the fundamentals appear stable or improving. If the \
data shows growing cash flows, stable/expanding margins, and a strengthening \
competitive position, it passes.

Output Format:
For every stock in the list, provide the result in this exact format. \
Use the EXACT ticker as shown in the data header (including numbers and slashes):

TICKER: \u2705 (Only if the fundamental trajectory is stable/improving)

TICKER: \u274c (Brief, blunt reason why the business fundamentals are at risk \
of deteriorating)

Strict Constraints:

IGNORE VALUATION: Even if a stock is described as "expensive" or "overvalued," \
do not mark it Red if the fundamentals are strong.

DATA ONLY: Use only the provided information. No outside market knowledge.

You MUST output a verdict for ALL {count} equities.

=== EQUITIES TO EVALUATE ({count}) ===

{equity_data}

=== END OF DATA ===

Now evaluate each equity above. Output ONLY the verdict lines, one per ticker. \
You must cover ALL {count} tickers."""


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def setup_logging() -> logging.Logger:
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"bear_eval_{date.today().isoformat()}.txt"

    logger = logging.getLogger("bear_evaluation")
    logger.setLevel(logging.INFO)

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s",
                            datefmt="%Y-%m-%d %H:%M:%S")

    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    return logger


# ---------------------------------------------------------------------------
# Data selection
# ---------------------------------------------------------------------------


def select_rotation_batch(companies: list[dict], top_n: int = TOP_N) -> list[dict]:
    """Pick the next batch of in-screen tickers ordered by staleness.

    Filter: in_tv_screen=True AND status doesn't start with ❌ (skips
    not-in-screen + red-flagged rows). Sort: bear_eval_at ascending with
    NULLs first — never-evaluated tickers go first, then longest-stale.
    Take top_n.
    """
    candidates = []
    for company in companies:
        if not company.get("in_tv_screen"):
            continue
        status = str(company.get("status") or "").strip()
        if status.startswith("❌"):
            continue
        ticker = (company.get("ticker") or "").strip()
        if not ticker:
            continue
        candidates.append(company)

    def _sort_key(c):
        evaled = c.get("bear_eval_at")
        return (0 if not evaled else 1, str(evaled or ""))

    candidates.sort(key=_sort_key)
    return candidates[:top_n]


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------


def build_equity_block(company: dict, excluded: set = EXCLUDED_COLUMNS) -> str:
    """Format a single equity's data for the prompt."""
    ticker = (company.get("ticker") or "").strip()
    company_name = (company.get("company_name") or "").strip()

    lines = [f"--- {ticker} ({company_name}) ---"]
    for col_name in sorted(company.keys()):
        if col_name in excluded or col_name.startswith("_"):
            continue
        # Skip the ticker and company_name since they're in the header
        if col_name in ("ticker", "company_name"):
            continue
        val = company.get(col_name)
        if val is None:
            continue
        val_str = str(val).strip()
        if not val_str or val_str == NULL_VALUE:
            continue
        lines.append(f"  {col_name}: {val_str}")

    return "\n".join(lines)


def build_bear_prompt(equity_blocks: list[str]) -> str:
    """Assemble the full bear prompt with all equity data."""
    equity_data = "\n\n".join(equity_blocks)
    return BEAR_PROMPT_TEMPLATE.format(
        count=len(equity_blocks),
        equity_data=equity_data,
    )


# ---------------------------------------------------------------------------
# Gemini API
# ---------------------------------------------------------------------------


def _call_gemini_text(prompt, api_key, model, timeout=GEMINI_TIMEOUT):
    """Call Gemini via curl subprocess, return raw text response."""
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 32768,
        },
    })
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(payload)
        payload_path = f.name
    try:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST", url,
             "-H", "Content-Type: application/json",
             "-d", f"@{payload_path}",
             "--max-time", str(timeout)],
            capture_output=True, text=True, timeout=timeout + 10,
        )
        return result.stdout
    finally:
        os.unlink(payload_path)


def call_gemini_bear(prompt, api_key, logger):
    """Call Gemini with retries, return raw text response or None."""
    for attempt in range(MAX_RETRIES):
        try:
            raw = _call_gemini_text(prompt, api_key, GEMINI_MODEL)
            if not raw or not raw.strip():
                raise Exception("Empty response from curl (possible timeout)")
            logger.info("Raw API response length: %d chars", len(raw))
            data = json.loads(raw)
            if "error" in data:
                raise Exception(
                    f"{data['error'].get('code')} {data['error'].get('message', '')}"
                )
            # Thinking models return multiple parts:
            # thought parts first, then the actual response.
            parts = data["candidates"][0]["content"]["parts"]
            logger.info("Response has %d parts", len(parts))
            for i, p in enumerate(parts):
                is_thought = p.get("thought", False)
                logger.info("  Part %d: thought=%s, length=%d", i, is_thought, len(p.get("text", "")))
            text_parts = [p["text"] for p in parts if not p.get("thought")]
            if not text_parts:
                # Fallback: use all parts if none lack the thought flag
                text_parts = [p["text"] for p in parts]
            text = text_parts[-1].strip() if text_parts else ""
            if not text:
                raise Exception("Empty response text after parsing parts")
            return text

        except Exception as exc:
            exc_str = str(exc)
            if attempt < MAX_RETRIES - 1:
                delay = RETRY_DELAY if "429" in exc_str or "RESOURCE_EXHAUSTED" in exc_str else 5
                logger.warning(
                    "Gemini call failed (attempt %d/%d), retrying in %ds: %s",
                    attempt + 1, MAX_RETRIES, delay, exc,
                )
                time.sleep(delay)
            else:
                logger.error(
                    "Gemini call failed (attempt %d/%d), giving up: %s",
                    attempt + 1, MAX_RETRIES, exc,
                )
                return None

    return None


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------


def parse_bear_results(response_text):
    """
    Parse Gemini response into {ticker: verdict_string} dict.

    Handles tickers that start with letters, numbers, or contain slashes.
    Examples: NVDA, 6857, VISTA/A, A3EGAB, 896047
    """
    results = {}
    # Match tickers: letters, digits, dots, slashes
    pattern = re.compile(
        r'^([A-Z0-9][A-Z0-9./]*?):\s*([\u2705\u274c].*)$',
        re.MULTILINE,
    )
    for match in pattern.finditer(response_text):
        ticker = match.group(1).strip()
        verdict = match.group(2).strip()
        results[ticker] = verdict
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    load_dotenv()

    parser = argparse.ArgumentParser(description="Bear Evaluation - Fundamental Sentinel")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print prompt and results without writing to the database")
    args = parser.parse_args()

    logger = setup_logging()
    logger.info("=== Bear Evaluation started (dry_run=%s) ===", args.dry_run)
    start_time = time.time()

    # Validate Gemini key
    gemini_key = os.environ.get("GEMINI_API_KEY")
    if not gemini_key:
        logger.error("GEMINI_API_KEY env var is not set")
        sys.exit(1)
    logger.info("GEMINI_API_KEY is set (length=%d)", len(gemini_key))

    # Connect to Supabase
    db = SupabaseDB()

    # Read all companies
    all_companies = db.get_all_companies()
    logger.info("Read %d companies from database", len(all_companies))

    if not all_companies:
        logger.error("No companies found in database")
        sys.exit(1)

    # Select rotation batch (oldest bear_eval_at first, NULLs first)
    top_equities = select_rotation_batch(all_companies)
    logger.info("Selected %d tickers for bear evaluation (rotation by bear_eval_at)", len(top_equities))

    if not top_equities:
        logger.warning("No in-screen non-excluded tickers found. Nothing to do.")
        return

    # Build equity data blocks
    equity_blocks = []
    for company in top_equities:
        ticker = (company.get("ticker") or "").strip()
        block = build_equity_block(company)
        equity_blocks.append(block)
        logger.info("  %s", ticker)

    # Build prompt
    prompt = build_bear_prompt(equity_blocks)
    logger.info("Prompt length: %d chars for %d equities", len(prompt), len(equity_blocks))

    if args.dry_run:
        logger.info("[DRY RUN] Prompt:\n%s", prompt[:2000] + "..." if len(prompt) > 2000 else prompt)

    # Call Gemini
    logger.info("Calling Gemini %s...", GEMINI_MODEL)
    response_text = call_gemini_bear(prompt, gemini_key, logger)
    if response_text is None:
        logger.error("Gemini call failed. No results to write.")
        sys.exit(1)

    logger.info("Gemini response length: %d chars", len(response_text))
    logger.info("Gemini response preview: %s", response_text[:1000])

    if args.dry_run:
        logger.info("[DRY RUN] Gemini response:\n%s", response_text)

    # Parse results
    verdicts = parse_bear_results(response_text)
    logger.info("Parsed %d verdicts from Gemini response", len(verdicts))

    if not verdicts:
        logger.error("No verdicts parsed! Response may not match expected format.")
        logger.error("First 2000 chars of response:\n%s", response_text[:2000])
        sys.exit(1)

    passed = sum(1 for v in verdicts.values() if "\u2705" in v)
    failed = sum(1 for v in verdicts.values() if "\u274c" in v)
    logger.info("Results: %d pass, %d fail", passed, failed)

    if args.dry_run:
        for ticker, verdict in verdicts.items():
            logger.info("  %s: %s", ticker, verdict)
        logger.info("[DRY RUN] Complete. No writes performed.")
        return

    # Write verdicts for top equities
    today_str = date.today().isoformat()
    matched = 0
    for company in top_equities:
        ticker = (company.get("ticker") or "").strip()
        verdict = verdicts.get(ticker)
        if verdict:
            db.upsert_company(ticker, {
                "bear_eval": verdict,
                "bear_eval_at": today_str,
            })
            matched += 1
        else:
            logger.warning("No verdict found for %s", ticker)

    logger.info("Writing %d verdicts", matched)

    elapsed = time.time() - start_time
    logger.info(
        "=== Bear Evaluation complete. %d/%d verdicts written. (%.1fs) ===",
        matched, len(top_equities), elapsed,
    )


if __name__ == "__main__":
    main()
