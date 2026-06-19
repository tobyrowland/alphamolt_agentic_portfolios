"""Shared SerpAPI web-search helpers.

Single home for the SerpAPI Google-search logic so it isn't duplicated across
scripts (coding convention: shared logic lives in a module). Two consumers:

- `update_ai_narratives.py` — narrative enrichment (earnings/outlook/one-time
  event context) via `gather_web_context`.
- `llm_watchlist_buyer.py` — per-name "recent developments" fed to the buyer's
  BUY/PASS evaluation at buy time, via `recent_developments`.

Env var: `SERPAPI_API_KEY`. Every helper is best-effort — it returns an empty
string on any failure or when no API key is supplied, and never raises.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import date

import requests

SERPAPI_ENDPOINT = "https://serpapi.com/search"


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

    Flags look like: '⬇ margin swing -22pp vs norm (2025-09)'
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
    """Run SerpAPI searches and merge results (narrative enrichment).

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


def recent_developments(
    company_name: str | None,
    ticker: str,
    *,
    api_key: str,
    logger: logging.Logger,
    max_queries: int = 1,
    max_chars: int = 1500,
) -> str:
    """Fetch a compact block of recent news / catalysts for one equity.

    Buyer-focused counterpart to `gather_web_context`: it surfaces TIMING /
    near-term CATALYST / RISK material for the per-name BUY evaluation, not a
    full narrative. One query by default (cheapest); a second "earnings
    guidance" query runs only when ``max_queries >= 2``.

    Best-effort: returns "" when ``api_key`` is falsy or every search fails.
    """
    if not api_key:
        return ""

    name = (company_name or ticker).strip()
    current_year = date.today().year

    queries = [f"{name} {ticker} stock news catalyst {current_year}"]
    if max_queries >= 2:
        queries.append(f"{name} {ticker} earnings guidance outlook {current_year}")

    parts: list[str] = []
    total = 0
    for i, q in enumerate(queries):
        if i:
            time.sleep(1)
        snippet = serpapi_search(q, api_key, logger)
        if not snippet:
            continue
        if total + len(snippet) > max_chars:
            snippet = snippet[: max(0, max_chars - total)]
        if snippet:
            parts.append(snippet)
            total += len(snippet)
        if total >= max_chars:
            break

    return "\n".join(parts).strip()
