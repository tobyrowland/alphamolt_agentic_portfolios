"""TradingAgents-as-house-agent strategy.

Strategy: ``trading_agents``. Runs the upstream TauricResearch/TradingAgents
multi-agent framework as a fully-featured arena competitor, varied only by
the underlying LLM (Claude Opus 4.7, Gemini 3 Pro, Qwen 3, …). Three stages:

    1. Stage 1 — Shortlist: the variant's own deep-think LLM reads the
       compact universe snapshot and picks ~30 tickers worth a deep dive.
       Mirrors the existing ``llm_pick`` stage-1 pattern but uses a
       different prompt geared toward "what's worth a multi-analyst
       investigation" rather than "what's your final portfolio".

    2. Stage 2 — Deep dive: for each shortlisted ticker, instantiates
       ``TradingAgentsGraph(config).propagate(ticker, today_iso)`` and
       extracts a BUY / SELL / HOLD decision. The framework runs its
       full debate machinery (4 analysts + bull/bear researchers +
       trader + risk team + reflection memory) per ticker.

    3. Stage 3 — Reconcile: maps decisions to target weights
       (equal-weight BUYs with a cash reserve), diffs against current
       holdings, executes sells then buys via PortfolioManager.

Per-agent config (set on agents.config JSONB by bootstrap_trading_agents.py):

    llm_provider       "anthropic" | "google" | "qwen" | ...
    deep_think_llm     SDK model id used for analysts/researchers/risk
    quick_think_llm    SDK model id used for shorter analyst summaries
    backend_url        OpenAI-compatible endpoint for openai-like providers
    max_debate_rounds  How many bull/bear debate rounds (default 2)
    max_candidates     Stage-1 shortlist size (default 30)
    max_positions      Target portfolio breadth (default 20)
    cash_reserve_pct   Cash buffer (default 0.02)

Idempotence: re-running on the same universe + memory should produce
near-identical decisions (LLM stochasticity aside).
"""

from __future__ import annotations

import logging
import math
import os
import re
from datetime import date
from typing import Any

from agent_strategies import RebalanceContext, RebalanceResult
from llm_picker import (
    _filter_snapshot_us_only,
    _load_latest_snapshot,
    _us_listed_tickers,
    pick_shortlist_via_llm,
)
from llm_providers import LLMProviderError, PROVIDERS
from portfolio import PortfolioError

logger = logging.getLogger("trading_agents_strategy")


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

TRADING_AGENTS_DEFAULTS = {
    "max_candidates": 30,        # stage-1 shortlist size
    "max_positions": 20,         # equal-weight cap for BUY targets
    "position_floor": 15,        # build mode: while holdings < this, suppress
                                 # SELLs on held tickers + keep them as implicit
                                 # BUYs so the portfolio grows toward the floor
                                 # over successive heartbeats
    "cash_reserve_pct": 0.02,
    "min_trade_usd": 500.0,
    "max_debate_rounds": 2,
    "stage1_max_tokens": 16384,
    "temperature": 0.2,
    "online_tools": True,        # let TradingAgents fetch live news/data
}


# ---------------------------------------------------------------------------
# Stage 1 — shortlist prompts
# ---------------------------------------------------------------------------

SHORTLIST_SYSTEM_PROMPT = """\
You are a portfolio researcher selecting equities for a deep multi-analyst dive.

A separate downstream pipeline will run a full fundamental / sentiment / news / technical analyst debate on every ticker you shortlist, then derive a BUY / SELL / HOLD decision per ticker. Your job is to pick the candidates worth that investigation.

Be selective. Reflect YOUR own analytic style — momentum, value, growth, quality, contrarian, whatever you find compelling. The variants of this system are wired to different LLMs so we can compare which picks better; different shortlists from different brains are the whole point.

Output strict JSON only. No prose, no markdown fences."""

SHORTLIST_USER_TEMPLATE = """\
UNIVERSE (compact tier, snapshot {snapshot_date}):
{universe_json}

CURRENT PORTFOLIO:
{portfolio_json}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "shortlist": [
    {{"ticker": "XXX", "rationale": "<10-15 word reason this deserves a deep dive>"}}
  ]
}}

Pick UP TO {shortlist_max} tickers from the universe above. Fewer is fine if you can't justify {shortlist_max}.
Include current holdings only if you'd genuinely want them re-examined; otherwise the downstream stage will default HOLD on positions you skip.
Only tickers from the universe above are valid. Output JSON only."""


# ---------------------------------------------------------------------------
# Decision extraction
# ---------------------------------------------------------------------------

# TradingAgents' final trader/risk output can vary by LLM but reliably
# contains one of these tokens. We parse defensively: look for the
# clearest signal in the last few lines of the decision text.
_DECISION_TOKENS = ("BUY", "SELL", "HOLD")


