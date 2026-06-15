#!/usr/bin/env python3
"""
AI Narrative Updater — Supabase edition.

Reads the companies table, identifies stale/unanalysed companies,
generates fresh narrative content via Gemini + SerpAPI web search,
and writes results back to the database.
"""

import argparse
import json
import logging
import os
import sys
import re
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from dateutil import parser as dateparser
from dotenv import load_dotenv

from db import SupabaseDB

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

STALENESS_DAYS = 90
# Per-run cap for --tier1 rotation (Stage A2): narrate the N oldest Tier-1
# names each run so the first pass over the ~3k universe doesn't fire thousands
# of LLM calls at once — keeps daily cost flat, never-narrated names go first.
TIER1_NARRATIVE_BATCH = 100
SERPAPI_ENDPOINT = "https://serpapi.com/search"
GEMINI_MODEL = "gemini-2.5-flash"
DELAY_BETWEEN_CALLS = 2  # seconds between tickers
RETRY_DELAY = 10  # seconds between retries
MAX_RETRIES = 2  # total attempts per ticker

NULL_VALUE = "\u2014"  # em-dash for missing data

# Financial column keys used to build prompt context.
# These are the Supabase column names.
FINANCIAL_HEADERS = [
    "r40_score",
    "fundamentals_snapshot",
    "annual_revenue_5y",
    "quarterly_revenue",
    "rev_growth_ttm_pct",
    "rev_growth_qoq_pct",
    "rev_cagr_pct",
    "rev_consistency_score",
    "gross_margin_pct",
    "gm_trend_pct",
    "operating_margin_pct",
    "net_margin_pct",
    "net_margin_yoy_pct",
    "fcf_margin_pct",
    "opex_pct_of_revenue",
    "sm_rd_pct_of_revenue",
    "rule_of_40",
    "qrtrs_to_profitability",
    "eps_only",
    "eps_yoy_pct",
]

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------


def setup_logging() -> logging.Logger:
    today_str = date.today().isoformat()
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"update_log_{today_str}.txt"

    logger = logging.getLogger("ai_narrative_updater")
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
# SerpAPI web search
# ---------------------------------------------------------------------------


