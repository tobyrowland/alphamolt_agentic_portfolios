"""LLM-driven watchlist buyer strategy — high-conviction BUYs only.

The thinking counterpart of `agent_strategies.rebalance_watchlist_buyer`
(equal-weight, mechanical). For each watchlist ticker the strategy
calls a frontier model with the full extended-tier data + the
portfolio's mandate (the single `portfolios.description` brief), and
expects a per-equity verdict (BUY|PASS, conviction 1-5, thesis_text,
extend_signals, break_signals). Only ``conviction == 5`` names trade;
they get ranked by a second LLM call and bought in order at 4% of
portfolio value per position until cash runs out.

Module structure mirrors `llm_picker.py` so the lazy-import shell in
`agent_strategies.py` stays thin and the heavy SDK + threading
dependencies only load when this strategy actually runs.
"""

from __future__ import annotations

import json
import logging
import math
import os
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from typing import Any

from agent_strategies import RebalanceContext, RebalanceResult
from llm_picker import (
    _mandate_block,
    _parse_with_retry,
)
from llm_providers import LLMProviderError, call_llm
from portfolio import PortfolioError
from web_search import recent_developments


# Narrative + AI-overlay fields pulled from the legacy `companies` row to
# enrich a Level 0-sourced candidate when they exist (they only exist for
# names the legacy pipeline narrated/evaluated). Absent → the buyer evaluates
# on quantitative facts alone.
_COMPANY_NARRATIVE_FIELDS = (
    "short_outlook", "key_risks", "full_outlook", "bull_eval", "bear_eval",
)


def _load_company_narratives(db, tickers) -> dict[str, dict]:
    """Map ticker -> AI narrative row for the given tickers (one query).

    Reads the Level 0 `ai_analysis` table (migration 053), so the enrichment
    covers any Tier-1 name once evaluated — not just the legacy companies set.
    Best-effort: returns {} on error so the buyer still evaluates on facts alone.
    """
    return db.get_ai_analysis(tickers)


def _build_equity_data(fact_row: dict, company: dict | None) -> dict:
    """Assemble the per-ticker ``equity_data`` the LLM evaluator sees, from a
    Level 0 screen fact row (the same data the screener ranked on) + the legacy
    ``companies`` narrative where it exists.

    Shape mirrors the old universe-snapshot entry closely enough that the
    prompt reads naturally; ``narrative.bull_eval`` / ``bear_eval`` keep the
    keys ``_evaluate_ticker`` looks for (None when the name was never narrated).
    """
    company = company or {}
    narrative = {f: company.get(f) for f in _COMPANY_NARRATIVE_FIELDS}
    return {
        "ticker": fact_row.get("ticker"),
        "company_name": fact_row.get("name") or company.get("company_name"),
        "sector": fact_row.get("sector"),
        "country": fact_row.get("country"),
        "fundamentals": {
            "rule_of_40": fact_row.get("rule_of_40"),
            "rev_growth_ttm_pct": fact_row.get("rev_growth_ttm"),
            "gross_margin_pct": fact_row.get("gross_margin"),
            "operating_margin_pct": fact_row.get("operating_margin"),
            "net_margin_pct": fact_row.get("net_margin"),
            "fcf_margin_pct": fact_row.get("fcf_margin"),
        },
        "valuation": {
            "ps": fact_row.get("ps"),
            "ps_median_12m": fact_row.get("ps_median_12m"),
            # Peer-group context (migration 058): how the P/S compares to the
            # sector/industry, and the DIRECTION of the multiple (trailing-
            # quarter % change — >0 re-rating up, <0 compressing).
            "peer_ps_median": fact_row.get("peer_ps_median"),
            "peer_basis": fact_row.get("peer_basis"),
            "ps_trend_pct": fact_row.get("ps_trend_pct"),
            "price": fact_row.get("price"),
        },
        "momentum": {
            "ret_52w": fact_row.get("ret_52w"),
            "perf_52w_vs_spy": fact_row.get("perf_52w_vs_spy"),
        },
        "ai_overlay": {"bull": fact_row.get("bull"), "bear": fact_row.get("bear")},
        "narrative": narrative,
        # Shared per-equity research card (migration 055) — pre-computed business
        # analysis (scored moat / durability / earnings quality / balance-sheet
        # + base break signals) the buyer reasons over instead of re-deriving.
        "research": (company or {}).get("research_card"),
        "source": "level0",
    }

logger = logging.getLogger("llm_watchlist_buyer")


# ---------------------------------------------------------------------------
# Defaults — overridable per agent via agents.config JSONB
# ---------------------------------------------------------------------------

