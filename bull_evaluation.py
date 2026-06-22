#!/usr/bin/env python3
"""
Bull Evaluation — The Smash-Hit Scout.

Sends 100 in-screen tickers per run to Claude Opus 4.6 for a
growth/venture equity audit. Selection is rotation-based: oldest
``bull_eval_at`` first (NULLs first), so every screen ticker is
revisited every ~5 days at the daily cadence.

Schedule: daily 04:30 UTC (after bear_evaluation).
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

from db import SupabaseDB, NULL_VALUE

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CLAUDE_MODEL = "claude-opus-4-6"
CLAUDE_TIMEOUT = 300  # seconds
MAX_RETRIES = 3
RETRY_DELAY = 15
TOP_N = 300  # stalest Tier-1 names refreshed per run (rotation batch)

# Columns to EXCLUDE from the data sent to Claude
EXCLUDED_COLUMNS = {
    "status", "composite_score", "price", "ps_now",
    "price_pct_of_52w_high",
    "perf_52w_vs_spy", "rating", "ai_analyzed_at", "data_updated_at",
    "scored_at", "bear_eval", "bull_eval", "history_json",
    "sort_order", "in_tv_screen", "created_at", "updated_at",
    "flags",
}

# ---------------------------------------------------------------------------
# Bull prompt — The Smash-Hit Scout
# ---------------------------------------------------------------------------

BULL_PROMPT_TEMPLATE = """\
Role: You are a Growth-Focused Venture Equity Analyst. Your mission is to find \
"Smash Hits"\u2014companies with powerful fundamental trajectories operating in \
massive or rapidly expanding verticals. You are looking for the next dominant \
category leaders.

Your Objective: Review every ticker. Assign either a Green Tick (\u2705) or a \
Red Cross (\u274c) to each one.

Evaluation Framework:

The Internal Engine: Use only the provided data/analysis to evaluate the company's \
specific trajectory (revenue acceleration, margin expansion, or competitive wins).

The External Context: You may use your internal knowledge of industry sectors \
(e.g., AdTech, SaaS, BioTech, Energy) to provide context on market size, sector \
difficulty, and whether the vertical has "Smash Hit" potential.

The "Green Tick" (\u2705) Criteria:
Assign a \u2705 only if the company meets both of these requirements:

Fundamental Velocity: The provided data shows a company "firing on all cylinders" \
(e.g., accelerating sales, dominant product-market fit, or structural efficiency).

High-Ceiling Vertical: Based on your industry knowledge, the company operates in \
a sector that is either massive or poised for a generational shift. It isn't just \
a "good business"; it's a business that could be 10x larger in a decade.

The "Red Cross" (\u274c) Criteria:
Assign a \u274c if:

Small Pond: The company is performing well but in a niche, stagnant, or "difficult" \
sector with limited upside (e.g., high-competition/low-margin legacy industries).

Friction: The provided analysis mentions slowing momentum or "ceiling" effects.

"Just a Business": The company is solid but lacks the "Smash Hit" DNA\u2014it's an \
incremental grower, not a category disruptor.

Output Format:
For every stock in the list, provide the result in this exact format. \
Use the EXACT ticker as shown in the data header (including numbers and slashes):

TICKER: \u2705 (Briefly explain why this vertical/trajectory combo could be a \
"Smash Hit")

TICKER: \u274c (Briefly explain why it lacks the "Smash Hit" potential, citing \
sector headwinds or fundamental friction)

Strict Constraints:

AI is Secondary: Treat AI as just one possible tool for growth, not the sole requirement.

Data Integrity: Do not invent company-specific data; use only what is provided.

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
    log_file = log_dir / f"bull_eval_{date.today().isoformat()}.txt"

    logger = logging.getLogger("bull_evaluation")
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


