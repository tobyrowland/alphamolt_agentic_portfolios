"""Two-stage LLM-driven portfolio picker.

Strategy: ``llm_pick``. Reads ``agents.config`` for provider + model and
asks the model to (1) shortlist up to 50 tickers from the daily compact
snapshot, (2) pick a 15-25 name portfolio with weights from the deeper
data on the shortlist. Trades are diffed against current holdings and
executed via PortfolioManager.

Per-agent config keys (all optional with sensible defaults):

    provider        anthropic | openai | deepseek | google
    model           SDK model id (e.g. "claude-opus-4-7")
    picker_mode     "two_stage" (default) | "single_full"
    snapshot_tier   "compact" | "extended" (default) | "full"
                    — only consulted in single_full mode; two_stage
                      uses compact for stage 1 and full for stage 2

Idempotence: each run reads the latest snapshot fresh, so on an unchanged
universe and unchanged model output the diff would be a no-op. In
practice LLMs are mildly stochastic — temperature is set low (0.2) but
not zero, so successive runs may produce small trades.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any

from agent_strategies import RebalanceContext, RebalanceResult
from db import SupabaseDB
from llm_providers import (
    ENV_VAR_FOR_PROVIDER,
    LLMProviderError,
    PROVIDERS,
    call_llm,
    parse_json_response,
)
from portfolio import PortfolioError

logger = logging.getLogger("llm_picker")


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

LLM_PICK_DEFAULTS = {
    "min_positions": 15,
    "max_positions": 25,
    "cash_reserve_pct": 0.02,
    "min_trade_usd": 500.0,
    "shortlist_max": 50,
    "picker_mode": "two_stage",
    "snapshot_tier": "extended",  # only used by single_full mode
    "stage1_max_tokens": 16384,
    "stage2_max_tokens": 16384,
    "temperature": 0.2,
}


# ---------------------------------------------------------------------------
# Snapshot loading (Python-side mirror of web/lib/universe-query.ts)
# ---------------------------------------------------------------------------


def _load_latest_snapshot(db: SupabaseDB, detail: str) -> dict | None:
    resp = (
        db.client.table("universe_snapshots")
        .select("snapshot_date, json")
        .eq("detail", detail)
        .order("snapshot_date", desc=True)
        .limit(1)
        .execute()
    )
    return resp.data[0] if resp.data else None


def _slice_tickers(snapshot_json: dict, tickers: set[str]) -> dict:
    upper = {t.upper() for t in tickers}
    filtered = [
        t for t in (snapshot_json.get("tickers") or [])
        if str(t.get("ticker") or "").upper() in upper
    ]
    return {
        **snapshot_json,
        "tickers": filtered,
        "ticker_count": len(filtered),
    }


def _us_listed_tickers(db: SupabaseDB) -> set[str]:
    """US-listed (USD-priced) tickers — the universe the picker/reviewer may
    consider.

    Sourced from Level 0 `securities`, which is US-exchange-listed **by
    construction** (universe_sync keeps only US-exchange listings; OTC/pink and
    foreign-primary names are excluded). Every active security therefore trades
    on a US venue in USD, so it's safe to treat as USD — the same FX guard the
    old `companies`-exchange filter provided. (Replaces a read of the retired
    `companies` table — see the Level 0 migration.)
    """
    return {
        str(s["ticker"]).upper()
        for s in db.get_all_securities(columns="ticker", status="active")
        if s.get("ticker")
    }


def _filter_snapshot_us_only(
    snapshot_json: dict, us_tickers: set[str],
) -> dict:
    """Drop non-US-listed tickers from the snapshot."""
    filtered = [
        t for t in (snapshot_json.get("tickers") or [])
        if str(t.get("ticker") or "").upper() in us_tickers
    ]
    return {
        **snapshot_json,
        "tickers": filtered,
        "ticker_count": len(filtered),
        "universe_filter": {
            **(snapshot_json.get("universe_filter") or {}),
            "us_listed_only": True,
        },
    }


# ---------------------------------------------------------------------------
# Prompt construction — kept in module-level constants so /u/<handle> can
# render them verbatim (Phase 7b)
# ---------------------------------------------------------------------------


STAGE1_SYSTEM_PROMPT = """\
You are a portfolio manager researching stocks for a $1M paper-money portfolio competing on a public leaderboard against other AI models.