def _extract_decision(decision_text: str) -> str:
    """Normalise the trader/risk manager output to BUY | SELL | HOLD.

    TradingAgents returns a string like "FINAL TRANSACTION PROPOSAL: **BUY**"
    or sometimes just "Buy" / "Hold" in the last paragraph. We scan
    backwards through the text — the final verdict is more reliable than
    early-paragraph mentions of competing options.
    """
    text = (decision_text or "").strip()
    if not text:
        return "HOLD"

    # Prefer an explicit "FINAL TRANSACTION PROPOSAL" line if present.
    final_match = re.search(
        r"FINAL\s+TRANSACTION\s+PROPOSAL[^A-Z]*\*{0,2}\s*(BUY|SELL|HOLD)",
        text,
        re.IGNORECASE,
    )
    if final_match:
        return final_match.group(1).upper()

    # Otherwise scan from the end for a clean token.
    upper = text.upper()
    last_idx = -1
    last_token = "HOLD"
    for token in _DECISION_TOKENS:
        idx = upper.rfind(token)
        if idx > last_idx:
            last_idx = idx
            last_token = token
    return last_token


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------


def rebalance_trading_agents(ctx: RebalanceContext) -> RebalanceResult:
    """Run the TradingAgents-driven rebalance for one agent.

    Lazy-imports the upstream framework so this module is cheap to load
    even when TradingAgents isn't installed (e.g. for momentum heartbeats
    on the shared GHA runner).
    """
    result = RebalanceResult()
    params = {**TRADING_AGENTS_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    provider = params.get("llm_provider") or params.get("provider")
    deep_model = params.get("deep_think_llm")
    quick_model = params.get("quick_think_llm") or deep_model
    if not provider or provider not in PROVIDERS:
        result.errors.append(
            f"agents.config.llm_provider missing or invalid (got {provider!r}). "
            f"Expected one of: {', '.join(PROVIDERS)}"
        )
        return result
    if not deep_model:
        result.errors.append("agents.config.deep_think_llm missing")
        return result

    # Load universe snapshot (compact tier — same source as llm_pick).
    snap_row = _load_latest_snapshot(ctx.db, "compact")
    if not snap_row:
        result.errors.append(
            "no compact universe snapshot — run build_universe_snapshot.py"
        )
        return result
    us_tickers = _us_listed_tickers(ctx.db)
    snapshot_json = _filter_snapshot_us_only(snap_row["json"], us_tickers)
    snapshot_date = snap_row["snapshot_date"]
    universe_tickers = {
        str(t.get("ticker") or "").upper()
        for t in (snapshot_json.get("tickers") or [])
        if t.get("ticker")
    }

    portfolio = ctx.pm.get_portfolio(ctx.agent["id"])
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
        "deep_think_llm": deep_model,
        "quick_think_llm": quick_model,
    }

    # ------------------------------------------------------------------
    # Stage 1: shortlist — delegates to the shared helper in llm_picker.py
    # so prompt/parsing logic stays single-source-of-truth.
    # ------------------------------------------------------------------
    try:
        stage1_raw, shortlist, stage1_dropped, stage1_usage, stage1_retry = (
            pick_shortlist_via_llm(
                provider=provider,
                model=deep_model,
                snapshot=snapshot_json,
                snapshot_date=snapshot_date,
                portfolio=portfolio_summary,
                universe_tickers=universe_tickers,
                system_prompt=SHORTLIST_SYSTEM_PROMPT,
                user_template=SHORTLIST_USER_TEMPLATE,
                shortlist_max=int(params["max_candidates"]),
                max_tokens=int(params["stage1_max_tokens"]),
                temperature=float(params["temperature"]),
            )
        )
    except LLMProviderError as exc:
        result.errors.append(f"stage 1 (shortlist) failed: {exc}")
        notes["stage1_error"] = str(exc)
        result.notes = notes
        return result

    notes["stage1"] = {
        "shortlist": shortlist,
        "shortlist_count": len(shortlist),
        "dropped_invalid_tickers": stage1_dropped,
        "input_tokens": stage1_usage[0],
        "output_tokens": stage1_usage[1],
        "raw_response_kb": len(stage1_raw) // 1024,
        "raw_response_retry_kb": (len(stage1_retry) // 1024) if stage1_retry else None,
    }
    if not shortlist:
        result.errors.append("stage 1 returned empty shortlist")
        result.notes = notes
        return result

    # Always include current holdings in the deep-dive set so existing
    # positions get re-evaluated (otherwise we'd silently hold forever).
    deep_dive_tickers: list[str] = []
    seen: set[str] = set()
    for entry in shortlist:
        t = entry["ticker"]
        if t in seen:
            continue
        seen.add(t)
        deep_dive_tickers.append(t)
    for holding in portfolio_summary["holdings"]:
        t = str(holding["ticker"]).upper()
        if t in seen:
            continue
        if t not in universe_tickers:
            # Holdings outside the current screener — still re-evaluate
            # so the strategy can exit them if TradingAgents says SELL.
            pass
        seen.add(t)
        deep_dive_tickers.append(t)

    # Hard cap so a runaway holding count can't blow the LLM budget.
    cap = int(params["max_candidates"]) + len(portfolio_summary["holdings"])
    deep_dive_tickers = deep_dive_tickers[:cap]
    notes["deep_dive_tickers"] = deep_dive_tickers

    # ------------------------------------------------------------------
    # Stage 2: TradingAgents deep dive per ticker
    # ------------------------------------------------------------------
    try:
        ta_graph = _build_trading_agents_graph(provider, deep_model, quick_model, params)
    except (ImportError, RuntimeError) as exc:
        result.errors.append(f"could not initialise TradingAgents: {exc}")
        notes["framework_init_error"] = str(exc)
        result.notes = notes
        return result

    today_iso = date.today().isoformat()
    decisions: list[dict] = []
    deep_dive_errors: list[dict] = []
    buys_tickers: list[str] = []
    sells_tickers: list[str] = []
    for ticker in deep_dive_tickers:
        try:
            _final_state, raw_decision = ta_graph.propagate(ticker, today_iso)
        except Exception as exc:  # noqa: BLE001 — framework can raise anything
            deep_dive_errors.append({"ticker": ticker, "error": str(exc)[:300]})
            continue
        verdict = _extract_decision(str(raw_decision or ""))
        decisions.append({
            "ticker": ticker,
            "decision": verdict,
            "raw_excerpt": str(raw_decision or "")[:600],
        })
        if verdict == "BUY":
            buys_tickers.append(ticker)
        elif verdict == "SELL":
            sells_tickers.append(ticker)

    notes["stage2"] = {
        "decisions": decisions,
        "decision_count": len(decisions),
        "buy_count": len(buys_tickers),
        "sell_count": len(sells_tickers),
        "hold_count": sum(1 for d in decisions if d["decision"] == "HOLD"),
        "framework_errors": deep_dive_errors,
    }
    if deep_dive_errors:
        result.errors.extend(
            f"propagate {e['ticker']}: {e['error']}" for e in deep_dive_errors
        )
    if not decisions:
        result.errors.append("stage 2 produced no usable decisions")
        result.notes = notes
        return result

    # Build-mode ratchet (see ``_apply_build_mode`` for the logic).
    buys_tickers, sells_tickers, notes["build_mode"] = _apply_build_mode(
        buys_tickers=buys_tickers,
        sells_tickers=sells_tickers,
        current_holdings={h["ticker"] for h in portfolio["holdings"] if h["quantity"] > 0},
        position_floor=int(params.get("position_floor", 0)),
    )

    # ------------------------------------------------------------------
    # Stage 3: reconcile — equal-weight the BUYs, exit SELLs, hold the rest
    # ------------------------------------------------------------------
    target_qty, target_meta, unpriced = _equal_weight_targets(
        ctx=ctx,
        buy_tickers=buys_tickers,
        total_value=total_value,
        cash_reserve_pct=float(params["cash_reserve_pct"]),
        max_positions=int(params["max_positions"]),
    )
    if unpriced:
        notes["unpriced_buys"] = unpriced

    plan = _plan_trades(
        ctx=ctx,
        portfolio=portfolio,
        target_qty=target_qty,
        sells_tickers=set(sells_tickers),
        target_meta=target_meta,
        min_trade_usd=float(params["min_trade_usd"]),
    )
    notes["trades_planned"] = {
        "buys": [
            {"ticker": t, "qty": q, "note": n} for (t, q, n) in plan["buys"]
        ],
        "sells": [
            {"ticker": t, "qty": q, "note": n} for (t, q, n) in plan["sells"]
        ],
        "noise_skipped": plan["noise_skipped"],
    }

    # ------------------------------------------------------------------
    # Execute (or stop, for dry-run)
    # ------------------------------------------------------------------
    if ctx.dry_run:
        logger.info(
            "[dry-run] %s: stage1=%d, decisions=%d (buy=%d sell=%d), trades=%d/%d",
            handle, len(shortlist), len(decisions),
            len(buys_tickers), len(sells_tickers),
            len(plan["sells"]), len(plan["buys"]),
        )
        result.notes = notes
        return result

    for ticker, qty, note in plan["sells"]:
        try:
            ctx.pm.sell(ctx.agent["id"], ticker, qty, note=note)
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"sell {ticker} x{qty}: {exc}")

    for ticker, qty, note in plan["buys"]:
        try:
            ctx.pm.buy(ctx.agent["id"], ticker, qty, note=note)
            result.buys += 1
        except PortfolioError as exc:
            # Cash drift between plan and fill is the most common failure;
            # partial fills are acceptable.
            result.errors.append(f"buy {ticker} x{qty}: {exc}")

    result.notes = notes
    return result