def serpapi_search(query: str, api_key: str, logger: logging.Logger) -> str:
    """Run a SerpAPI Google search and return concatenated snippets."""
    try:
        resp = requests.get(
            SERPAPI_ENDPOINT,
            params={"q": query, "api_key": api_key, "num": 5, "engine": "google"},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("SerpAPI search failed for query '%s': %s", query, exc)
        return ""

    organic = data.get("organic_results", [])
    snippets = []
    total_chars = 0
    for result in organic[:5]:
        snippet = result.get("snippet", "")
        title = result.get("title", "")
        entry = f"- {title}: {snippet}"
        if total_chars + len(entry) > 2000:
            break
        snippets.append(entry)
        total_chars += len(entry)

    return "\n".join(snippets)


# Map terse flag keywords to natural-language search terms
_EVENT_TYPE_MAP = {
    "margin swing":   "one-time charge margin impact",
    "other inc/exp":  "other income expense non-recurring charge",
    "write-down":     "write-down impairment",
    "restructuring":  "restructuring charge",
    "settlement":     "legal settlement",
    "acquisition":    "acquisition one-time cost",
    "divestiture":    "divestiture asset sale",
    "goodwill":       "goodwill impairment write-off",
    "tax":            "one-time tax benefit charge",
    "ipo":            "IPO related expenses",
    "sbc":            "stock-based compensation charge",
}

# Quarter mapping from month numbers
_MONTH_TO_QUARTER = {
    "01": "Q1", "02": "Q1", "03": "Q1",
    "04": "Q2", "05": "Q2", "06": "Q2",
    "07": "Q3", "08": "Q3", "09": "Q3",
    "10": "Q4", "11": "Q4", "12": "Q4",
}


def _build_event_search_query(company: str, ticker: str, event_text: str) -> str:
    """Turn terse analyst flag text into a useful Google search query.

    Flags look like: '\u2b07 margin swing -22pp vs norm (2025-09)'
    We want: 'Celsius Holdings CELH one-time charge margin impact Q3 2025'
    """
    # Extract date if present -- formats like (2025-09) or (2024-12)
    date_match = re.search(r"\((\d{4})-(\d{2})\)", event_text)
    quarter_str = ""
    if date_match:
        year = date_match.group(1)
        month = date_match.group(2)
        quarter_str = f"{_MONTH_TO_QUARTER.get(month, '')} {year}"

    # Find matching event type from our map
    event_lower = event_text.lower()
    search_terms = "one-time non-recurring charge"  # default
    for key, val in _EVENT_TYPE_MAP.items():
        if key in event_lower:
            search_terms = val
            break

    return f"{company} {ticker} {search_terms} {quarter_str}".strip()


def gather_web_context(
    company: str, ticker: str, api_key: str, logger: logging.Logger,
    one_time_event: str = "",
) -> str:
    """Run SerpAPI searches and merge results.

    When a one_time_event flag is provided, runs an additional targeted search
    to find context about the specific event (write-down, settlement, etc.).
    """
    current_year = date.today().year
    prev_year = current_year - 1

    q1 = f"{company} {ticker} earnings results {prev_year} {current_year}"
    q2 = f"{company} {ticker} outlook forecast analyst {current_year}"

    s1 = serpapi_search(q1, api_key, logger)
    time.sleep(1)
    s2 = serpapi_search(q2, api_key, logger)

    parts = []
    if s1:
        parts.append(f"EARNINGS SEARCH:\n{s1}")
    if s2:
        parts.append(f"OUTLOOK SEARCH:\n{s2}")

    # Targeted search for the one-time event to give the model real context
    if one_time_event:
        q3 = _build_event_search_query(company, ticker, one_time_event)
        time.sleep(1)
        s3 = serpapi_search(q3, api_key, logger)
        if s3:
            parts.append(f"ONE-TIME EVENT SEARCH:\n{s3}")
            logger.info("  Found web context for one-time event on %s", ticker)

    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Gemini prompt & call
# ---------------------------------------------------------------------------

PROMPT_TEMPLATE = """\
You are a financial analyst writing brief, data-driven narratives for a stock tracking spreadsheet.

COMPANY: {company_name} ({ticker})
FINANCIAL DATA FROM SPREADSHEET:
{financial_data_summary}

{web_section}

EXAMPLES OF THE DESIRED FORMAT (use these as style guides):

--- EXAMPLE 1 (STEP - StepStone Group) ---
Short Outlook: \U0001f7e2 Strong fundraising and fee growth driving record assets under management.
Full Outlook: Reported Q3 FY26 earnings on Feb 5, 2026, showing strong fee-related earnings growth driven by record AUM from robust fundraising. As an established, profitable asset manager, GAAP earnings can be volatile due to performance fees. However, the consistent expansion of management fees from sticky, long-term capital provides a stable and growing earnings base, supporting a positive fundamental outlook.
Key Risks: \U0001f7e1 Performance fee volatility and fundraising slowdown in an economic downturn.

--- EXAMPLE 2 (GTLB - GitLab) ---
Short Outlook: \U0001f7e2 Strong revenue growth and high margins; enterprise adoption is key.
Full Outlook: Latest earnings (Dec 4, 2025) showed strong 30% YoY revenue growth. Exceptional 91% gross margins are funding growth, with operating leverage improving. While still unprofitable on a GAAP basis due to high R&D and S&M spend (incl. SBC), losses are narrowing. Adoption of AI features and enterprise tiers should drive the company towards GAAP profitability within the next 1-2 years.
Key Risks: \U0001f7e1 Intense competition from Microsoft/GitHub and macroeconomic spending pressures.

--- EXAMPLE 3 (ADI - Analog Devices, cautious) ---
Short Outlook: \U0001f7e1 Cautious guidance as industrial market weakness and inventory correction persists.
Full Outlook: Analog Devices' Q1 FY26 earnings (Feb 18, 2026) beat lowered expectations but Q2 guidance points to continued decline. Revenue is pressured by a broad-based cyclical downturn, particularly in industrial and communications, with inventory digestion taking longer than expected. While historically strong gross margins (>60%) have compressed due to lower factory utilization, the company remains highly profitable. Recovery hinges on a second-half 2026 market rebound.
Key Risks: \U0001f7e1 Prolonged cyclical downturn and continued inventory digestion in key markets.

---

Now generate the four fields for {company_name} ({ticker}). Follow these rules exactly:

DESCRIPTION RULES:
- One sentence summarising the company's core business, products/services, and industry
- 60-80 characters
- Examples:
  "Japanese conveyor-belt sushi chain operator with global expansion"
  "LNG containment system designer for gas carriers and onshore tanks"
  "Semiconductor deposition equipment maker for advanced chip manufacturing"

SHORT OUTLOOK RULES:
- One sentence, max 15 words
- Start with \U0001f7e2 (positive), \U0001f7e1 (cautious/mixed), or \U0001f534 (negative) emoji
- Reference the single most important recent development

FULL OUTLOOK RULES:
- 3\u20135 sentences
- Reference the most recent earnings report by date if available in web search results
- Explain the fundamental earnings quality story
- Mention path to profitability if not yet profitable, or sustainability of profits if already profitable
- Do NOT use bullet points
- Do NOT quote specific percentages, dollar figures, or growth rates in the
  prose. The page already shows these in live structured fields next to the
  narrative; the narrative is regenerated only every \u224890 days while those
  fields refresh weekly, so any hard number you put in the prose will drift
  out of sync within a quarter. Use qualitative language instead: "strong
  revenue growth", "expanding margins", "approaching breakeven" \u2014 not "30%
  YoY revenue growth" or "91% gross margins".

KEY RISKS RULES:
- One sentence, max 15 words
- Start with \U0001f7e1 or \U0001f534 emoji
- Name the 1\u20132 most specific risks

Respond ONLY with a JSON object in this exact format, no markdown, no preamble:
{{
  "description": "...",
  "short_outlook": "...",
  "full_outlook": "...",
  "key_risks": "..."
}}
"""

EVENT_IMPACT_SECTION = """\

ONE-TIME EVENT FLAGGED BY ANALYST:
{one_time_event}

ADDITIONAL TASK \u2014 EVENT IMPACT ANALYSIS:
The analyst has flagged the one-time event above. Your job is to ADD VALUE beyond
what the flag already says. Do NOT just restate or paraphrase the event \u2014 the reader
can already see it. Instead:

1. USE THE WEB SEARCH RESULTS (especially the "ONE-TIME EVENT SEARCH" section) to
   identify what actually caused this event (e.g. an acquisition write-down, a legal
   settlement, a one-off IP sale, a restructuring programme, an asset impairment,
   etc.). Name the specific real-world cause.
2. ASSESS the impact: does it FLATTER (make reported numbers look better than the
   underlying business), UNDERSTATE (make them look worse), or is it NEUTRAL/MIXED?
3. QUANTIFY where possible using the financial data provided (e.g. normalised margin
   vs reported margin, adjusted EPS vs reported EPS).
4. STATE whether the effect has already lapsed or is still flowing through upcoming numbers.

Do NOT invent or speculate about events not supported by the web search results or
financial data. If you cannot identify the specific cause, focus on the quantified
impact and say the cause is unclear.

EVENT IMPACT RULES:
- Start with \U0001f534 if it flatters (inflates) metrics \u2014 this is a warning
- Start with \U0001f7e2 if it understates (depresses) metrics \u2014 hidden upside
- Start with \U0001f7e1 if neutral or mixed impact
- Then briefly name the real-world cause (from web results) and quantify the effect
- 2-3 sentences max
- Do NOT repeat back the analyst's flag text \u2014 add new information

Example outputs:
  "\U0001f534 Flatters margins +4pp \u2014 one-off $120M patent licensing payment from Samsung in Q3 boosted GM to 52% vs ~48% normalised. Already lapsed; Q4 margins will revert."
  "\U0001f7e2 Understates EPS by ~$0.35 \u2014 $45M restructuring charge relates to closure of Austin fab announced Oct 2025. Non-recurring; adj. EPS ~$1.20 vs reported $0.85. Charge completes Q1 2026."
  "\U0001f7e1 Mixed \u2014 Kinaxis acquisition (closed Aug 2025) adds ~$80M/qtr revenue but $25M integration costs depress margins ~2pp. Costs expected to taper over 3 quarters."
"""

EVENT_IMPACT_JSON_ADDITION = """\
Include this additional field in your JSON response:
  "event_impact": "..."
"""


def build_financial_summary(company: dict) -> str:
    """Format financial columns from a company dict into readable text for the prompt."""
    lines = []
    for col_name in FINANCIAL_HEADERS:
        val = company.get(col_name)
        if val is not None and str(val).strip() and str(val).strip() != NULL_VALUE:
            lines.append(f"  {col_name}: {val}")
    return "\n".join(lines) if lines else "  (no financial data available)"


def _call_gemini_subprocess(prompt: str, api_key: str, model: str, timeout: int = 90) -> str:
    """Call Gemini via curl subprocess with a hard OS timeout."""
    import subprocess, tempfile
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json"},
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


def call_gemini(prompt: str, api_key: str, logger: logging.Logger) -> dict | None:
    """Call Gemini via curl subprocess with hard timeout, retries on failure."""
    for attempt in range(MAX_RETRIES):
        try:
            raw = _call_gemini_subprocess(prompt, api_key, GEMINI_MODEL)
            data = json.loads(raw)
            if "error" in data:
                raise Exception(f"{data['error'].get('code')} {data['error'].get('message','')}")
            text = data["candidates"][0]["content"]["parts"][0]["text"].strip()

            # Strip markdown fences if present (fallback for non-JSON mode)
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3].strip()
            if text.startswith("json"):
                text = text[4:].strip()

            try:
                result = json.loads(text)
            except json.JSONDecodeError:
                logger.warning("Gemini returned non-JSON: %s", text[:200])
                return None

            required_keys = {"description", "short_outlook", "full_outlook", "key_risks"}
            missing = required_keys - set(result.keys())
            if missing:
                logger.warning("Gemini response missing keys: %s (got: %s)", missing, list(result.keys()))
                return None
            empty = [k for k in required_keys if not result.get(k)]
            if empty:
                logger.warning("Gemini response has empty values for: %s — accepting partial result", empty)
                for k in empty:
                    result[k] = "N/A"

            return result

        except Exception as exc:
            exc_str = str(exc)
            if attempt < MAX_RETRIES - 1:
                # Use longer delay for rate limits (429)
                delay = RETRY_DELAY if "429" in exc_str or "RESOURCE_EXHAUSTED" in exc_str else 5
                logger.warning(
                    "Gemini call failed (attempt %d/%d), retrying in %ds: %s",
                    attempt + 1, MAX_RETRIES, delay, exc,
                )
                time.sleep(delay)
            else:
                logger.error("Gemini call failed (attempt %d/%d), skipping: %s",
                             attempt + 1, MAX_RETRIES, exc)
                return None

    return None


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------