You will be given:
1. A universe of screened companies with their current fundamentals.
2. The current portfolio state (cash + holdings).

Your task: pick UP TO 50 tickers you want to research further. You will get deeper historical data on those 50 in a follow-up call before making your final selection.

Be selective. The shortlist should reflect YOUR strategy — momentum, value, growth, quality, contrarian, whatever you find compelling. Different models making different shortlists is the whole point of this exercise.

Output strict JSON only. No prose, no markdown fences."""

STAGE1_USER_TEMPLATE = """\
{mandate_block}UNIVERSE (compact tier, snapshot {snapshot_date}):
{universe_json}

CURRENT PORTFOLIO:
{portfolio_json}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "shortlist": [
    {{"ticker": "XXX", "rationale": "<10-15 word reason>"}}
  ]
}}

Pick UP TO {shortlist_max} tickers. Fewer is fine if you can't justify {shortlist_max}.
Only tickers from the universe above are valid. Output JSON only."""


STAGE2_SYSTEM_PROMPT = """\
You are a portfolio manager finalizing a $1M paper-money portfolio.

You shortlisted these tickers from a wider universe in a prior call. Now you have their full historical fundamentals. Pick the 15-25 stocks you'd actually want to hold for the next week with weights and per-pick rationale.

Constraints:
- Choose between 15 and 25 tickers from the shortlist (no others).
- weight_pct values must sum to 95-100 (we keep a 0-5% cash reserve).
- US-listed only.
- One-line rationale per pick: what's the thesis?

Output strict JSON only. No prose, no markdown fences."""

STAGE2_USER_TEMPLATE = """\
{mandate_block}DEEP DATA on your shortlist (full tier, snapshot {snapshot_date}):
{universe_json}

YOUR STAGE 1 SHORTLIST (for context — your prior reasoning):
{stage1_json}

CURRENT PORTFOLIO:
{portfolio_json}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "picks": [
    {{"ticker": "XXX", "weight_pct": <number 0-100>, "rationale": "<15-25 word thesis>"}}
  ]
}}

Pick 15-25 tickers. weight_pct sum: 95-100. Output JSON only."""


SINGLE_FULL_SYSTEM_PROMPT = """\
You are a portfolio manager building a $1M paper-money portfolio competing against other AI models on a public leaderboard.

You will be given the full screened universe with historical fundamentals and the current portfolio state. Pick 15-25 stocks with weights and per-pick rationale.

Constraints:
- Choose between 15 and 25 tickers from the universe.
- weight_pct values must sum to 95-100 (we keep a 0-5% cash reserve).
- US-listed only.
- One-line rationale per pick: what's the thesis?

Output strict JSON only. No prose, no markdown fences."""

SINGLE_FULL_USER_TEMPLATE = """\
{mandate_block}UNIVERSE (snapshot {snapshot_date}):
{universe_json}

CURRENT PORTFOLIO:
{portfolio_json}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "picks": [
    {{"ticker": "XXX", "weight_pct": <number 0-100>, "rationale": "<15-25 word thesis>"}}
  ]
}}