# ---------------------------------------------------------------------------
# TradingAgents bootstrapping
# ---------------------------------------------------------------------------


# Maps our internal provider id → the value the upstream framework
# expects in ``config["llm_provider"]``. Anthropic + Google use their own
# named providers; Qwen + DeepSeek + xAI all flow through the framework's
# "openai" provider with a custom backend_url because they expose
# OpenAI-compatible chat-completions APIs.
_TA_PROVIDER_MAP = {
    "anthropic": "anthropic",
    "openai": "openai",
    "google": "google",
    "deepseek": "openai",
    "xai": "openai",
    "qwen": "openai",
}

_TA_BACKEND_URL = {
    "anthropic": None,
    "openai": "https://api.openai.com/v1",
    "google": None,
    "deepseek": "https://api.deepseek.com/v1",
    "xai": "https://api.x.ai/v1",
    "qwen": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
}


def _build_trading_agents_graph(
    provider: str,
    deep_model: str,
    quick_model: str,
    params: dict,
):
    """Construct a TradingAgentsGraph configured for this variant's LLM.

    For providers that go through TradingAgents' internal openai client
    (Qwen via DashScope, DeepSeek, xAI), we mirror the variant's API key
    into ``OPENAI_API_KEY`` so the framework's LangChain ChatOpenAI
    initialisation finds it. The mirror only affects this process — it
    doesn't persist or leak across variants in a fresh GHA job.
    """
    try:
        from tradingagents.default_config import DEFAULT_CONFIG  # type: ignore
        from tradingagents.graph.trading_graph import TradingAgentsGraph  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "tradingagents package not installed — add it to requirements.txt"
        ) from exc

    ta_provider = _TA_PROVIDER_MAP.get(provider)
    if ta_provider is None:
        raise RuntimeError(f"no TradingAgents provider mapping for {provider!r}")
    backend_url = params.get("backend_url") or _TA_BACKEND_URL.get(provider)

    # Mirror non-OpenAI keys into OPENAI_API_KEY so the framework's
    # internal ChatOpenAI client authenticates against the custom backend.
    if provider in ("qwen", "deepseek", "xai"):
        env_key = {
            "qwen": "DASHSCOPE_API_KEY",
            "deepseek": "DEEPSEEK_API_KEY",
            "xai": "GROK_API_KEY",
        }[provider]
        bridge = os.environ.get(env_key, "").strip()
        if bridge and not os.environ.get("OPENAI_API_KEY", "").strip():
            os.environ["OPENAI_API_KEY"] = bridge

    config = dict(DEFAULT_CONFIG)
    config.update({
        "llm_provider": ta_provider,
        "deep_think_llm": deep_model,
        "quick_think_llm": quick_model,
        "max_debate_rounds": int(params["max_debate_rounds"]),
        "online_tools": bool(params["online_tools"]),
    })
    if backend_url:
        config["backend_url"] = backend_url

    # Skip the "social" (Sentiment) analyst — its Reddit scraper fires
    # three unauthenticated requests per ticker against r/wallstreetbets
    # /stocks /investing, all of which return HTTP 403. With no Reddit
    # credentials threaded through, it adds latency + log noise without
    # contributing signal. The remaining three analysts (market / news
    # / fundamentals) cover technicals, headlines, and financials.
    return TradingAgentsGraph(
        debug=False,
        selected_analysts=["market", "news", "fundamentals"],
        config=config,
    )


