#!/usr/bin/env python3
"""
Research Evaluation — the shared per-equity research card.

The deep, equity-intrinsic business analysis, computed ONCE per equity and
shared by every portfolio (public-read `ai_analysis.research_card`, migration
055). It broadens the coarse binary bull/bear with four SCORED dimensions —
moat, growth durability, earnings quality, balance-sheet risk — each 1-5 with
an anchored rubric + rationale, rolled into a `quality_score`, plus a base set
of machine-checkable break signals every holding's reviewer can watch.

The per-portfolio buyer reads this card instead of re-deriving business quality
from raw numbers on every run — so the expensive thinking happens here, once,
amortized across all users, while the buyer's per-run call shrinks to a
mandate-fit judgment.

Rotation: the `top_n` stalest Tier-1 names by `ai_analysis.researched_at`
(NULLs first), via `level0_eval.tier1_eval_candidates(db, "research", N)`.
Writes ONLY `ai_analysis` (the card is a Level 0 concept). Per-ticker LLM call
(structured JSON), parallelised — robust to one bad response.

Schedule: daily ~04:15 UTC, alongside bull/bear.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone

from dotenv import load_dotenv

from db import SupabaseDB
from llm_providers import LLMProviderError, call_llm
from llm_picker import _parse_with_retry
# Reuse the buyer's signal validator + vocabulary so the card's break_signals
# are exactly what theses.check_thesis (the reviewer) can evaluate.
from llm_watchlist_buyer import _validate_signals, _ALLOWED_SIGNAL_FIELDS

logger = logging.getLogger("research_evaluation")

DEFAULTS = {
    "provider": "google",
    "model": "gemini-2.5-pro",
    "top_n": 100,
    "concurrency": 5,
    "per_call_timeout_sec": 90,
    "max_tokens": 32768,
    "temperature": 0.2,
    "max_break_signals": 5,
}

_DIMENSIONS = ("moat", "growth_durability", "earnings_quality", "balance_sheet_risk")

# Verified financials the card reasons over (companies-style keys, as assembled
# by level0_eval). At least one must be present or we DO NOT call the LLM — a
# card built without correct fundamentals is a hallucination.
_CORE_FINANCIAL_KEYS = (
    "rule_of_40", "gross_margin_pct", "net_margin_pct",
    "rev_growth_ttm_pct", "fcf_margin_pct", "operating_margin_pct",
)


def _has_verified_financials(equity: dict) -> bool:
    return any(equity.get(k) is not None for k in _CORE_FINANCIAL_KEYS)

# Noise keys not worth sending to the model (identity dupes / stale verdicts it
# shouldn't anchor on / large blobs).
_BLOCK_EXCLUDE = {
    "ticker", "company_name", "history_json", "flags", "sort_order",
    "in_tv_screen", "created_at", "updated_at", "scored_at", "data_updated_at",
    "ai_analyzed_at", "composite_score", "status", "research_card",
}

RESEARCH_SYSTEM_PROMPT = """\
You are a buy-side equity research analyst writing a concise, reusable research
card on ONE company. The card is shared across many portfolios, so judge the
BUSINESS on its own merits — not any single mandate, not the entry price.

Score each dimension 1-5 using these anchors (5 is always good/safe so they
roll up consistently):

MOAT (durability of the franchise):
  5 = wide, durable moat — pricing power, high switching costs, network effects
  3 = some differentiation, partial protection
  1 = commodity / no defensible advantage

GROWTH_DURABILITY (is the growth structural & repeatable):
  5 = secular, repeatable demand; long runway
  3 = mixed — real but maturing or partly cyclical
  1 = cyclical / one-off / demand pulled forward

EARNINGS_QUALITY (do earnings convert to cash, recurring vs one-off):
  5 = clean — FCF tracks/exceeds net income, recurring revenue
  3 = acceptable, some accrual or one-time noise
  1 = poor — earnings don't convert to cash, heavy one-time items

BALANCE_SHEET_RISK (downside guardrail — 5 = SAFEST):
  5 = net cash, ample runway, no dilution
  3 = manageable leverage / modest dilution
  1 = stretched balance sheet, cash burn, heavy dilution risk

Be discriminating — do NOT default everything to 4. Use the full 1-5 range; most
companies are average on most dimensions.