def process_company(
    company: dict,
    serpapi_key: str,
    dry_run: bool,
    logger: logging.Logger,
) -> dict | None:
    """
    Process a single company dict. Returns the update fields dict for writing,
    or None on failure.
    """
    ticker = company.get("ticker", "").strip()
    company_name = company.get("company_name", "").strip()

    logger.info("Processing %s (%s)", ticker, company_name)

    # Check for one-time events (before web search so we can target the search)
    one_time_event_text = (company.get("one_time_events") or "").strip()
    if one_time_event_text == NULL_VALUE:
        one_time_event_text = ""

    # Web search (includes targeted event search when one_time_event is present)
    web_context = ""
    if serpapi_key:
        web_context = gather_web_context(
            company_name, ticker, serpapi_key, logger,
            one_time_event=one_time_event_text,
        )

    web_section = ""
    if web_context:
        web_section = f"RECENT WEB SEARCH RESULTS:\n{web_context}"
    else:
        web_section = "(No recent web search results available \u2014 rely on financial data.)"

    # Build prompt
    fin_summary = build_financial_summary(company)
    prompt = PROMPT_TEMPLATE.format(
        company_name=company_name,
        ticker=ticker,
        financial_data_summary=fin_summary,
        web_section=web_section,
    )

    # Inject one-time event analysis if present
    has_event = bool(one_time_event_text)
    if has_event:
        event_section = EVENT_IMPACT_SECTION.format(one_time_event=one_time_event_text)
        prompt = prompt.replace(
            'Respond ONLY with a JSON object in this exact format, no markdown, no preamble:',
            event_section + '\n' + EVENT_IMPACT_JSON_ADDITION + '\nRespond ONLY with a JSON object in this exact format, no markdown, no preamble:',
        )
        # Update the JSON template in the prompt to include event_impact
        prompt = prompt.replace(
            '  "key_risks": "..."\n}',
            '  "key_risks": "...",\n  "event_impact": "..."\n}',
        )
        logger.info("  One-time event detected for %s: %s", ticker, one_time_event_text[:80])

    if dry_run:
        logger.info("[DRY RUN] Prompt for %s:\n%s", ticker, prompt[:500] + "...")

    # Call Gemini
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    result = call_gemini(prompt, gemini_key, logger)
    if result is None:
        return None

    if dry_run:
        logger.info("[DRY RUN] Gemini result for %s:\n%s",
                     ticker, json.dumps(result, indent=2, ensure_ascii=False))
        return None  # don't write in dry-run mode

    today_str = date.today().isoformat()

    # Build the update payload for Supabase
    update_fields = {
        "description": result["description"],
        "short_outlook": result["short_outlook"],
        "full_outlook": result["full_outlook"],
        "key_risks": result["key_risks"],
        "ai_analyzed_at": today_str,
    }

    # Write event_impact if we requested it and got a response
    if has_event and result.get("event_impact"):
        update_fields["event_impact"] = result["event_impact"]
    elif not has_event:
        # Clear stale event_impact if one_time_events is now empty
        update_fields["event_impact"] = None

    return update_fields