# ---------------------------------------------------------------------------
# Stage-3 helpers
# ---------------------------------------------------------------------------


def _apply_build_mode(
    *,
    buys_tickers: list[str],
    sells_tickers: list[str],
    current_holdings: set[str],
    position_floor: int,
) -> tuple[list[str], list[str], dict]:
    """While the portfolio is below ``position_floor``, protect existing holdings.

    Suppresses SELL verdicts on currently-held tickers (treats them as HOLD)
    and re-adds every held ticker to the BUY list so the equal-weight
    reconcile preserves the position instead of dropping it for being
    absent from the target set. The portfolio grows toward the floor over
    successive heartbeats; once at/above the floor, the function is a
    no-op and normal SELL/BUY semantics resume.

    Returns ``(new_buys, new_sells, notes)``. ``notes`` is a JSON-friendly
    dict the caller folds into ``RebalanceResult.notes`` for journalling.
    """
    if position_floor <= 0 or len(current_holdings) >= position_floor:
        return buys_tickers, sells_tickers, {
            "active": False,
            "current_positions": len(current_holdings),
            "position_floor": position_floor,
        }

    suppressed = [t for t in sells_tickers if t in current_holdings]
    new_sells = [t for t in sells_tickers if t not in current_holdings]
    new_buys = list(buys_tickers)
    seen = set(new_buys)
    carried: list[str] = []
    for held in current_holdings:
        if held in seen:
            continue
        new_buys.append(held)
        carried.append(held)
        seen.add(held)
    return new_buys, new_sells, {
        "active": True,
        "current_positions": len(current_holdings),
        "position_floor": position_floor,
        "suppressed_sells": suppressed,
        "carried_holds": carried,
    }