def select_rotation_batch(companies, top_n=TOP_N):
    """Pick the next batch of in-screen tickers ordered by staleness.

    Filter: in_tv_screen=True AND status doesn't start with ❌ (skips
    not-in-screen + red-flagged rows). Sort: bull_eval_at ascending with
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

    # Sort: NULLs/empty bull_eval_at first, then ascending date string.
    # ISO date strings sort lexicographically, so a string compare works.
    def _sort_key(c):
        evaled = c.get("bull_eval_at")
        return (0 if not evaled else 1, str(evaled or ""))

    candidates.sort(key=_sort_key)
    return candidates[:top_n]


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------


def build_equity_block(company, excluded=EXCLUDED_COLUMNS):
    """Format a single equity's data for the prompt."""
    ticker = company.get("ticker", "")
    company_name = company.get("company_name", "")

    lines = [f"--- {ticker} ({company_name}) ---"]
    for col_name in sorted(company.keys()):
        if col_name in excluded or col_name.startswith("_"):
            continue
        # Skip the ticker and company_name since they're in the header
        if col_name in ("ticker", "company_name"):
            continue
        val = company.get(col_name)
        if val is None or val == "" or val == NULL_VALUE:
            continue
        val_str = str(val).strip()
        if not val_str:
            continue
        lines.append(f"  {col_name}: {val_str}")

    return "\n".join(lines)


def build_bull_prompt(equity_blocks):
    """Assemble the full bull prompt with all equity data."""
    equity_data = "\n\n".join(equity_blocks)
    return BULL_PROMPT_TEMPLATE.format(
        count=len(equity_blocks),
        equity_data=equity_data,
    )


# ---------------------------------------------------------------------------
# Claude API (Anthropic)
# ---------------------------------------------------------------------------


def _call_claude(prompt, api_key, model, timeout=CLAUDE_TIMEOUT):
    """Call Claude via curl subprocess, return raw JSON response."""
    url = "https://api.anthropic.com/v1/messages"
    payload = json.dumps({
        "model": model,
        "max_tokens": 32768,
        "temperature": 0.2,
        "messages": [{"role": "user", "content": prompt}],
    })
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(payload)
        payload_path = f.name
    try:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST", url,
             "-H", "Content-Type: application/json",
             "-H", f"x-api-key: {api_key}",
             "-H", "anthropic-version: 2023-06-01",
             "-d", f"@{payload_path}",
             "--max-time", str(timeout)],
            capture_output=True, text=True, timeout=timeout + 10,
        )
        return result.stdout
    finally:
        os.unlink(payload_path)


def call_claude_bull(prompt, api_key, logger):
    """Call Claude with retries, return response text or None."""
    for attempt in range(MAX_RETRIES):
        try:
            raw = _call_claude(prompt, api_key, CLAUDE_MODEL)
            if not raw or not raw.strip():
                raise Exception("Empty response from curl (possible timeout)")
            logger.info("Raw API response length: %d chars", len(raw))
            data = json.loads(raw)
            if data.get("type") == "error":
                err = data.get("error", {})
                raise Exception(
                    f"{err.get('type', 'unknown')}: {err.get('message', '')}"
                )
            # Claude Messages API: content is a list of content blocks
            content_blocks = data.get("content", [])
            text_parts = [b["text"] for b in content_blocks if b.get("type") == "text"]
            text = "\n".join(text_parts).strip()
            if not text:
                raise Exception("Empty response text from Claude")

            stop = data.get("stop_reason", "")
            logger.info("Claude stop_reason: %s", stop)
            if stop == "max_tokens":
                logger.warning("Response was truncated (hit max_tokens)!")

            return text

        except Exception as exc:
            exc_str = str(exc)
            if attempt < MAX_RETRIES - 1:
                delay = RETRY_DELAY if "overloaded" in exc_str or "rate" in exc_str.lower() else 5
                logger.warning(
                    "Claude call failed (attempt %d/%d), retrying in %ds: %s",
                    attempt + 1, MAX_RETRIES, delay, exc,
                )
                time.sleep(delay)
            else:
                logger.error(
                    "Claude call failed (attempt %d/%d), giving up: %s",
                    attempt + 1, MAX_RETRIES, exc,
                )
                return None

    return None


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------