Pick 15-25 tickers. weight_pct sum: 95-100. Output JSON only."""


def _mandate_block(mandate: str | None) -> str:
    """Render a portfolio mandate as a prompt preamble, or '' when absent.

    Human-owned portfolios (migration 024+) carry a free-text mandate in
    ``portfolios.description``. When present it is prepended to the picker's
    user prompt so the LLM trades to the owner's brief. Legacy 1:1 agent
    portfolios have no mandate — the block is empty and the prompt is byte
    identical to before.
    """
    text = (mandate or "").strip()
    if not text:
        return ""
    return (
        "PORTFOLIO MANDATE (the human owner's investment instructions — "
        "honour these):\n"
        f"{text}\n\n"
    )


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def _validate_shortlist(
    raw: dict,
    universe_tickers: set[str],
    cap: int,
) -> tuple[list[dict], list[str]]:
    """Return (clean shortlist entries, dropped tickers)."""
    items = raw.get("shortlist") or raw.get("picks") or []
    if not isinstance(items, list):
        raise LLMProviderError("stage 1 response missing 'shortlist' array")
    clean: list[dict] = []
    seen: set[str] = set()
    dropped: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        ticker = str(item.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        if ticker not in universe_tickers:
            dropped.append(ticker)
            continue
        if ticker in seen:
            continue
        seen.add(ticker)
        clean.append({
            "ticker": ticker,
            "rationale": str(item.get("rationale") or "").strip(),
        })
        if len(clean) >= cap:
            break
    return clean, dropped


def _validate_picks(
    raw: dict,
    valid_tickers: set[str],
    min_picks: int,
    max_picks: int,
) -> tuple[list[dict], list[str]]:
    """Return (clean picks, dropped tickers).

    Picks beyond max_picks are truncated; missing weight_pct → 0 (filtered
    out below). Caller is responsible for normalising weights to 100.
    """
    items = raw.get("picks") or []
    if not isinstance(items, list):
        raise LLMProviderError("stage 2 response missing 'picks' array")
    clean: list[dict] = []
    seen: set[str] = set()
    dropped: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        ticker = str(item.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        if ticker not in valid_tickers:
            dropped.append(ticker)
            continue
        if ticker in seen:
            continue
        try:
            weight = float(item.get("weight_pct") or 0)
        except (TypeError, ValueError):
            weight = 0.0
        if weight <= 0:
            continue
        seen.add(ticker)
        clean.append({
            "ticker": ticker,
            "weight_pct": weight,
            "rationale": str(item.get("rationale") or "").strip(),
        })
        if len(clean) >= max_picks:
            break
    if len(clean) < min_picks:
        # Don't raise — partial allocation is better than skipping the rebalance.
        # The orchestrator journals a warning instead.
        logger.warning(
            "stage 2 returned only %d picks (min=%d) — proceeding with partial",
            len(clean), min_picks,
        )
    return clean, dropped


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------


def rebalance_llm_pick(ctx: RebalanceContext) -> RebalanceResult:
    """Run the LLM picker and execute trades against the result."""
    result = RebalanceResult()
    params = {**LLM_PICK_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])
    # When operating a human-owned portfolio, ctx.mandate carries the owner's
    # brief; it is prepended to every picker prompt. Empty for legacy agents.
    mandate_block = _mandate_block(ctx.mandate)

    provider = params.get("provider")
    model = params.get("model")
    if not provider or provider not in PROVIDERS:
        result.errors.append(
            f"agents.config.provider missing or invalid (got {provider!r}). "
            f"Expected one of: {', '.join(PROVIDERS)}"
        )
        return result
    if not model:
        result.errors.append("agents.config.model missing")
        return result

    picker_mode = params["picker_mode"]
    if picker_mode not in ("two_stage", "single_full"):
        result.errors.append(f"unknown picker_mode: {picker_mode!r}")
        return result

    # Load the snapshot(s) we need.
    stage1_tier = "compact" if picker_mode == "two_stage" else params["snapshot_tier"]
    snap_row = _load_latest_snapshot(ctx.db, stage1_tier)
    if not snap_row:
        result.errors.append(
            f"no universe snapshot at detail='{stage1_tier}'. "
            f"Build one via build_universe_snapshot.py."
        )
        return result

    # Filter snapshot to US-listed tickers (incl. ADRs). Non-US listings
    # are priced in their native currency but the portfolio layer treats
    # every price as USD — until we add FX, hide foreign listings entirely.
    us_tickers = _us_listed_tickers(ctx.db)
    snapshot_json = _filter_snapshot_us_only(snap_row["json"], us_tickers)
    snapshot_date = snap_row["snapshot_date"]
    universe_tickers = {
        str(t.get("ticker") or "").upper()
        for t in (snapshot_json.get("tickers") or [])
        if t.get("ticker")
    }

    # Portfolio state — feeds into both prompt and trade diffing.
    portfolio = ctx.get_book()
    total_value = float(portfolio["total_value_usd"])
    if total_value <= 0:
        result.errors.append(f"total_value_usd <= 0 for agent {handle}")
        return result

    portfolio_summary = {
        "cash_usd": round(float(portfolio["cash_usd"]), 2),
        "total_value_usd": round(total_value, 2),
        "holdings": [
            {
                "ticker": h["ticker"],
                "quantity": float(h["quantity"]),
                "avg_cost_usd": float(h["avg_cost_usd"]),
            }
            for h in portfolio["holdings"]
        ],
    }

    notes: dict[str, Any] = {
        "snapshot_date": snapshot_date,
        "provider": provider,
        "model": model,
        "picker_mode": picker_mode,
        "has_mandate": bool(ctx.mandate),
    }

    # ----- Stage 1: shortlist (two_stage only) -----
    shortlist: list[dict] | None = None
    if picker_mode == "two_stage":
        try:
            stage1_json, shortlist, dropped, usage, retry_text = _run_stage1(
                provider=provider,
                model=model,
                snapshot=snapshot_json,
                snapshot_date=snapshot_date,
                portfolio=portfolio_summary,
                universe_tickers=universe_tickers,
                params=params,
                mandate_block=mandate_block,
            )
        except LLMProviderError as exc:
            result.errors.append(f"stage 1 failed: {exc}")
            notes["stage1_error"] = str(exc)
            result.notes = notes
            return result

        notes["stage1"] = {
            "shortlist": shortlist,
            "shortlist_count": len(shortlist),
            "dropped_invalid_tickers": dropped,
            "raw_response_kb": len(stage1_json) // 1024,
            "raw_response": stage1_json[:8000],
            "raw_response_retry": retry_text[:8000] if retry_text else None,
            "input_tokens": usage[0],
            "output_tokens": usage[1],
        }
        if not shortlist:
            result.errors.append("stage 1 returned empty shortlist")
            result.notes = notes
            return result

        # Reload the snapshot at full tier, sliced to the shortlist.
        full_row = _load_latest_snapshot(ctx.db, "full")
        if not full_row:
            result.errors.append("no 'full' snapshot — stage 2 needs deep data")
            result.notes = notes
            return result
        if full_row["snapshot_date"] != snapshot_date:
            # Compact + full are written by the same script in lockstep, so
            # this would be a real anomaly. Bail rather than mix dates.
            result.errors.append(
                f"snapshot date mismatch: compact={snapshot_date} full={full_row['snapshot_date']}"
            )
            result.notes = notes
            return result
        deep_snapshot = _slice_tickers(
            _filter_snapshot_us_only(full_row["json"], us_tickers),
            {p["ticker"] for p in shortlist},
        )
        valid_after_stage1 = {p["ticker"] for p in shortlist}
    else:
        deep_snapshot = snapshot_json
        valid_after_stage1 = universe_tickers

    # ----- Stage 2 / single-pass: final picks -----
    try:
        if picker_mode == "two_stage":
            stage2_json, picks, dropped, usage, retry_text = _run_stage2(
                provider=provider,
                model=model,
                snapshot=deep_snapshot,
                snapshot_date=snapshot_date,
                shortlist=shortlist or [],
                portfolio=portfolio_summary,
                valid_tickers=valid_after_stage1,
                params=params,
                mandate_block=mandate_block,
            )
            stage_label = "stage2"
        else:
            stage2_json, picks, dropped, usage, retry_text = _run_single_full(
                provider=provider,
                model=model,
                snapshot=deep_snapshot,
                snapshot_date=snapshot_date,
                portfolio=portfolio_summary,
                valid_tickers=valid_after_stage1,
                params=params,
                mandate_block=mandate_block,
            )
            stage_label = "single"
    except LLMProviderError as exc:
        result.errors.append(f"final stage failed: {exc}")
        notes[f"{'stage2' if picker_mode == 'two_stage' else 'single'}_error"] = str(exc)
        result.notes = notes
        return result

    notes[stage_label] = {
        "picks": picks,
        "pick_count": len(picks),
        "dropped_invalid_tickers": dropped,
        "raw_response_kb": len(stage2_json) // 1024,
        "raw_response": stage2_json[:8000],
        "raw_response_retry": retry_text[:8000] if retry_text else None,
        "input_tokens": usage[0],
        "output_tokens": usage[1],
    }

    if not picks:
        result.errors.append("final stage returned no valid picks")
        result.notes = notes
        return result

    # ----- Plan trades: diff target portfolio against current holdings -----
    trades_planned = _plan_trades(
        ctx, picks, portfolio, total_value, params,
    )
    notes["trades_planned"] = {
        "buys": [{"ticker": t, "qty": q, "rationale": r} for (t, q, r) in trades_planned["buys"]],
        "sells": [{"ticker": t, "qty": q, "rationale": r} for (t, q, r) in trades_planned["sells"]],
        "unpriced": trades_planned["unpriced"],
        "noise_skipped": trades_planned["noise_skipped"],
    }

    # ----- Execute (or stop, if dry-run) -----
    if ctx.dry_run:
        logger.info(
            "[dry-run] %s: %d sells, %d buys (%s)",
            handle, len(trades_planned["sells"]),
            len(trades_planned["buys"]), provider,
        )
        result.notes = notes
        return result

    # Sells before buys to free cash.
    for ticker, qty, rationale in trades_planned["sells"]:
        try:
            ctx.sell(ticker, qty, note=rationale)
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"sell {ticker} x{qty}: {exc}")

    for ticker, qty, rationale in trades_planned["buys"]:
        try:
            ctx.buy(ticker, qty, note=rationale)
            result.buys += 1
        except PortfolioError as exc:
            # Cash drift between plan and execution is the most common
            # failure mode. Partial fills are acceptable.
            result.errors.append(f"buy {ticker} x{qty}: {exc}")

    result.notes = notes
    return result


# ---------------------------------------------------------------------------
# Stage runners — separated so the prompt + parsing logic stays linear
# ---------------------------------------------------------------------------


def pick_shortlist_via_llm(
    *,
    provider: str,
    model: str,
    snapshot: dict,
    snapshot_date: str,
    portfolio: dict,
    universe_tickers: set[str],
    system_prompt: str,
    user_template: str,
    shortlist_max: int,
    max_tokens: int = 16384,
    temperature: float = 0.2,
    mandate_block: str = "",
) -> tuple[str, list[dict], list[str], tuple[int | None, int | None], str | None]:
    """Reusable shortlist call — used by llm_pick stage 1.

    ``user_template`` must accept the keyword args ``snapshot_date``,
    ``universe_json``, ``portfolio_json``, ``shortlist_max`` via str.format.
    Validation: keeps only tickers in ``universe_tickers``, dedupes, caps
    at ``shortlist_max``, drops entries with missing/blank tickers.

    Returns (raw_text, shortlist, dropped, (input_tokens, output_tokens),
    retry_text). ``retry_text`` is None when the first parse succeeded;
    otherwise it's the second LLM call's response text (useful for journals).
    """
    user = user_template.format(
        snapshot_date=snapshot_date,
        universe_json=json.dumps(snapshot, separators=(",", ":")),
        portfolio_json=json.dumps(portfolio, separators=(",", ":")),
        shortlist_max=shortlist_max,
        mandate_block=mandate_block,
    )
    resp = call_llm(
        provider=provider,
        model=model,
        system=system_prompt,
        user=user,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    parsed, retry_resp = _parse_with_retry(
        provider, model, resp.text, system=system_prompt,
    )
    shortlist, dropped = _validate_shortlist(
        parsed, universe_tickers, cap=shortlist_max,
    )
    return (
        resp.text,
        shortlist,
        dropped,
        (resp.input_tokens, resp.output_tokens),
        retry_resp.text if retry_resp else None,
    )


def _run_stage1(
    *,
    provider: str,
    model: str,
    snapshot: dict,
    snapshot_date: str,
    portfolio: dict,
    universe_tickers: set[str],
    params: dict,
    mandate_block: str = "",
) -> tuple[str, list[dict], list[str], tuple[int | None, int | None], str | None]:
    return pick_shortlist_via_llm(
        provider=provider,
        model=model,
        snapshot=snapshot,
        snapshot_date=snapshot_date,
        portfolio=portfolio,
        universe_tickers=universe_tickers,
        system_prompt=STAGE1_SYSTEM_PROMPT,
        user_template=STAGE1_USER_TEMPLATE,
        shortlist_max=int(params["shortlist_max"]),
        max_tokens=int(params["stage1_max_tokens"]),
        temperature=float(params["temperature"]),
        mandate_block=mandate_block,
    )


def _run_stage2(
    *,
    provider: str,
    model: str,
    snapshot: dict,
    snapshot_date: str,
    shortlist: list[dict],
    portfolio: dict,
    valid_tickers: set[str],
    params: dict,
    mandate_block: str = "",
) -> tuple[str, list[dict], list[str], tuple[int | None, int | None], str | None]:
    user = STAGE2_USER_TEMPLATE.format(
        snapshot_date=snapshot_date,
        universe_json=json.dumps(snapshot, separators=(",", ":")),
        stage1_json=json.dumps({"shortlist": shortlist}, separators=(",", ":")),
        portfolio_json=json.dumps(portfolio, separators=(",", ":")),
        mandate_block=mandate_block,
    )
    resp = call_llm(
        provider=provider,
        model=model,
        system=STAGE2_SYSTEM_PROMPT,
        user=user,
        max_tokens=int(params["stage2_max_tokens"]),
        temperature=float(params["temperature"]),
    )
    parsed, retry_resp = _parse_with_retry(
        provider, model, resp.text, system=STAGE2_SYSTEM_PROMPT,
    )
    picks, dropped = _validate_picks(
        parsed, valid_tickers,
        min_picks=int(params["min_positions"]),
        max_picks=int(params["max_positions"]),
    )
    return (
        resp.text,
        picks,
        dropped,
        (resp.input_tokens, resp.output_tokens),
        retry_resp.text if retry_resp else None,
    )


def _run_single_full(
    *,
    provider: str,
    model: str,
    snapshot: dict,
    snapshot_date: str,
    portfolio: dict,
    valid_tickers: set[str],
    params: dict,
    mandate_block: str = "",
) -> tuple[str, list[dict], list[str], tuple[int | None, int | None], str | None]:
    user = SINGLE_FULL_USER_TEMPLATE.format(
        snapshot_date=snapshot_date,
        universe_json=json.dumps(snapshot, separators=(",", ":")),
        portfolio_json=json.dumps(portfolio, separators=(",", ":")),
        mandate_block=mandate_block,
    )
    resp = call_llm(
        provider=provider,
        model=model,
        system=SINGLE_FULL_SYSTEM_PROMPT,
        user=user,
        max_tokens=int(params["stage2_max_tokens"]),
        temperature=float(params["temperature"]),
    )
    parsed, retry_resp = _parse_with_retry(
        provider, model, resp.text, system=SINGLE_FULL_SYSTEM_PROMPT,
    )
    picks, dropped = _validate_picks(
        parsed, valid_tickers,
        min_picks=int(params["min_positions"]),
        max_picks=int(params["max_positions"]),
    )
    return (
        resp.text,
        picks,
        dropped,
        (resp.input_tokens, resp.output_tokens),
        retry_resp.text if retry_resp else None,
    )


def _parse_with_retry(
    provider: str,
    model: str,
    text: str,
    *,
    system: str,
) -> tuple[dict, "LLMResponse | None"]:
    """Parse JSON; on failure, retry once with an explicit nudge.

    Returns (parsed_dict, retry_response). retry_response is None when the
    first attempt parsed cleanly; otherwise it's the LLMResponse from the
    nudge call (whose .text the caller can journal for debugging).
    """
    try:
        return parse_json_response(text), None
    except LLMProviderError:
        pass
    # Retry: ask the model to re-emit just the JSON.
    nudge_system = system + "\n\nIMPORTANT: your previous response was not valid JSON. Output ONLY the JSON object, with no prose, no fences, no leading or trailing text."
    nudge_user = (
        "Your previous response could not be parsed as JSON. Please retry — "
        "output ONLY the JSON object specified by the schema, nothing else."
    )
    resp = call_llm(
        provider=provider,
        model=model,
        system=nudge_system,
        user=nudge_user,
        max_tokens=16384,
        temperature=0.1,
    )
    return parse_json_response(resp.text), resp


# ---------------------------------------------------------------------------
# Trade planning
# ---------------------------------------------------------------------------


def _plan_trades(
    ctx: RebalanceContext,
    picks: list[dict],
    portfolio: dict,
    total_value: float,
    params: dict,
) -> dict:
    """Compute buys + sells to move from current holdings to target picks."""
    cash_reserve = float(params["cash_reserve_pct"])
    min_trade = float(params["min_trade_usd"])
    investable = total_value * (1.0 - cash_reserve)

    # Normalise weights to sum exactly to 1.0 — the model may return 95-100;
    # we treat the residual as an adjustment to the cash buffer rather than
    # leaving the portfolio over- or under-allocated.
    total_weight = sum(p["weight_pct"] for p in picks)
    if total_weight <= 0:
        return {"buys": [], "sells": [], "unpriced": [], "noise_skipped": []}

    target_qty: dict[str, int] = {}
    rationale_for: dict[str, str] = {}
    unpriced: list[str] = []
    for pick in picks:
        ticker = pick["ticker"]
        try:
            price = ctx.pm.get_price(ticker)
        except PortfolioError:
            unpriced.append(ticker)
            continue
        target_usd = investable * (pick["weight_pct"] / total_weight)
        qty = int(math.floor(target_usd / price)) if price > 0 else 0
        target_qty[ticker] = qty
        rationale_for[ticker] = pick.get("rationale") or ""

    current_qty = {h["ticker"]: float(h["quantity"]) for h in portfolio["holdings"]}

    sells: list[tuple[str, float, str]] = []
    buys: list[tuple[str, int, str]] = []
    noise_skipped: list[dict] = []

    # Phase 1: positions to exit or trim.
    for ticker, held in current_qty.items():
        want = target_qty.get(ticker, 0)
        delta = held - want
        if delta <= 0:
            continue
        try:
            price = ctx.pm.get_price(ticker)
        except PortfolioError:
            unpriced.append(ticker)
            continue
        if delta * price < min_trade and ticker in target_qty:
            noise_skipped.append({
                "ticker": ticker, "side": "sell",
                "qty": delta, "usd": round(delta * price, 2),
            })
            continue
        reason = (
            f"Sold {ticker} — dropped from target portfolio."
            if want == 0
            else f"Sold {ticker} — trimming to target weight ({rationale_for.get(ticker, '')})"
        )
        sells.append((ticker, delta, reason))

    # Phase 2: new positions and add-ons.
    for ticker, want in target_qty.items():
        held = current_qty.get(ticker, 0.0)
        delta = want - held
        if delta <= 0:
            continue
        try:
            price = ctx.pm.get_price(ticker)
        except PortfolioError:
            continue
        if delta * price < min_trade:
            noise_skipped.append({
                "ticker": ticker, "side": "buy",
                "qty": delta, "usd": round(delta * price, 2),
            })
            continue
        rationale = rationale_for.get(ticker) or ""
        note = f"Bought {ticker} — {rationale}" if rationale else f"Bought {ticker} (LLM pick)"
        buys.append((ticker, int(delta), note))

    return {
        "buys": buys,
        "sells": sells,
        "unpriced": sorted(set(unpriced)),
        "noise_skipped": noise_skipped,
    }


# ---------------------------------------------------------------------------
# Registry hook — imported by agent_strategies.py
# ---------------------------------------------------------------------------


def env_var_hint(provider: str) -> str:
    """Surface the env var a given provider expects, for log + journal use."""
    return ENV_VAR_FOR_PROVIDER.get(provider, "<unknown>")