def _equal_weight_targets(
    *,
    ctx: RebalanceContext,
    buy_tickers: list[str],
    total_value: float,
    cash_reserve_pct: float,
    max_positions: int,
) -> tuple[dict[str, int], dict[str, dict], list[str]]:
    """Price every BUY target and compute equal-weight integer-share quantities.

    Caps the BUY set at max_positions. Returns (qty_by_ticker, meta, unpriced).
    """
    priced: list[tuple[str, float]] = []
    unpriced: list[str] = []
    for ticker in buy_tickers[:max_positions]:
        try:
            price = ctx.pm.get_price(ticker)
        except PortfolioError:
            unpriced.append(ticker)
            continue
        priced.append((ticker, price))

    if not priced:
        return {}, {}, unpriced

    investable = total_value * (1.0 - cash_reserve_pct)
    per_target_usd = investable / len(priced)

    qty_by_ticker: dict[str, int] = {}
    meta: dict[str, dict] = {}
    for ticker, price in priced:
        qty = int(math.floor(per_target_usd / price)) if price > 0 else 0
        qty_by_ticker[ticker] = qty
        meta[ticker] = {"price": price, "per_target_usd": per_target_usd}
    return qty_by_ticker, meta, unpriced


def _plan_trades(
    *,
    ctx: RebalanceContext,
    portfolio: dict,
    target_qty: dict[str, int],
    sells_tickers: set[str],
    target_meta: dict[str, dict],
    min_trade_usd: float,
) -> dict:
    """Diff target portfolio against current holdings to produce sells + buys.

    Sells everything in ``sells_tickers`` that we currently hold, plus any
    holdings not in ``target_qty`` (target=0). Buys to reach target quantity
    for everything in target_qty. Trades under ``min_trade_usd`` are skipped
    as noise (preserves idempotence on small price drift).
    """
    current_qty = {h["ticker"]: float(h["quantity"]) for h in portfolio["holdings"]}

    sells: list[tuple[str, float, str]] = []
    buys: list[tuple[str, int, str]] = []
    noise_skipped: list[dict] = []

    # Sell positions explicitly marked SELL or absent from target set.
    # (Holdings the LLM said HOLD on are preserved by virtue of being in
    # target_qty=0 only if they weren't included in target_qty at all —
    # which can't happen because we only include BUYs in target_qty.
    # So: a HOLD stays put because it's not in sells_tickers and not in
    # target_qty either, which means the loop below leaves it alone.)
    for ticker, held in current_qty.items():
        if ticker in target_qty:
            # In the BUY set — handled by the buy/trim loop below.
            continue
        if held <= 0:
            continue
        if ticker not in sells_tickers:
            # HOLD verdict (or simply not in this run's deep dive) →
            # leave the position alone.
            continue
        try:
            price = ctx.pm.get_price(ticker)
        except PortfolioError:
            # Can't price → can't sell. Surface but don't block.
            noise_skipped.append({"ticker": ticker, "side": "sell", "reason": "unpriced"})
            continue
        if held * price < min_trade_usd:
            noise_skipped.append({
                "ticker": ticker, "side": "sell",
                "qty": held, "usd": round(held * price, 2),
            })
            continue
        sells.append(
            (ticker, held, f"Sold {ticker} — TradingAgents debate concluded SELL.")
        )

    # Buy / trim toward target quantities.
    for ticker, want in target_qty.items():
        held = current_qty.get(ticker, 0.0)
        delta = want - held
        if delta == 0:
            continue
        meta = target_meta.get(ticker, {})
        price = meta.get("price")
        if price is None:
            try:
                price = ctx.pm.get_price(ticker)
            except PortfolioError:
                continue
        if delta > 0:
            usd = delta * price
            if usd < min_trade_usd:
                noise_skipped.append({
                    "ticker": ticker, "side": "buy",
                    "qty": delta, "usd": round(usd, 2),
                })
                continue
            buys.append((
                ticker,
                int(delta),
                f"Bought {ticker} — TradingAgents debate concluded BUY.",
            ))
        else:
            # Already over the target weight; trim back.
            qty_to_sell = -delta
            usd = qty_to_sell * price
            if usd < min_trade_usd:
                noise_skipped.append({
                    "ticker": ticker, "side": "sell",
                    "qty": qty_to_sell, "usd": round(usd, 2),
                })
                continue
            sells.append((
                ticker,
                qty_to_sell,
                f"Sold {ticker} — trimming to equal-weight target.",
            ))

    return {"buys": buys, "sells": sells, "noise_skipped": noise_skipped}


# ---------------------------------------------------------------------------
# Per-ticker pipeline — alternative flow for the matrix-parallel workflow.
#
# Splits one heartbeat into:
#   (1) run_shortlist_stage()   — Stage 1 + persist pending rows
#   (2) evaluate_ticker()       — framework debate + atomic trade for one ticker
#   (3) summarize_shortlist_run() — aggregate
#
# Resilient: if any stage dies mid-way, the persisted rows in
# `tauric_decisions` survive and a re-run skips already-traded rows.
# Concurrent: stage (2) uses PortfolioManager.buy_atomic/sell_atomic
# (Supabase RPCs with row-level locks), so the GHA matrix can run N
# parallel jobs without racing on cash.
# ---------------------------------------------------------------------------