LLM_WATCHLIST_BUYER_DEFAULTS: dict[str, Any] = {
    "provider": "google",
    "model": "gemini-2.5-pro",
    "min_cash_pct": 2.0,            # below this, exit before any LLM work
    "target_position_pct": 4.0,     # target weight per BUY
    "min_position_pct": 2.0,        # floor on the last (partial) BUY
    "min_conviction": 5,            # hard gate
    # Screener rejection hide (migration 051): how long a PASSed-on name is
    # hidden. Short window so it tracks the daily re-rank / quarterly-earnings
    # cadence rather than outliving the reason it was passed on. (The separate
    # post-SELL re-buy cooldown stays 90d — see get_recently_sold_tickers.)
    "rejection_window_days": 30,
    "concurrency": 5,               # ThreadPoolExecutor max_workers for Phase 1
    "per_call_timeout_sec": 90,     # per-future timeout for Phase 1
    # Per-ticker output is small (~500 tokens) but Gemini 2.5 Pro's thinking
    # tokens count toward max_output_tokens. 65536 is Gemini's hard ceiling
    # and avoids the truncation trap the curator hit (PR #1045).
    "max_tokens": 65536,
    # Phase 2 is just a list of tickers; thinking still happens but output
    # is tiny.
    "max_tokens_phase2": 16384,
    "temperature": 0.2,
    "max_signals_per_kind": 5,      # cap LLM-emitted signal arrays
    # Per-name web search at buy time (SerpAPI). Each candidate is enriched with
    # a compact "recent developments" block the LLM uses for entry TIMING /
    # near-term CATALYST / RISK — NOT to re-derive business quality (that's the
    # shared research card's job). Auto-no-ops when SERPAPI_API_KEY is unset, so
    # it's safe to leave on everywhere. Deduped per heartbeat run (module cache).
    "news_search": True,
    "news_queries": 1,              # SerpAPI queries per candidate (1 = cheapest)
    "news_max_chars": 1500,         # truncation cap for the injected block
}


# Operators recognised by `theses.check_thesis`. Keep in sync with
# theses._evaluate_signal — the LLM's output is rejected otherwise.
_ALLOWED_OPS: frozenset[str] = frozenset({
    ">", ">=", "<", "<=", "==", "!=",
    "change_pct_lt", "change_pct_gt",
})


# Numeric fields the LLM can name in extend_signals/break_signals.
# Subset of theses._SNAPSHOT_FIELDS that's actually numeric (so
# check_thesis can compare). Identity/narrative fields (ticker,
# company_name, full_outlook, etc.) are excluded.
_ALLOWED_SIGNAL_FIELDS: frozenset[str] = frozenset({
    "rating", "r40_score", "rule_of_40",
    "rev_growth_ttm_pct", "rev_growth_qoq_pct", "rev_cagr_pct",
    "gross_margin_pct", "operating_margin_pct", "net_margin_pct",
    "net_margin_yoy_pct", "fcf_margin_pct",
    "opex_pct_revenue", "sm_rd_pct_revenue",
    "eps_only", "eps_yoy_pct",
    "price", "ps_now", "price_pct_of_52w_high",
    "perf_52w_vs_spy", "composite_score",
})


# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

BUYER_SYSTEM_PROMPT = """\
You are an equity research analyst making BUY decisions for a $1M paper-money portfolio that competes on a public leaderboard.

Your job per call: evaluate ONE equity against the portfolio's mandate(s) and current state, and return a strict JSON verdict.

Discipline:
- A SHARED RESEARCH CARD (pre-computed business analysis: quality_score + scored moat / growth durability / earnings quality / balance-sheet safety, each 1-5) is provided when available. Treat it as the BUSINESS-QUALITY assessment — you don't need to re-derive whether the business is good. Your job is the part the card can't know: does THIS equity fit THIS portfolio's mandate, given its current holdings, at TODAY's price? Spend your judgement there.
- Only verdict="BUY" with conviction=5 actually triggers a trade. Anything below 5 means "interesting but I'm not pulling the trigger today". Be honest, not over-eager — most names should be 1-4.
- Conviction 1-5 is only meaningful when verdict="BUY". For PASS, leave conviction=1.
- Read the curator's rationale, but don't be anchored by it — the curator picks broadly; you decide whether this specific equity is right for THIS portfolio TODAY at THIS price.
- Read the prior in-house BUY/BEAR verdicts and the research card as data points, not directives.
- RECENT DEVELOPMENTS (a web-search snippet) may be provided. Use it for entry TIMING and near-term CATALYST / RISK — is now a good moment to add, or is there a fresh red flag? It does NOT override the research card's business-quality read; it's news headlines, so weigh it for what it is and don't over-trade on a single snippet.
- VALUATION read the multiple in CONTEXT, not in isolation: valuation.ps vs ps_median_12m (the name's own history) AND vs peer_ps_median (its sector/industry peers, basis in peer_basis) tells you cheap-or-rich; ps_trend_pct is the DIRECTION of the multiple over the last quarter (>0 re-rating up, <0 compressing). A name cheap vs peers AND stabilising can be a good entry; cheap AND still de-rating can be a value trap; expensive but re-rating up needs the growth/quality to justify it. Weigh this for entry quality — it is not a hard gate.

Thesis discipline (BUY only):
- thesis_text: 2-4 sentences. WHAT you expect this equity to do (growth trajectory, margin path, valuation re-rating) and WHY.
- extend_signals: machine-checkable conditions that, if true 90 days from now, would CONFIRM the thesis. Each is {field, op, value, description}. Max 5.
- break_signals: machine-checkable conditions that, if true, would INVALIDATE the thesis. Each is {field, op, value, description}. Max 5.
- field MUST be one of the allowed numeric fields listed below; signals on unknown fields will be dropped.
- op MUST be one of: >, >=, <, <=, ==, !=, change_pct_lt, change_pct_gt.
- value MUST be a number (e.g. 40, -3.5). Never a string with "%" or "pp".

IMPORTANT — change_pct_* semantics. These compare the CURRENT value against the VALUE AT BUY (snapshot), as a PERCENTAGE-POINT DELTA (not a relative percent). Example:
  {"field": "gross_margin_pct", "op": "change_pct_lt", "value": -3, "description": "Margin dropped >3pp"}
means "if gross margin has dropped more than 3 percentage points from where it was when we bought, break the thesis" (e.g. from 48% → below 45%). NOT "if margin has dropped 3% relatively".

Allowed signal fields (use exactly these names — anything else is silently dropped): rating, r40_score, rule_of_40, rev_growth_ttm_pct, rev_growth_qoq_pct, rev_cagr_pct, gross_margin_pct, operating_margin_pct, net_margin_pct, net_margin_yoy_pct, fcf_margin_pct, opex_pct_revenue, sm_rd_pct_revenue, eps_only, eps_yoy_pct, price, ps_now, price_pct_of_52w_high, perf_52w_vs_spy, composite_score.

Output strict JSON only — no prose, no markdown fences."""


