"""LLM-driven watchlist buyer strategy — high-conviction BUYs only.

The thinking counterpart of `agent_strategies.rebalance_watchlist_buyer`
(equal-weight, mechanical). For each watchlist ticker the strategy
calls a frontier model with the full extended-tier data + the
portfolio's mandate + the new per-portfolio buy-decisions mandate, and
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
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from typing import Any

from agent_strategies import RebalanceContext, RebalanceResult
from llm_picker import (
    _filter_snapshot_us_only,
    _load_latest_snapshot,
    _mandate_block,
    _parse_with_retry,
    _us_listed_tickers,
)
from llm_providers import LLMProviderError, call_llm
from portfolio import PortfolioError

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
- Only verdict="BUY" with conviction=5 actually triggers a trade. Anything below 5 means "interesting but I'm not pulling the trigger today". Be honest, not over-eager — most names should be 1-4.
- Conviction 1-5 is only meaningful when verdict="BUY". For PASS, leave conviction=1.
- Read the curator's rationale, but don't be anchored by it — the curator picks broadly; you decide whether this specific equity is right for THIS portfolio TODAY at THIS price.
- Read the prior in-house BUY/BEAR verdicts (if present) as data points, not directives.

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
{portfolio_mandate_block}{buy_mandate_block}PORTFOLIO STATE:
- Total value: ${total_value_usd:,.0f}
- Cash available: ${cash_usd:,.0f} ({cash_pct:.1f}% of portfolio)
- Current holdings: {current_holdings}

EQUITY UNDER REVIEW: {ticker}

CURATOR'S RATIONALE (why this is on the watchlist):
{curator_rationale}

PRIOR IN-HOUSE VERDICTS (from the screening pipeline — treat as data, not directives):
- Bull eval: {bull_eval}
- Bear eval: {bear_eval}

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
{portfolio_mandate_block}{buy_mandate_block}PORTFOLIO STATE:
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


def _buy_mandate_block(buy_mandate: str | None) -> str:
    """Render the per-portfolio buy-decisions mandate as a prompt preamble,
    or '' when absent. Parallel of `llm_picker._mandate_block` but framed as
    a how-to-evaluate brief rather than a what-to-own brief.
    """
    text = (buy_mandate or "").strip()
    if not text:
        return ""
    return (
        "BUY-DECISIONS MANDATE (the human owner's instructions on how to "
        "evaluate any individual add to this portfolio — honour these):\n"
        f"{text}\n\n"
    )


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
    buy_mandate: str | None,
    max_tokens: int,
    temperature: float,
    max_signals: int,
) -> dict:
    """Call the LLM for one ticker. Returns either the parsed verdict dict
    or a dict with ``error`` set (never raises).
    """
    bull_eval = (equity_data.get("narrative") or {}).get("bull_eval") or "—"
    bear_eval = (equity_data.get("narrative") or {}).get("bear_eval") or "—"

    pc = _portfolio_context(portfolio)
    cash_pct = (pc["cash_usd"] / pc["total_value_usd"] * 100) if pc["total_value_usd"] else 0.0

    user = BUYER_USER_TEMPLATE.format(
        portfolio_mandate_block=_mandate_block(portfolio_mandate),
        buy_mandate_block=_buy_mandate_block(buy_mandate),
        total_value_usd=pc["total_value_usd"],
        cash_usd=pc["cash_usd"],
        cash_pct=cash_pct,
        current_holdings=pc["current_holdings"],
        ticker=ticker,
        curator_rationale=(curator_rationale or "(no rationale on watchlist row)").strip(),
        bull_eval=bull_eval,
        bear_eval=bear_eval,
        equity_data_json=json.dumps(equity_data, default=str, ensure_ascii=False),
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

    return {
        "ticker": ticker,
        "verdict": verdict,
        "conviction": conviction,
        "rationale": str(parsed.get("rationale") or "").strip(),
        "thesis_text": str(parsed.get("thesis_text") or "").strip(),
        "extend_signals": _validate_signals(parsed.get("extend_signals"), max_count=max_signals),
        "break_signals": _validate_signals(parsed.get("break_signals"), max_count=max_signals),
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
    buy_mandate: str | None,
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
        buy_mandate_block=_buy_mandate_block(buy_mandate),
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

    # 1. Load mandates + watchlist. Read both mandates from the portfolios
    # row directly — ctx.mandate is the main mandate; the new buy_mandate
    # column needs a fresh select.
    portfolio_mandate = ctx.mandate
    buy_mandate: str | None = None
    pf_row = ctx.db.get_portfolio_by_id(ctx.portfolio_id)
    if pf_row:
        buy_mandate = pf_row.get("buy_mandate")

    watchlist = ctx.db.get_portfolio_watchlist(ctx.portfolio_id)
    # Dedupe by ticker; combine rationales when both source='user' and
    # source='agent' rows exist (PK is (portfolio_id, ticker, source)? No —
    # see migration 027: PK is (portfolio_id, ticker); only one source per
    # row possible. But we tolerate either schema defensively.)
    rationales: dict[str, list[tuple[str, str]]] = {}
    for row in watchlist:
        ticker = str(row.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        source = str(row.get("source") or "").lower()
        rationale = (row.get("rationale") or "").strip()
        if not rationale:
            continue
        rationales.setdefault(ticker, []).append((source, rationale))

    watchlist_tickers = sorted({
        str(row.get("ticker") or "").strip().upper()
        for row in watchlist
        if row.get("ticker")
    })
    if not watchlist_tickers:
        result.notes["reason"] = "portfolio watchlist is empty"
        return result

    # Combine rationales into a single string per ticker for the prompt.
    combined_rationale: dict[str, str] = {}
    for ticker in watchlist_tickers:
        pairs = rationales.get(ticker) or []
        if not pairs:
            combined_rationale[ticker] = ""
            continue
        # Prefer USER first, then AGENT/CURATOR; label both when present.
        user_text = next((r for s, r in pairs if s == "user"), None)
        agent_text = next((r for s, r in pairs if s != "user"), None)
        if user_text and agent_text:
            combined_rationale[ticker] = f"USER: {user_text} | CURATOR: {agent_text}"
        else:
            combined_rationale[ticker] = user_text or agent_text or ""

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

    if not candidates:
        result.notes["reason"] = "no candidates after filters"
        return result

    # 2. Phase 1 — per-ticker LLM evaluation, parallel.

    # Load + filter the extended-tier snapshot once for the whole batch.
    snap_row = _load_latest_snapshot(ctx.db, "extended")
    if not snap_row:
        result.errors.append(
            "no extended universe snapshot — build one via build_universe_snapshot.py"
        )
        return result
    us_tickers = _us_listed_tickers(ctx.db)
    snapshot_json = _filter_snapshot_us_only(snap_row["json"], us_tickers)

    by_ticker_data: dict[str, dict] = {
        str(t.get("ticker") or "").upper(): t
        for t in (snapshot_json.get("tickers") or [])
        if t.get("ticker")
    }
    missing_from_snapshot = [t for t in candidates if t not in by_ticker_data]
    if missing_from_snapshot:
        # Drop them with a note rather than failing — most likely the
        # ticker dropped out of the screen between curator and buyer runs.
        result.notes["missing_from_snapshot"] = missing_from_snapshot
        candidates = [t for t in candidates if t in by_ticker_data]

    if not candidates:
        result.notes["reason"] = "no candidates have extended-tier data"
        return result

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
        handle, len(candidates), concurrency, timeout_sec,
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
                buy_mandate=buy_mandate,
                max_tokens=max_tokens,
                temperature=temperature,
                max_signals=max_signals,
            ): ticker
            for ticker in candidates
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
                if ev.get("raw_response_truncated"):
                    parse_failures.setdefault("_raw", {})  # type: ignore[arg-type]
                continue
            evaluations.append(ev)

    if timeouts:
        result.notes["timeouts"] = timeouts
    if parse_failures:
        result.notes["per_ticker_errors"] = parse_failures

    # Aggregate token usage for visibility.
    input_tok = sum(int(e.get("input_tokens") or 0) for e in evaluations)
    output_tok = sum(int(e.get("output_tokens") or 0) for e in evaluations)
    result.notes["phase1_evaluations"] = len(evaluations)
    result.notes["phase1_input_tokens"] = input_tok
    result.notes["phase1_output_tokens"] = output_tok

    # 3. Filter to BUY @ min_conviction and run Phase 2.
    min_conviction = int(params["min_conviction"])
    qualifying = [
        e for e in evaluations
        if e["verdict"] == "BUY" and e["conviction"] >= min_conviction
    ]
    result.notes["phase1_qualifying"] = len(qualifying)
    if not qualifying:
        result.notes["reason"] = "no candidates met the conviction threshold"
        return result

    ranked_tickers, phase2_notes = _prioritise(
        provider=provider,
        model=model,
        candidates=qualifying,
        portfolio=portfolio,
        portfolio_mandate=portfolio_mandate,
        buy_mandate=buy_mandate,
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
        except PortfolioError as exc:
            result.errors.append(f"buy {ticker} x{item['qty']}: {exc}")

    result.notes["executed_plan"] = plan
    result.notes["target_pct"] = target_pct
    result.notes["target_usd"] = round(target_usd, 2)
    return result