Also emit break_signals: a SHORT base set (max {max_break_signals}) of
machine-checkable conditions that, if they later become true, would mean the
business case has weakened — every portfolio holding this name inherits them.
Each is {{"field","op","value","description"}}.
- field MUST be one of: {allowed_fields}
- op MUST be one of: >, >=, <, <=, ==, !=, change_pct_lt, change_pct_gt
- value MUST be a number (never a string with "%"/"pp").

Use ONLY the data provided plus your general knowledge of the sector. Do not
invent company-specific numbers.

Output strict JSON only — no prose, no markdown fences."""

RESEARCH_USER_TEMPLATE = """\
COMPANY: {ticker} — {company_name}
SECTOR: {sector}   COUNTRY: {country}

DATA (Level 0 facts + prior in-house notes):
{equity_data_json}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "quality_score": <integer 1-5 — your overall read of the business>,
  "moat":               {{"score": <1-5>, "rationale": "<one line>", "evidence": "<one line>"}},
  "growth_durability":  {{"score": <1-5>, "rationale": "<one line>", "evidence": "<one line>"}},
  "earnings_quality":   {{"score": <1-5>, "rationale": "<one line>", "evidence": "<one line>"}},
  "balance_sheet_risk": {{"score": <1-5>, "rationale": "<one line>", "evidence": "<one line>"}},
  "break_signals": [{{"field": "...", "op": "...", "value": <number>, "description": "..."}}]
}}
Output JSON only."""


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def _equity_block(equity: dict) -> str:
    """Compact JSON of the equity's facts for the prompt (drops noise keys)."""
    clean = {
        k: v for k, v in equity.items()
        if k not in _BLOCK_EXCLUDE and not k.startswith("_") and v not in (None, "", "—")
    }
    return json.dumps(clean, default=str, ensure_ascii=False)


def _clamp_score(v) -> int | None:
    try:
        return max(1, min(5, int(round(float(v)))))
    except (TypeError, ValueError):
        return None


def _build_card(parsed: dict, model: str, max_break_signals: int) -> dict | None:
    """Validate the LLM JSON into a stored research_card, or None if unusable."""
    card: dict = {"version": 1, "model": model}
    dims_ok = 0
    for dim in _DIMENSIONS:
        d = parsed.get(dim)
        if not isinstance(d, dict):
            continue
        score = _clamp_score(d.get("score"))
        if score is None:
            continue
        card[dim] = {
            "score": score,
            "rationale": str(d.get("rationale") or "").strip()[:240],
            "evidence": str(d.get("evidence") or "").strip()[:240],
        }
        dims_ok += 1
    if dims_ok == 0:
        return None  # nothing usable — skip the write rather than store junk

    q = _clamp_score(parsed.get("quality_score"))
    if q is None:
        # Fall back to the mean of the scored dimensions.
        scores = [card[d]["score"] for d in _DIMENSIONS if d in card]
        q = max(1, min(5, round(sum(scores) / len(scores))))
    card["quality_score"] = q

    card["break_signals"] = _validate_signals(
        parsed.get("break_signals"), max_count=max_break_signals
    )
    return card


def _evaluate_one(equity: dict, cfg: dict) -> dict:
    """One LLM research call for one equity. Returns {ticker, card} or {ticker, error}."""
    ticker = equity["ticker"]
    # Data-quality gate: never research a name without verified financials.
    if not _has_verified_financials(equity):
        return {"ticker": ticker, "error": "insufficient verified data — skipped"}
    system = RESEARCH_SYSTEM_PROMPT.format(
        max_break_signals=cfg["max_break_signals"],
        allowed_fields=", ".join(sorted(_ALLOWED_SIGNAL_FIELDS)),
    )
    user = RESEARCH_USER_TEMPLATE.format(
        ticker=ticker,
        company_name=equity.get("company_name") or ticker,
        sector=equity.get("sector") or "—",
        country=equity.get("country") or "—",
        equity_data_json=_equity_block(equity),
    )
    try:
        resp = call_llm(
            provider=cfg["provider"], model=cfg["model"],
            system=system, user=user,
            max_tokens=cfg["max_tokens"], temperature=cfg["temperature"],
        )
    except LLMProviderError as exc:
        return {"ticker": ticker, "error": f"LLM call failed: {exc}"}
    try:
        parsed, _retry = _parse_with_retry(cfg["provider"], cfg["model"], resp.text, system=system)
    except LLMProviderError as exc:
        return {"ticker": ticker, "error": f"JSON parse failed: {exc}"}

    card = _build_card(parsed, cfg["model"], cfg["max_break_signals"])
    if card is None:
        return {"ticker": ticker, "error": "no usable dimension scores"}
    return {"ticker": ticker, "card": card}