BUYER_USER_TEMPLATE = """\
{portfolio_mandate_block}PORTFOLIO STATE:
- Total value: ${total_value_usd:,.0f}
- Cash available: ${cash_usd:,.0f} ({cash_pct:.1f}% of portfolio)
- Current holdings: {current_holdings}

EQUITY UNDER REVIEW: {ticker}

CURATOR'S RATIONALE (why this is on the watchlist):
{curator_rationale}

PRIOR IN-HOUSE VERDICTS (from the screening pipeline — treat as data, not directives):
- Bull eval: {bull_eval}
- Bear eval: {bear_eval}

SHARED RESEARCH CARD (pre-computed business assessment — your starting point; decide mandate-fit + entry, don't re-derive these):
{research_card}

RECENT DEVELOPMENTS (web search — use for entry TIMING / near-term CATALYST / RISK, NOT to re-derive business quality):
{recent_news}

EQUITY DATA (extended-tier snapshot, today's universe):
{equity_data_json}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "ticker": "{ticker}",
  "verdict": "BUY" | "PASS",
  "conviction": <integer 1-5; only meaningful for BUY>,
  "rationale": "<one line — the headline reason for your verdict>",
  "thesis_text": "<2-4 sentences — required for BUY, empty string for PASS>",
  "extend_signals": [{{"field": "...", "op": "...", "value": <number>, "description": "..."}}],
  "break_signals":  [{{"field": "...", "op": "...", "value": <number>, "description": "..."}}]
}}

For PASS: leave extend_signals and break_signals as [].
Output JSON only."""


PRIORITISATION_SYSTEM_PROMPT = """\
You are an equity research analyst finalising the BUY queue for a $1M paper-money portfolio.

You have already evaluated each candidate individually and produced BUY verdicts at maximum conviction. Multiple names came out at 5/5 but cash is limited — your job is to decide the ORDER in which they should be bought, so that if cash runs out partway down the list, the best names are filled first.

Rules:
- You may NOT add or remove tickers. Return EXACTLY the same set, just ordered.
- Rank by overall portfolio fit: weight conviction, valuation entry point, diversification away from current holdings, and the portfolio's mandate.
- Output strict JSON only."""


PRIORITISATION_USER_TEMPLATE = """\
{portfolio_mandate_block}PORTFOLIO STATE:
- Total value: ${total_value_usd:,.0f}
- Cash available: ${cash_usd:,.0f} ({cash_pct:.1f}% of portfolio)
- Current holdings: {current_holdings}

BUY CANDIDATES (all already at conviction 5/5):
{candidates_json}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "ranked": ["TICKER1", "TICKER2", ...]
}}

ranked MUST contain every candidate exactly once, in priority order
(best first). Output JSON only."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_signals(
    signals: Any,
    *,
    max_count: int,
) -> list[dict]:
    """Filter LLM-emitted signal entries against the schema.

    Drops anything with an unknown field, unknown op, or non-numeric value.
    Caps to ``max_count``. Returns a fresh list (safe to JSON-serialise).
    """
    if not isinstance(signals, list):
        return []
    clean: list[dict] = []
    for item in signals:
        if not isinstance(item, dict):
            continue
        field = str(item.get("field") or "").strip()
        op = str(item.get("op") or "").strip()
        if field not in _ALLOWED_SIGNAL_FIELDS:
            continue
        if op not in _ALLOWED_OPS:
            continue
        value = item.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        clean.append({
            "field": field,
            "op": op,
            "value": float(value),
            "description": str(item.get("description") or "").strip(),
        })
        if len(clean) >= max_count:
            break
    return clean


def _truncate(text: str, limit: int = 2000) -> str:
    text = text or ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


_RESEARCH_CARD_LABELS = {
    "moat": "Moat",
    "growth_durability": "Growth durability",
    "earnings_quality": "Earnings quality",
    "balance_sheet_risk": "Balance-sheet safety",
}


def _format_research_card(research: Any) -> str:
    """Render the shared research card (migration 055) for the buyer prompt."""
    if not isinstance(research, dict) or not research:
        return "(not yet researched — judge on the data below)"
    lines = [f"Quality score: {research.get('quality_score', '?')}/5"]
    for key, label in _RESEARCH_CARD_LABELS.items():
        d = research.get(key)
        if isinstance(d, dict) and d.get("score") is not None:
            rationale = str(d.get("rationale") or "").strip()
            lines.append(f"- {label}: {d['score']}/5{' — ' + rationale if rationale else ''}")
    return "\n".join(lines)


def _merge_break_signals(llm_signals: list[dict], card: Any, *, max_count: int) -> list[dict]:
    """Merge the shared card's base break signals into the buyer's, deduped.

    So EVERY holding — even one whose buyer authored none — carries the
    company-defined base set for the reviewer (theses.check_thesis) to watch.
    """
    out = list(llm_signals or [])
    seen = {(s.get("field"), s.get("op"), s.get("value")) for s in out}
    card_signals = card.get("break_signals") if isinstance(card, dict) else None
    for s in _validate_signals(card_signals, max_count=max_count):
        key = (s.get("field"), s.get("op"), s.get("value"))
        if key not in seen:
            out.append(s)
            seen.add(key)
    return out


# ---------------------------------------------------------------------------
# Phase 1 — per-ticker BUY/PASS verdict
# ---------------------------------------------------------------------------


def _portfolio_context(portfolio: dict) -> dict:
    """Compact summary the LLM needs about the portfolio's current state."""
    holdings = portfolio.get("holdings") or []
    tickers = sorted({str(h.get("ticker") or "").upper() for h in holdings if h.get("ticker")})
    return {
        "total_value_usd": float(portfolio.get("total_value_usd") or 0),
        "cash_usd": float(portfolio.get("cash_usd") or 0),
        "current_holdings": ", ".join(tickers) if tickers else "(none yet)",
    }