def main():
    load_dotenv()

    parser = argparse.ArgumentParser(description="AI Narrative Updater")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print prompts and results without writing to the database")
    parser.add_argument("--ticker", type=str, default=None,
                        help="Process only this specific ticker")
    parser.add_argument("--force", action="store_true",
                        help="Ignore staleness and refresh all tickers")
    parser.add_argument("--tier1", action="store_true",
                        help="Narrate the full Level 0 Tier-1 universe (writes "
                             "ai_analysis only), oldest-narrated first, capped per run")
    args = parser.parse_args()

    logger = setup_logging()
    logger.info("=== AI Narrative Updater started (dry_run=%s) ===", args.dry_run)
    start_time = time.time()

    # Validate Gemini key
    gemini_key = os.environ.get("GEMINI_API_KEY")
    if not gemini_key:
        logger.error("GEMINI_API_KEY env var is not set")
        sys.exit(1)

    serpapi_key = os.environ.get("SERPAPI_API_KEY", "")
    if not serpapi_key:
        logger.warning("SERPAPI_API_KEY not set — will skip web searches")

    # Connect to Supabase
    db = SupabaseDB()

    # Get companies needing update
    if args.ticker:
        company = db.get_company(args.ticker)
        if not company:
            logger.error("Ticker %s not found in database", args.ticker)
            sys.exit(1)
        companies_to_update = [company]
        logger.info("Single-ticker mode: processing %s", args.ticker)
    elif args.tier1:
        # Stage A2: narrate the full Tier-1 universe, oldest-narrated first.
        # Capped per run (rotation) so the first pass over ~3k names doesn't
        # fire thousands of LLM calls at once — keeps the daily cost flat.
        import level0_eval
        companies_to_update = level0_eval.tier1_eval_candidates(
            db, "narrative", TIER1_NARRATIVE_BATCH)
        logger.info("Tier-1 mode: narrating %d oldest names (cap %d)",
                    len(companies_to_update), TIER1_NARRATIVE_BATCH)
    elif args.force:
        companies_to_update = db.get_all_companies()
        logger.info("Force mode: refreshing all %d companies", len(companies_to_update))
    else:
        companies_to_update = db.get_stale_companies("ai_analyzed_at", STALENESS_DAYS)

    logger.info("Found %d companies needing update", len(companies_to_update))

    if not companies_to_update:
        logger.info("Nothing to do — all companies are up to date.")
        return

    # Process each company
    total_written = 0
    errors = 0
    for idx, company in enumerate(companies_to_update):
        ticker = company.get("ticker", "?")
        try:
            update_fields = process_company(
                company, serpapi_key, args.dry_run, logger
            )
            if update_fields and not args.dry_run:
                # ai_analysis is the Level 0 home (migrations 053/054): always
                # write the narrative + its rotation clock (narrated_at). In
                # --tier1 mode that's the only write (the name may not exist in
                # companies); otherwise dual-write companies for legacy surfaces.
                if not args.tier1:
                    db.upsert_company(ticker, update_fields)
                db.upsert_ai_analysis(ticker, {
                    "short_outlook": update_fields.get("short_outlook"),
                    "full_outlook": update_fields.get("full_outlook"),
                    "key_risks": update_fields.get("key_risks"),
                    "event_impact": update_fields.get("event_impact"),
                    "narrated_at": update_fields.get("ai_analyzed_at"),
                    "analyzed_at": update_fields.get("ai_analyzed_at"),
                })
                total_written += 1
                logger.info("  Wrote update for %s", ticker)
            elif not update_fields and not args.dry_run:
                errors += 1
        except Exception as exc:
            logger.error("Error processing %s: %s", ticker, exc, exc_info=True)
            errors += 1

        # Delay between API calls (skip after last)
        if idx < len(companies_to_update) - 1:
            time.sleep(DELAY_BETWEEN_CALLS)

    elapsed = time.time() - start_time
    if args.dry_run:
        logger.info("=== DRY RUN complete. %d companies processed in %.1fs ===",
                     len(companies_to_update), elapsed)
    else:
        logger.info(
            "=== Updated %d companies. Skipped %d due to errors. (%.1fs) ===",
            total_written, errors, elapsed,
        )


if __name__ == "__main__":
    main()