def parse_bull_results(response_text):
    """
    Parse Claude response into {ticker: verdict_string} dict.

    Handles tickers that start with letters, numbers, or contain slashes.
    Examples: NVDA, 6857, VISTA/A, A3EGAB, 896047
    """
    results = {}
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

    parser = argparse.ArgumentParser(description="Bull Evaluation - Smash-Hit Scout")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print prompt and results without writing to the database")
    parser.add_argument("--tier1", action="store_true",
                        help="Evaluate the full Level 0 Tier-1 universe (writes "
                             "ai_analysis only), not just the legacy companies/in_tv_screen set")
    args = parser.parse_args()

    logger = setup_logging()
    logger.info("=== Bull Evaluation started (dry_run=%s, tier1=%s) ===",
                args.dry_run, args.tier1)
    start_time = time.time()

    # Validate Claude API key
    claude_key = os.environ.get("ANTHROPIC_API_KEY")
    if not claude_key:
        logger.error("ANTHROPIC_API_KEY env var is not set")
        sys.exit(1)
    logger.info("ANTHROPIC_API_KEY is set (length=%d)", len(claude_key))

    # Connect to Supabase
    db = SupabaseDB()
    # Rotate over the full Tier-1 universe from Level 0 (ai_analysis clock). The
    # legacy `companies` rotation path is retired — ai_analysis is the only home.
    import level0_eval
    top_equities = level0_eval.tier1_eval_candidates(db, "bull", TOP_N)
    logger.info("Selected %d Tier-1 tickers for bull evaluation (rotation by ai_analysis.bull_at)", len(top_equities))

    if not top_equities:
        logger.warning("No in-screen non-excluded tickers found. Nothing to do.")
        return

    # Build equity data blocks
    equity_blocks = []
    for company in top_equities:
        ticker = company["ticker"]
        block = build_equity_block(company)
        equity_blocks.append(block)
        logger.info("  %s  (last bull_eval_at: %s)", ticker, company.get("bull_eval_at") or "never")

    # Build prompt
    prompt = build_bull_prompt(equity_blocks)
    logger.info("Prompt length: %d chars for %d equities", len(prompt), len(equity_blocks))

    if args.dry_run:
        logger.info("[DRY RUN] Prompt:\n%s", prompt[:2000] + "..." if len(prompt) > 2000 else prompt)

    # Call Claude
    logger.info("Calling Claude %s...", CLAUDE_MODEL)
    response_text = call_claude_bull(prompt, claude_key, logger)
    if response_text is None:
        logger.error("Claude call failed. No results to write.")
        sys.exit(1)

    logger.info("Claude response length: %d chars", len(response_text))
    logger.info("Claude response preview: %s", response_text[:1000])

    if args.dry_run:
        logger.info("[DRY RUN] Claude response:\n%s", response_text)

    # Parse results
    verdicts = parse_bull_results(response_text)
    logger.info("Parsed %d verdicts from Claude response", len(verdicts))

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

    # Write verdicts for the rotation batch
    today_str = date.today().isoformat()
    matched = 0
    updates = []
    for company in top_equities:
        ticker = company["ticker"]
        verdict = verdicts.get(ticker)
        if verdict:
            updates.append({
                "ticker": ticker,
                "bull_eval": verdict,
                "bull_eval_at": today_str,
            })
            matched += 1
        else:
            logger.warning("No verdict found for %s", ticker)

    logger.info("Writing %d verdicts", matched)
    if updates:
        # ai_analysis is the Level 0 home (migrations 053/054) and now the sole
        # home: write the bull verdict + its rotation clock (bull_at).
        db.upsert_ai_analysis_batch([
            {"ticker": u["ticker"], "bull_eval": u["bull_eval"],
             "bull_at": u["bull_eval_at"], "analyzed_at": u["bull_eval_at"]}
            for u in updates
        ])

    # Log the run
    elapsed = time.time() - start_time
    db.log_run("bull_evaluation", {
        "updated": matched,
        "skipped": len(top_equities) - matched,
        "errors": 0,
        "duration_secs": round(elapsed, 1),
        "details": {
            "total_companies": len(companies),
            "batch_size": len(top_equities),
            "verdicts_parsed": len(verdicts),
            "passed": passed,
            "failed": failed,
        },
    })

    logger.info(
        "=== Bull Evaluation complete. %d/%d verdicts written. (%.1fs) ===",
        matched, len(top_equities), elapsed,
    )


if __name__ == "__main__":
    main()