def _evaluate_ticker(
    *,
    provider: str,
    model: str,
    ticker: str,
    equity_data: dict,
    curator_rationale: str | None,
    portfolio: dict,
    portfolio_mandate: str | None,
    max_tokens: int,
    temperature: float,
    max_signals: int,
) -> dict:
    """Call the LLM for one ticker. Returns either the parsed verdict dict
    or a dict with ``error`` set (never raises).
    """
    bull_eval = (equity_data.get("narrative") or {}).get("bull_eval") or "—"
    bear_eval = (equity_data.get("narrative") or {}).get("bear_eval") or "—"
    research = equity_data.get("research")
    recent_news = equity_data.get("recent_news") or "(no recent web results)"
    # The news already renders as its own readable block — keep it out of the
    # equity-data JSON so it isn't injected twice.
    equity_for_json = {k: v for k, v in equity_data.items() if k != "recent_news"}

    pc = _portfolio_context(portfolio)
    cash_pct = (pc["cash_usd"] / pc["total_value_usd"] * 100) if pc["total_value_usd"] else 0.0

    user = BUYER_USER_TEMPLATE.format(
        portfolio_mandate_block=_mandate_block(portfolio_mandate),
        total_value_usd=pc["total_value_usd"],
        cash_usd=pc["cash_usd"],
        cash_pct=cash_pct,
        current_holdings=pc["current_holdings"],
        ticker=ticker,
        curator_rationale=(curator_rationale or "(no rationale on watchlist row)").strip(),
        bull_eval=bull_eval,
        bear_eval=bear_eval,
        research_card=_format_research_card(research),
        recent_news=recent_news,
        equity_data_json=json.dumps(equity_for_json, default=str, ensure_ascii=False),
    )

    try:
        resp = call_llm(
            provider=provider,
            model=model,
            system=BUYER_SYSTEM_PROMPT,
            user=user,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    except LLMProviderError as exc:
        return {"ticker": ticker, "error": f"LLM call failed: {exc}"}

    try:
        parsed, _retry = _parse_with_retry(
            provider, model, resp.text, system=BUYER_SYSTEM_PROMPT,
        )
    except LLMProviderError as exc:
        return {
            "ticker": ticker,
            "error": f"JSON parse failed after retry: {exc}",
            "raw_response_truncated": _truncate(resp.text),
        }

    verdict = str(parsed.get("verdict") or "").strip().upper()
    if verdict not in ("BUY", "PASS"):
        return {
            "ticker": ticker,
            "error": f"unrecognised verdict {verdict!r}",
            "raw_response_truncated": _truncate(resp.text),
        }

    conviction_raw = parsed.get("conviction")
    try:
        conviction = int(conviction_raw) if conviction_raw is not None else 1
    except (TypeError, ValueError):
        conviction = 1
    conviction = max(1, min(5, conviction))

    break_signals = _validate_signals(parsed.get("break_signals"), max_count=max_signals)
    if verdict == "BUY":
        # Inherit the shared card's base break signals so every holding carries a
        # consistent set for the reviewer, even if the buyer authored none.
        break_signals = _merge_break_signals(break_signals, research, max_count=max_signals + 5)

    return {
        "ticker": ticker,
        "verdict": verdict,
        "conviction": conviction,
        "rationale": str(parsed.get("rationale") or "").strip(),
        "thesis_text": str(parsed.get("thesis_text") or "").strip(),
        "extend_signals": _validate_signals(parsed.get("extend_signals"), max_count=max_signals),
        "break_signals": break_signals,
        "input_tokens": resp.input_tokens,
        "output_tokens": resp.output_tokens,
    }


# ---------------------------------------------------------------------------
# Phase 2 — prioritisation
# ---------------------------------------------------------------------------


def _prioritise(
    *,
    provider: str,
    model: str,
    candidates: list[dict],
    portfolio: dict,
    portfolio_mandate: str | None,
    max_tokens: int,
    temperature: float,
) -> tuple[list[str], dict]:
    """Single LLM call that orders the conviction-5 candidates.

    Returns (ranked_tickers, notes). On any validation failure, falls back
    to the emission order so we still make progress; notes capture why.
    """
    notes: dict = {}
    if len(candidates) < 2:
        # Single candidate → no ordering to do.
        return [c["ticker"] for c in candidates], {"phase2_skipped": "single candidate"}

    pc = _portfolio_context(portfolio)
    cash_pct = (pc["cash_usd"] / pc["total_value_usd"] * 100) if pc["total_value_usd"] else 0.0
    summary = [
        {"ticker": c["ticker"], "conviction": c["conviction"], "rationale": c["rationale"]}
        for c in candidates
    ]
    user = PRIORITISATION_USER_TEMPLATE.format(
        portfolio_mandate_block=_mandate_block(portfolio_mandate),
        total_value_usd=pc["total_value_usd"],
        cash_usd=pc["cash_usd"],
        cash_pct=cash_pct,
        current_holdings=pc["current_holdings"],
        candidates_json=json.dumps(summary, ensure_ascii=False),
    )

    try:
        resp = call_llm(
            provider=provider,
            model=model,
            system=PRIORITISATION_SYSTEM_PROMPT,
            user=user,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        parsed, _retry = _parse_with_retry(
            provider, model, resp.text, system=PRIORITISATION_SYSTEM_PROMPT,
        )
    except LLMProviderError as exc:
        notes["phase2_error"] = f"prioritisation LLM call failed: {exc}"
        return [c["ticker"] for c in candidates], notes

    ranked_raw = parsed.get("ranked")
    if not isinstance(ranked_raw, list):
        notes["phase2_error"] = "response missing 'ranked' array"
        return [c["ticker"] for c in candidates], notes

    candidate_set = {c["ticker"] for c in candidates}
    ranked = [str(t).strip().upper() for t in ranked_raw if isinstance(t, str)]
    ranked_set = set(ranked)

    if ranked_set != candidate_set:
        notes["phase2_error"] = (
            "ranked set ≠ candidate set "
            f"(missing={list(candidate_set - ranked_set)}, "
            f"extra={list(ranked_set - candidate_set)})"
        )
        return [c["ticker"] for c in candidates], notes

    notes["phase2_input_tokens"] = resp.input_tokens
    notes["phase2_output_tokens"] = resp.output_tokens
    return ranked, notes


# ---------------------------------------------------------------------------
# Active-thesis idempotence gate
# ---------------------------------------------------------------------------


def _active_thesis_tickers(db, portfolio_id: str) -> set[str]:
    """Tickers with an active investment_theses row for this portfolio.

    The buyer skips these to avoid re-buying a name we already have a
    thesis on — every re-buy would supersede the prior thesis (losing
    its original extend/break signals) and the moody-LLM problem makes
    this trivially easy to hit on a 24h cadence.
    """
    resp = (
        db.client.table("investment_theses")
        .select("ticker")
        .eq("portfolio_id", portfolio_id)
        .eq("status", "active")
        .execute()
    )
    return {str(r.get("ticker") or "").upper() for r in (resp.data or []) if r.get("ticker")}


def _pass_rejection_rows(evaluations: list[dict], agent_id: str) -> list[dict]:
    """Rejection rows for the screener hide (migration 051) — only true PASSes.

    A `verdict == "PASS"` is a real "no" and gets hidden. A sub-gate BUY (e.g.
    4/5) is deliberately NOT recorded: it's a name the agent wants, just not its
    top pick today, so it stays eligible and is re-evaluated as the screen
    re-ranks rather than being quarantined.
    """
    return [
        {
            "ticker": e["ticker"],
            "rejected_by_agent_id": agent_id,
            "verdict": e.get("verdict"),
            "conviction": e.get("conviction"),
            "reason": (e.get("rationale") or "")[:240] or None,
        }
        for e in evaluations
        if str(e.get("verdict") or "").upper() == "PASS"
    ]


# ---------------------------------------------------------------------------
# Shared evaluation core — used by BOTH this standalone strategy and the
# portfolio swarm (agent_heartbeat._run_portfolio_swarm), so a swarm buyer
# "thinks" on exactly the same inputs/logic as the 1:1 buyer.
# ---------------------------------------------------------------------------


def build_candidate_data(
    db, fact_rows: dict[str, dict], candidates: list[str]
) -> dict[str, dict]:
    """Assemble the per-ticker ``equity_data`` map the LLM evaluator consumes.

    One ``ai_analysis`` query for the narrative overlay + the Level 0 fact row
    per name (`fact_rows` keyed by upper-case ticker). Names without a fact row
    are dropped (the caller can diff to detect them).
    """
    narratives = _load_company_narratives(db, candidates)
    return {
        t: _build_equity_data(fact_rows[t], narratives.get(t))
        for t in candidates
        if t in fact_rows
    }


# Process-level cache so a ticker searched for one portfolio/buyer is reused by
# every other portfolio/buyer in the SAME heartbeat run. Each heartbeat is a
# fresh process, so the cache lives for exactly one run — no stale-news risk.
_NEWS_RUN_CACHE: dict[str, str] = {}


def serpapi_key() -> str:
    """SerpAPI key from the environment (matches update_ai_narratives.py)."""
    return os.environ.get("SERPAPI_API_KEY", "") or os.environ.get("SERP_API_KEY", "")


def attach_recent_news(
    by_ticker_data: dict[str, dict],
    *,
    api_key: str,
    concurrency: int = 5,
    logger: logging.Logger = logger,
    cache: dict[str, str] | None = None,
    max_queries: int = 1,
    max_chars: int = 1500,
) -> int:
    """Enrich each candidate's ``equity_data`` with a ``recent_news`` block, in place.

    Per-name SerpAPI fetch at buy time, run in parallel. Deduped via ``cache``
    (defaults to the process-level run cache) so a ticker is searched at most
    once per heartbeat run across all portfolios/buyers. No-op (returns 0) when
    ``api_key`` is falsy. Best-effort: a failed fetch leaves the ticker without
    news rather than aborting the run.

    Returns the number of live SerpAPI fetches performed (cache hits excluded).
    """
    if not api_key:
        return 0
    if cache is None:
        cache = _NEWS_RUN_CACHE

    to_fetch = [t for t in by_ticker_data if t not in cache]

    def _fetch(t: str) -> tuple[str, str]:
        try:
            company = (by_ticker_data[t] or {}).get("company_name")
            text = recent_developments(
                company, t, api_key=api_key, logger=logger,
                max_queries=max_queries, max_chars=max_chars,
            )
        except Exception as exc:  # defensive — search is never load-bearing
            logger.warning("recent_developments failed for %s: %s", t, exc)
            text = ""
        return t, text

    fetched = 0
    if to_fetch:
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            for t, text in pool.map(_fetch, to_fetch):
                cache[t] = text
                fetched += 1

    for t, data in by_ticker_data.items():
        news = cache.get(t)
        if news:
            data["recent_news"] = news
    return fetched


def evaluate_candidates(
    *,
    provider: str,
    model: str,
    candidates: list[str],
    by_ticker_data: dict[str, dict],
    combined_rationale: dict[str, str],
    portfolio: dict,
    portfolio_mandate: str | None,
    params: dict,
    label: str = "buyer",
) -> tuple[list[dict], dict]:
    """Phase-1 per-ticker BUY/PASS evaluation, run in parallel.

    The shared "thinking" core: for each candidate it calls the model with the
    equity data + the buyer's mandate and returns the validated verdict dicts
    (``{verdict, conviction, rationale, thesis_text, extend_signals,
    break_signals, ...}``) plus a notes dict (timeouts / parse failures / token
    totals). Pure w.r.t. the DB — the caller supplies the prepared candidate
    data — so the standalone strategy and the swarm draft evaluate names
    identically. Per-ticker errors are captured in notes, never raised.
    """
    notes: dict[str, Any] = {}
    concurrency = max(1, int(params["concurrency"]))
    timeout_sec = float(params["per_call_timeout_sec"])
    max_tokens = int(params["max_tokens"])
    temperature = float(params["temperature"])
    max_signals = int(params["max_signals_per_kind"])

    evaluations: list[dict] = []
    parse_failures: dict[str, str] = {}
    timeouts: list[str] = []

    logger.info(
        "%s phase 1: %d candidates, concurrency=%d, timeout=%.0fs",
        label, len(candidates), concurrency, timeout_sec,
    )

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(
                _evaluate_ticker,
                provider=provider,
                model=model,
                ticker=ticker,
                equity_data=by_ticker_data[ticker],
                curator_rationale=combined_rationale.get(ticker) or None,
                portfolio=portfolio,
                portfolio_mandate=portfolio_mandate,
                max_tokens=max_tokens,
                temperature=temperature,
                max_signals=max_signals,
            ): ticker
            for ticker in candidates
            if ticker in by_ticker_data
        }
        for fut, ticker in list(futures.items()):
            try:
                ev = fut.result(timeout=timeout_sec)
            except FutureTimeoutError:
                timeouts.append(ticker)
                fut.cancel()
                continue
            except Exception as exc:  # noqa: BLE001 — defensive
                parse_failures[ticker] = f"unexpected: {exc}"
                continue
            if "error" in ev:
                parse_failures[ticker] = ev["error"]
                continue
            evaluations.append(ev)

    if timeouts:
        notes["timeouts"] = timeouts
    if parse_failures:
        notes["per_ticker_errors"] = parse_failures
    notes["phase1_evaluations"] = len(evaluations)
    notes["phase1_input_tokens"] = sum(int(e.get("input_tokens") or 0) for e in evaluations)
    notes["phase1_output_tokens"] = sum(int(e.get("output_tokens") or 0) for e in evaluations)
    return evaluations, notes


# ---------------------------------------------------------------------------
# Strategy entrypoint
# ---------------------------------------------------------------------------


def rebalance_llm_watchlist_buyer(ctx: RebalanceContext) -> RebalanceResult:
    """LLM-driven buyer for human-owned portfolios.

    Flow:
      0. No-op on legacy agent portfolios. Check cash >= min_cash_pct.
      1. Load mandates (main + buy), dedupe the watchlist, filter
         already-held and active-thesis tickers.
      2. Phase 1: per-ticker BUY/PASS verdicts (parallel + per-call
         timeout).
      3. Phase 2: prioritise the 5/5 candidates with one LLM call.
      4. Buy in Phase 2 order at 4% target until cash runs out;
         record a thesis per buy.

    Defensive by contract: per-ticker errors are journalled into
    `result.notes` and skipped; the heartbeat doesn't crash on a
    single bad LLM response.
    """
    result = RebalanceResult()
    params = {**LLM_WATCHLIST_BUYER_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    if not ctx.portfolio_id:
        result.notes["reason"] = "llm_watchlist_buyer only runs on a human portfolio"
        return result

    provider = params["provider"]
    model = params["model"]
    if not provider or not model:
        result.errors.append("agents.config must set provider + model")
        return result

    # 0. Cash gate (before any other work).
    portfolio = ctx.get_book()
    total_value = float(portfolio.get("total_value_usd") or 0)
    cash_usd = float(portfolio.get("cash_usd") or 0)
    if total_value <= 0:
        result.errors.append(f"total_value_usd <= 0 for {handle}")
        return result

    cash_pct = cash_usd / total_value * 100.0
    min_cash_pct = float(params["min_cash_pct"])
    if cash_pct < min_cash_pct:
        result.notes["reason"] = "insufficient cash"
        result.notes["cash_pct"] = round(cash_pct, 2)
        result.notes["min_cash_pct"] = min_cash_pct
        return result

    # 1. Load mandate + watchlist. There's one mandate per portfolio
    # (portfolios.description, surfaced as ctx.mandate); the buyer reads
    # it to understand both *what* the portfolio should be and *how* to
    # evaluate any add.
    portfolio_mandate = ctx.mandate

    # Candidate set is the top N of the portfolio's screen — the screener IS
    # the selection now (curator/watchlist removed, brief v2 §3). The screen
    # rank + score is the per-ticker rationale handed to the LLM evaluator.
    import screen as _screen

    # Fetch the screen's top-N fact rows ONCE — they give both the rationale
    # (rank + score) and the Level 0 evaluation data used in Phase 1 below.
    candidate_rows = _screen.portfolio_screen_candidate_rows(ctx.db, ctx.portfolio_id)
    fact_rows: dict[str, dict] = {
        str(r.get("ticker") or "").upper(): r for r in candidate_rows
    }
    watchlist_tickers = sorted(fact_rows.keys())
    if not watchlist_tickers:
        result.notes["reason"] = "portfolio has no screen configured or screen is empty"
        return result

    combined_rationale: dict[str, str] = {
        r["ticker"]: f"screen rank #{r['rank']} · {r.get('final_pct', 0)}th pct"
        for r in candidate_rows
    }

    # Filter: already-held at >= target weight (concentration cap).
    target_pct = float(params["target_position_pct"])
    held_qty: dict[str, float] = {
        str(h.get("ticker") or "").upper(): float(h.get("quantity") or 0)
        for h in (portfolio.get("holdings") or [])
        if h.get("ticker")
    }
    skipped_held: list[str] = []
    candidates: list[str] = []
    for ticker in watchlist_tickers:
        qty = held_qty.get(ticker, 0)
        if qty > 0:
            try:
                price = ctx.pm.get_price(ticker)
            except PortfolioError:
                # Can't price → skip the concentration check, keep the
                # ticker in the candidate set (the LLM will get the data
                # via the snapshot anyway).
                price = None
            if price is not None:
                weight_pct = (qty * price / total_value) * 100.0
                if weight_pct >= target_pct:
                    skipped_held.append(ticker)
                    continue
        candidates.append(ticker)

    if skipped_held:
        result.notes["skipped_already_held"] = skipped_held

    # Filter: tickers with an active thesis. One thesis per (portfolio,
    # ticker) is the discipline — see _active_thesis_tickers docstring.
    active = _active_thesis_tickers(ctx.db, ctx.portfolio_id)
    skipped_active: list[str] = [t for t in candidates if t in active]
    if skipped_active:
        result.notes["skipped_active_thesis"] = skipped_active
    candidates = [t for t in candidates if t not in active]

    # Filter: tickers sold from this portfolio within the last 90 days.
    # Once the owner manually sells, or the reviewer agent exits a
    # position, the buyer is not allowed to immediately re-establish
    # it — gives the owner time to act on the exit decision without
    # the buyer churning straight back in.
    recently_sold = ctx.db.get_recently_sold_tickers(ctx.portfolio_id, days=90)
    skipped_cooldown: list[str] = [t for t in candidates if t in recently_sold]
    if skipped_cooldown:
        result.notes["skipped_recent_sell_cooldown"] = skipped_cooldown
    candidates = [t for t in candidates if t not in recently_sold]

    if not candidates:
        result.notes["reason"] = "no candidates after filters"
        return result

    # 2. Phase 1 — per-ticker LLM evaluation, parallel.
    #
    # Evaluation data comes from Level 0 — the SAME Tier-1 fact rows the
    # screener ranked on — enriched with the AI narrative + bull/bear from
    # `companies` where it exists. This replaces the legacy in_tv_screen
    # universe snapshot, so every Tier-1 screen candidate is evaluable (the old
    # snapshot only covered names the legacy TradingView screen included, which
    # is why US-listed financials / foreign-domiciled ADRs showed up as
    # "missing" and were never bought). `fact_rows` was fetched once in step 1.
    by_ticker_data = build_candidate_data(ctx.db, fact_rows, candidates)
    missing_facts = [t for t in candidates if t not in by_ticker_data]
    if missing_facts:
        # Shouldn't normally happen (candidates ARE the screen top-N), but a
        # name could drop out of the screen between the two reads — note + skip.
        result.notes["missing_facts"] = missing_facts
        candidates = [t for t in candidates if t in by_ticker_data]

    if not candidates:
        result.notes["reason"] = "no Level 0 facts for any candidate"
        return result

    # Per-name web search at buy time — enrich each candidate with a compact
    # "recent developments" block the LLM weighs for entry timing / catalysts /
    # near-term risk. Auto-no-ops when SERPAPI_API_KEY is unset.
    if params.get("news_search"):
        key = serpapi_key()
        if key:
            news_fetched = attach_recent_news(
                {t: by_ticker_data[t] for t in candidates},
                api_key=key,
                concurrency=int(params["concurrency"]),
                logger=logger,
                max_queries=int(params.get("news_queries", 1)),
                max_chars=int(params.get("news_max_chars", 1500)),
            )
            result.notes["news_fetched"] = news_fetched

    evaluations, eval_notes = evaluate_candidates(
        provider=provider,
        model=model,
        candidates=candidates,
        by_ticker_data=by_ticker_data,
        combined_rationale=combined_rationale,
        portfolio=portfolio,
        portfolio_mandate=portfolio_mandate,
        params=params,
        label=handle,
    )
    result.notes.update(eval_notes)

    # 3. Filter to BUY @ min_conviction and run Phase 2.
    min_conviction = int(params["min_conviction"])
    qualifying = [
        e for e in evaluations
        if e["verdict"] == "BUY" and e["conviction"] >= min_conviction
    ]
    result.notes["phase1_qualifying"] = len(qualifying)

    # Record only the names this buyer truly PASSED on (a real "no"). A
    # high-but-sub-gate BUY (e.g. 4/5) is NOT recorded — it's a name the agent
    # *wants*, just not its top pick today — so it stays eligible and gets
    # re-evaluated as the screen re-ranks, instead of being quarantined. The
    # hide window is short (rejection_window_days, default 30) so it tracks the
    # daily re-rank / earnings cadence; the 90d window applies only to the
    # post-SELL cooldown. Always recorded (the toggle governs display, not
    # capture); never in dry-run.
    if not ctx.dry_run:
        rejected_rows = _pass_rejection_rows(evaluations, ctx.agent["id"])
        if rejected_rows:
            n = ctx.db.record_screener_rejections(
                ctx.portfolio_id, rejected_rows,
                days=int(params["rejection_window_days"]),
            )
            result.notes["screener_rejections_recorded"] = n

    if not qualifying:
        result.notes["reason"] = "no candidates met the conviction threshold"
        return result

    ranked_tickers, phase2_notes = _prioritise(
        provider=provider,
        model=model,
        candidates=qualifying,
        portfolio=portfolio,
        portfolio_mandate=portfolio_mandate,
        max_tokens=int(params["max_tokens_phase2"]),
        temperature=temperature,
    )
    result.notes.update(phase2_notes)

    by_ticker_eval: dict[str, dict] = {e["ticker"]: e for e in qualifying}

    # 4. Trade execution.
    target_usd = total_value * (target_pct / 100.0)
    min_position_usd = total_value * (float(params["min_position_pct"]) / 100.0)

    plan: list[dict] = []
    remaining_cash = cash_usd

    for ticker in ranked_tickers:
        ev = by_ticker_eval.get(ticker)
        if not ev:
            continue
        if remaining_cash < min_position_usd:
            break
        buy_usd = target_usd if remaining_cash >= target_usd else remaining_cash

        try:
            price = ctx.pm.get_price(ticker)
        except PortfolioError as exc:
            result.notes.setdefault("unpriced", []).append(ticker)
            logger.warning("%s: skipping %s, %s", handle, ticker, exc)
            continue
        if price <= 0:
            result.notes.setdefault("unpriced", []).append(ticker)
            continue

        qty = int(math.floor(buy_usd / price))
        if qty <= 0:
            result.notes.setdefault("rounded_to_zero", []).append(ticker)
            continue

        plan.append({
            "ticker": ticker,
            "qty": qty,
            "buy_usd": round(qty * price, 2),
            "price": price,
            "conviction": ev["conviction"],
            "rationale": ev["rationale"],
        })
        remaining_cash -= qty * price

    if not plan:
        result.notes["reason"] = "no executable buys (cash or rounding)"
        return result

    if ctx.dry_run:
        result.notes["dry_run_plan"] = plan
        result.notes["cash_pct"] = round(cash_pct, 2)
        result.notes["target_pct"] = target_pct
        result.notes["target_usd"] = round(target_usd, 2)
        logger.info(
            "[dry-run] %s: %d buys planned, cash $%.2f → $%.2f",
            handle, len(plan), cash_usd, remaining_cash,
        )
        return result

    # Live execution. Each buy passes a thesis dict so an
    # investment_theses row is recorded with source='agent'.
    for item in plan:
        ticker = item["ticker"]
        ev = by_ticker_eval[ticker]
        thesis = {
            "thesis_text": ev["thesis_text"] or None,
            "extend_signals": ev["extend_signals"] or None,
            "break_signals": ev["break_signals"] or None,
        }
        note = f"alphamolt-buyer 5/5 ({ev['rationale'][:80]})"
        try:
            ctx.buy(ticker, item["qty"], note=note, thesis=thesis)
            result.buys += 1
            # Clear any stale rejection — we now own it, so it must never be
            # shadowed as "rejected" on the screener (migration 051).
            ctx.db.clear_screener_rejection(ctx.portfolio_id, ticker)
        except PortfolioError as exc:
            result.errors.append(f"buy {ticker} x{item['qty']}: {exc}")
        except Exception as exc:  # noqa: BLE001
            # A non-PortfolioError (e.g. a Postgres FK/APIError on the insert)
            # must NOT abort the whole batch — log it, record it, and keep
            # buying the rest of the ranked plan. Previously this propagated
            # and crashed the entire heartbeat with zero buys.
            logger.warning("%s: buy %s x%s failed (skipped): %s",
                           handle, ticker, item["qty"], exc)
            result.errors.append(f"buy {ticker} x{item['qty']}: {exc}")
    result.notes["target_pct"] = target_pct
    result.notes["target_usd"] = round(target_usd, 2)
    return result