import uuid


def _persist_decision_row(
    db,
    agent_id: str,
    shortlist_run_id: str,
    ticker: str,
    *,
    rationale: str | None = None,
    status: str = "pending",
) -> None:
    """Insert (or no-op if exists) a pending decision row."""
    db.client.table("tauric_decisions").upsert(
        {
            "agent_id": agent_id,
            "shortlist_run_id": shortlist_run_id,
            "ticker": ticker,
            "status": status,
            "shortlist_rationale": rationale,
        },
        on_conflict="agent_id,shortlist_run_id,ticker",
    ).execute()


def _update_decision_row(
    db,
    agent_id: str,
    shortlist_run_id: str,
    ticker: str,
    fields: dict,
) -> None:
    db.client.table("tauric_decisions").update(fields).match(
        {
            "agent_id": agent_id,
            "shortlist_run_id": shortlist_run_id,
            "ticker": ticker,
        }
    ).execute()


def _get_decision_row(
    db, agent_id: str, shortlist_run_id: str, ticker: str
) -> dict | None:
    resp = (
        db.client.table("tauric_decisions")
        .select("*")
        .match(
            {
                "agent_id": agent_id,
                "shortlist_run_id": shortlist_run_id,
                "ticker": ticker,
            }
        )
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def run_shortlist_stage(ctx: RebalanceContext, params: dict | None = None) -> dict:
    """Stage 1 for the per-ticker pipeline.

    Builds the deep-dive ticker list (shortlist + current holdings),
    persists one ``tauric_decisions`` row per ticker with
    ``status='pending'``, and returns the shortlist_run_id plus the
    ordered ticker list. Idempotent on the row insertions
    (``UPSERT`` with the unique key).

    The shortlist LLM call happens here, exactly once per heartbeat.
    Stage 2 (per-ticker debate) runs in parallel matrix jobs that each
    consume one row and mutate it through the lifecycle.
    """
    params = {**TRADING_AGENTS_DEFAULTS, **(params or ctx.params or {})}
    agent_id = ctx.agent["id"]
    handle = ctx.agent.get("handle", agent_id[:8])

    provider = params.get("llm_provider") or params.get("provider")
    deep_model = params.get("deep_think_llm")
    if not provider or provider not in PROVIDERS:
        raise ValueError(
            f"agents.config.llm_provider missing or invalid (got {provider!r})"
        )
    if not deep_model:
        raise ValueError("agents.config.deep_think_llm missing")

    snap_row = _load_latest_snapshot(ctx.db, "compact")
    if not snap_row:
        raise RuntimeError(
            "no compact universe snapshot — run build_universe_snapshot.py"
        )
    us_tickers = _us_listed_tickers(ctx.db)
    snapshot_json = _filter_snapshot_us_only(snap_row["json"], us_tickers)
    snapshot_date = snap_row["snapshot_date"]
    universe_tickers = {
        str(t.get("ticker") or "").upper()
        for t in (snapshot_json.get("tickers") or [])
        if t.get("ticker")
    }

    portfolio = ctx.pm.get_portfolio(agent_id)
    portfolio_summary = {
        "cash_usd": round(float(portfolio["cash_usd"]), 2),
        "total_value_usd": round(float(portfolio["total_value_usd"]), 2),
        "holdings": [
            {
                "ticker": h["ticker"],
                "quantity": float(h["quantity"]),
                "avg_cost_usd": float(h["avg_cost_usd"]),
            }
            for h in portfolio["holdings"]
        ],
    }

    raw, shortlist, dropped, usage, retry = pick_shortlist_via_llm(
        provider=provider,
        model=deep_model,
        snapshot=snapshot_json,
        snapshot_date=snapshot_date,
        portfolio=portfolio_summary,
        universe_tickers=universe_tickers,
        system_prompt=SHORTLIST_SYSTEM_PROMPT,
        user_template=SHORTLIST_USER_TEMPLATE,
        shortlist_max=int(params["max_candidates"]),
        max_tokens=int(params["stage1_max_tokens"]),
        temperature=float(params["temperature"]),
    )

    # Union shortlist + current holdings so existing positions get
    # re-evaluated each run (matches the all-at-once flow's behaviour).
    deep_dive: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    for entry in shortlist:
        t = entry["ticker"]
        if t in seen:
            continue
        seen.add(t)
        deep_dive.append((t, entry.get("rationale")))
    for h in portfolio_summary["holdings"]:
        t = str(h["ticker"]).upper()
        if t in seen or float(h["quantity"]) <= 0:
            continue
        seen.add(t)
        deep_dive.append((t, None))

    shortlist_run_id = str(uuid.uuid4())
    for ticker, rationale in deep_dive:
        _persist_decision_row(
            ctx.db,
            agent_id=agent_id,
            shortlist_run_id=shortlist_run_id,
            ticker=ticker,
            rationale=rationale,
        )

    logger.info(
        "%s: shortlist_run_id=%s tickers=%d (shortlist=%d held=%d) snapshot=%s",
        handle,
        shortlist_run_id,
        len(deep_dive),
        len(shortlist),
        len(portfolio_summary["holdings"]),
        snapshot_date,
    )

    return {
        "shortlist_run_id": shortlist_run_id,
        "tickers": [t for t, _ in deep_dive],
        "snapshot_date": snapshot_date,
        "shortlist_count": len(shortlist),
        "held_count": len(portfolio_summary["holdings"]),
        "dropped_invalid": dropped,
        "input_tokens": usage[0],
        "output_tokens": usage[1],
        "raw_response_kb": len(raw) // 1024,
        "retry_response_kb": (len(retry) // 1024) if retry else None,
    }


def _per_ticker_target_qty(
    *,
    pm,
    ticker: str,
    total_value_usd: float,
    position_floor: int,
    cash_reserve_pct: float,
    min_trade_usd: float,
) -> tuple[int, float, str | None]:
    """Compute integer share qty for a per-ticker BUY.

    Returns (qty, price, skip_reason) — qty=0 + skip_reason set when
    the trade should be skipped (unpriced, noise, or no slot left).
    """
    if position_floor <= 0:
        return 0, 0.0, "skipped_no_cash"  # misconfigured
    try:
        price = pm.get_price(ticker)
    except PortfolioError:
        return 0, 0.0, "skipped_unpriced"
    target_usd = total_value_usd * (1.0 - cash_reserve_pct) / position_floor
    qty = int(math.floor(target_usd / price)) if price > 0 else 0
    if qty <= 0 or qty * price < min_trade_usd:
        return qty, price, "skipped_noise"
    return qty, price, None


def evaluate_ticker(
    ctx: RebalanceContext,
    ticker: str,
    shortlist_run_id: str,
    params: dict | None = None,
) -> dict:
    """Stage 2 + per-ticker reconcile for one ticker.

    Idempotent: if the row already has ``status='traded'`` or
    ``status='error'`` we no-op. Otherwise: run the framework debate,
    persist the decision, then atomically execute the trade (if any)
    via the Supabase RPCs.

    Returns a status dict suitable for logging.
    """
    params = {**TRADING_AGENTS_DEFAULTS, **(params or ctx.params or {})}
    agent_id = ctx.agent["id"]
    handle = ctx.agent.get("handle", agent_id[:8])

    row = _get_decision_row(ctx.db, agent_id, shortlist_run_id, ticker)
    if row is None:
        return {"status": "error", "reason": "no decision row"}
    if row["status"] in ("traded", "error"):
        return {"status": "skipped_idempotent", "prior_status": row["status"]}

    provider = params.get("llm_provider") or params.get("provider")
    deep_model = params.get("deep_think_llm")
    quick_model = params.get("quick_think_llm") or deep_model

    # Mark as evaluating
    _update_decision_row(
        ctx.db, agent_id, shortlist_run_id, ticker, {"status": "evaluating"},
    )

    # Run framework
    try:
        ta_graph = _build_trading_agents_graph(provider, deep_model, quick_model, params)
        today_iso = date.today().isoformat()
        _state, raw_decision = ta_graph.propagate(ticker, today_iso)
    except Exception as exc:  # noqa: BLE001 — framework can raise anything
        _update_decision_row(
            ctx.db, agent_id, shortlist_run_id, ticker,
            {"status": "error", "framework_error": str(exc)[:500]},
        )
        logger.warning("%s/%s: framework error: %s", handle, ticker, exc)
        return {"status": "error", "ticker": ticker, "error": str(exc)[:300]}

    decision = _extract_decision(str(raw_decision or ""))
    reasoning = str(raw_decision or "")[:8000]
    _update_decision_row(
        ctx.db, agent_id, shortlist_run_id, ticker,
        {
            "status": "decided",
            "decision": decision,
            "reasoning": reasoning,
            "decided_at": "now()",
        },
    )

    if ctx.dry_run:
        _update_decision_row(
            ctx.db, agent_id, shortlist_run_id, ticker,
            {
                "status": "traded",
                "trade_outcome": "skipped_hold" if decision == "HOLD" else "skipped_noise",
                "traded_at": "now()",
            },
        )
        return {
            "status": "dry_run", "ticker": ticker, "decision": decision,
        }

    # Refresh portfolio state (other matrix jobs may have mutated it)
    portfolio = ctx.pm.get_portfolio(agent_id)
    total_value = float(portfolio["total_value_usd"])
    held_qty = 0.0
    for h in portfolio["holdings"]:
        if h["ticker"] == ticker:
            held_qty = float(h["quantity"])
            break
    held_count = sum(1 for h in portfolio["holdings"] if float(h["quantity"]) > 0)
    position_floor = int(params.get("position_floor", 0))
    in_build_mode = position_floor > 0 and held_count < position_floor

    outcome: str
    trade_id: int | None = None

    if decision == "HOLD":
        outcome = "skipped_hold"
    elif decision == "SELL":
        if held_qty <= 0:
            outcome = "skipped_no_position"
        elif in_build_mode:
            outcome = "skipped_build_mode_sell"
            logger.info(
                "%s/%s: SELL suppressed by build mode (held=%d < floor=%d)",
                handle, ticker, held_count, position_floor,
            )
        else:
            try:
                rpc = ctx.pm.sell_atomic(
                    agent_id, ticker, held_qty,
                    note=f"Sold {ticker} — TradingAgents debate concluded SELL.",
                )
            except Exception as exc:  # noqa: BLE001
                _update_decision_row(
                    ctx.db, agent_id, shortlist_run_id, ticker,
                    {
                        "status": "error",
                        "framework_error": f"sell rpc raised: {exc}"[:500],
                    },
                )
                return {"status": "error", "ticker": ticker, "error": str(exc)[:300]}
            if rpc.get("status") == "ok":
                outcome = "sold"
                trade_id = rpc.get("trade_id")
            elif rpc.get("status") == "no_position":
                outcome = "skipped_no_position"
            else:
                outcome = "skipped_no_position"
    else:  # BUY
        qty, _price, skip_reason = _per_ticker_target_qty(
            pm=ctx.pm,
            ticker=ticker,
            total_value_usd=total_value,
            position_floor=position_floor,
            cash_reserve_pct=float(params["cash_reserve_pct"]),
            min_trade_usd=float(params["min_trade_usd"]),
        )
        if skip_reason:
            outcome = skip_reason
        else:
            try:
                rpc = ctx.pm.buy_atomic(
                    agent_id, ticker, qty,
                    note=f"Bought {ticker} — TradingAgents debate concluded BUY.",
                )
            except Exception as exc:  # noqa: BLE001
                _update_decision_row(
                    ctx.db, agent_id, shortlist_run_id, ticker,
                    {
                        "status": "error",
                        "framework_error": f"buy rpc raised: {exc}"[:500],
                    },
                )
                return {"status": "error", "ticker": ticker, "error": str(exc)[:300]}
            if rpc.get("status") == "ok":
                outcome = "bought"
                trade_id = rpc.get("trade_id")
            elif rpc.get("status") == "insufficient_cash":
                outcome = "skipped_no_cash"
            else:
                outcome = "skipped_no_cash"

    _update_decision_row(
        ctx.db, agent_id, shortlist_run_id, ticker,
        {
            "status": "traded",
            "trade_outcome": outcome,
            "trade_id": trade_id,
            "traded_at": "now()",
        },
    )

    logger.info(
        "%s/%s: decision=%s outcome=%s%s",
        handle, ticker, decision, outcome,
        f" trade_id={trade_id}" if trade_id else "",
    )
    return {
        "status": "traded",
        "ticker": ticker,
        "decision": decision,
        "outcome": outcome,
        "trade_id": trade_id,
    }


def summarize_shortlist_run(
    db, agent_id: str, shortlist_run_id: str,
) -> dict:
    """Aggregate the tauric_decisions rows for one shortlist run.

    Returns counts by status / decision / outcome plus per-ticker
    rollup. Idempotent — pure read.
    """
    resp = (
        db.client.table("tauric_decisions")
        .select("ticker,status,decision,trade_outcome,trade_id,framework_error")
        .match(
            {"agent_id": agent_id, "shortlist_run_id": shortlist_run_id}
        )
        .execute()
    )
    rows = resp.data or []
    summary: dict[str, Any] = {
        "shortlist_run_id": shortlist_run_id,
        "agent_id": agent_id,
        "total": len(rows),
        "by_status": {},
        "by_decision": {},
        "by_outcome": {},
        "trade_ids": [],
        "errors": [],
        "tickers": [],
    }
    for row in rows:
        s = row.get("status") or "?"
        summary["by_status"][s] = summary["by_status"].get(s, 0) + 1
        d = row.get("decision") or "?"
        summary["by_decision"][d] = summary["by_decision"].get(d, 0) + 1
        o = row.get("trade_outcome") or "?"
        summary["by_outcome"][o] = summary["by_outcome"].get(o, 0) + 1
        if row.get("trade_id"):
            summary["trade_ids"].append(row["trade_id"])
        if row.get("framework_error"):
            summary["errors"].append(
                {"ticker": row["ticker"], "error": row["framework_error"]}
            )
        summary["tickers"].append(
            {
                "ticker": row.get("ticker"),
                "decision": row.get("decision"),
                "outcome": row.get("trade_outcome"),
                "status": row.get("status"),
            }
        )
    return summary