def main(argv=None) -> int:
    load_dotenv()
    _setup_logging()
    ap = argparse.ArgumentParser(description="Research Evaluation — shared per-equity card")
    ap.add_argument("--dry-run", action="store_true", help="evaluate but write nothing")
    ap.add_argument("--limit", type=int, default=DEFAULTS["top_n"],
                    help="max equities this run (default 100, the rotation batch)")
    ap.add_argument("--tickers", nargs="*", help="evaluate these tickers instead of the rotation")
    ap.add_argument("--model", default=DEFAULTS["model"])
    ap.add_argument("--provider", default=DEFAULTS["provider"])
    args = ap.parse_args(argv)

    cfg = {**DEFAULTS, "model": args.model, "provider": args.provider}
    db = SupabaseDB()
    import level0_eval

    if args.tickers:
        # Targeted run: assemble the same prompt rows for explicit tickers.
        tickers = [t.upper() for t in args.tickers]
        secs = {(s.get("ticker") or "").upper(): s for s in
                level0_eval._bulk(db, "securities", "ticker,name,country,gics_sector", tickers)}
        companies = {(c.get("ticker") or "").upper(): c for c in
                     level0_eval._bulk(db, "companies", "*", tickers)}
        funds = level0_eval._latest_by_ticker(
            level0_eval._bulk(db, "fundamentals", "*", tickers), "period_end")
        vals = level0_eval._latest_by_ticker(
            level0_eval._bulk(db, "valuation", "ticker,date,ps,ps_median_12m", tickers), "date")
        ai = db.get_ai_analysis(tickers)
        batch = [level0_eval._assemble(t, secs.get(t), funds.get(t), vals.get(t),
                                       companies.get(t), ai.get(t)) for t in tickers]
    else:
        batch = level0_eval.tier1_eval_candidates(db, "research", args.limit)

    logger.info("=== Research Evaluation: %d equities (dry_run=%s, model=%s) ===",
                len(batch), args.dry_run, cfg["model"])
    if not batch:
        logger.warning("nothing to evaluate")
        return 0

    start = time.time()
    cards: dict[str, dict] = {}
    errors: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=cfg["concurrency"]) as pool:
        futures = {pool.submit(_evaluate_one, eq, cfg): eq["ticker"] for eq in batch}
        for fut, ticker in list(futures.items()):
            try:
                res = fut.result(timeout=cfg["per_call_timeout_sec"])
            except FutureTimeoutError:
                errors[ticker] = "timeout"
                fut.cancel()
                continue
            except Exception as exc:  # noqa: BLE001
                errors[ticker] = f"unexpected: {exc}"
                continue
            if "error" in res:
                errors[ticker] = res["error"]
            else:
                cards[ticker] = res["card"]

    logger.info("scored %d / %d (%d errors)", len(cards), len(batch), len(errors))
    for t, c in list(cards.items())[:10]:
        logger.info("  %s quality=%d  moat=%s dur=%s eq=%s bs=%s  breaks=%d",
                    t, c["quality_score"],
                    c.get("moat", {}).get("score"), c.get("growth_durability", {}).get("score"),
                    c.get("earnings_quality", {}).get("score"), c.get("balance_sheet_risk", {}).get("score"),
                    len(c.get("break_signals", [])))
    if errors:
        logger.info("errors: %s", json.dumps(errors)[:1000])

    if args.dry_run:
        logger.info("[dry-run] no writes. (%.1fs)", time.time() - start)
        return 0

    now = datetime.now(timezone.utc).isoformat()
    rows = [
        {"ticker": t, "research_card": c, "researched_at": now, "analyzed_at": now}
        for t, c in cards.items()
    ]
    if rows:
        db.upsert_ai_analysis_batch(rows)
    db.log_run("research_evaluation", {
        "updated": len(rows), "skipped": len(batch) - len(rows), "errors": len(errors),
        "duration_secs": round(time.time() - start, 1),
        "details": {"batch_size": len(batch), "scored": len(cards)},
    })
    logger.info("=== Research Evaluation complete: %d cards written (%.1fs) ===",
                len(rows), time.time() - start)
    return 0


if __name__ == "__main__":
    sys.exit(main())
