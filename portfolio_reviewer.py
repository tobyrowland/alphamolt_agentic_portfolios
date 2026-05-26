"""Portfolio Review Agent — checks each held equity for thesis drift weekly.

The sell-side counterpart of `llm_watchlist_buyer`. For every position in
the portfolio's book, calls a frontier model (Gemini 2.5 Pro) to decide
whether the recorded investment thesis has materially deteriorated. If
the LLM verdict is SELL at conviction >= 4/5, the agent marks the
recorded thesis as `broken` and sells the full position at the current
price.

Mirrors the buyer's module structure (`llm_watchlist_buyer.py`) so the
lazy-import shell in `agent_strategies.py` stays thin and the heavy SDK
+ threading dependencies only load when this strategy actually runs.
"""

from __future__ import annotations

import json
import logging
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

logger = logging.getLogger("portfolio_reviewer")


# ---------------------------------------------------------------------------
# Defaults — overridable per agent via agents.config JSONB
# ---------------------------------------------------------------------------

PORTFOLIO_REVIEWER_DEFAULTS: dict[str, Any] = {
    "provider": "google",
    "model": "gemini-2.5-pro",
    "sell_conviction_threshold": 4,   # SELL fires when conviction >= this
    "concurrency": 5,                 # ThreadPoolExecutor workers
    "per_call_timeout_sec": 120,      # Per-position LLM timeout
    # Thinking-token headroom — same trap as the curator + buyer (PR #1045).
    "max_tokens": 65536,
    "temperature": 0.2,
}


# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

REVIEWER_SYSTEM_PROMPT = """\
You are a portfolio risk manager reviewing each held equity against the OWNER'S PORTFOLIO MANDATE.

Your job per call: look at ONE position the portfolio currently holds and decide whether the owner's mandate says to exit it. You have:
- The portfolio's mandate (the owner's investment brief — covers what to own AND when to exit).
- The position (ticker, quantity, average cost, current price, P/L).
- The buy thesis recorded when the position was opened (text + explicit break/extend signals), if any.
- A machine-check of the recorded break signals against current data — which ones are firing right now.
- The full current company data (fundamentals + valuation + narrative + prior in-house bull/bear verdicts).

Render a verdict: HOLD (do nothing) or SELL (close the position at the next available price).

Your job is NOT to apply your own opinion of when to sell. Apply the OWNER'S mandate. If the mandate is loose, be conservative. If it's vigilant, be more willing to exit. If the mandate is silent on selling, lean toward HOLD unless the recorded buy thesis is materially broken.

Conviction 1-5 only meaningful when verdict="SELL":
  5 = the mandate's exit criteria are unambiguously triggered; no judgement call
  4 = the mandate's exit criteria are clearly triggered, with one minor qualification
  3 = the criteria are arguably triggered; reasonable people might disagree
  1-2 = drift exists but doesn't meet the mandate's bar
SELL at conviction >= 4 actually triggers a trade; lower convictions are journal-only.

Output strict JSON only — no prose, no markdown fences."""


REVIEWER_USER_TEMPLATE = """\
{portfolio_mandate_block}PORTFOLIO STATE:
- Total value: ${total_value_usd:,.0f}
- Cash available: ${cash_usd:,.0f}
- Number of holdings: {num_holdings}

POSITION UNDER REVIEW: {ticker}
- Quantity held: {quantity}
- Average cost: ${avg_cost_usd:,.4f}
- Current price: ${current_price:,.4f}
- Market value: ${market_value_usd:,.2f}
- Unrealized P/L: ${unrealized_pnl_usd:,.2f} ({unrealized_pnl_pct:+.2f}%)
- First bought: {first_bought_at}

RECORDED BUY THESIS ({thesis_source}):
{thesis_block}

MACHINE-CHECK OF RECORDED BREAK SIGNALS (current data vs snapshot at buy):
{break_signal_check}

CURRENT COMPANY DATA (extended-tier snapshot):
{current_data_json}

PRIOR IN-HOUSE VERDICTS:
- Bull eval: {bull_eval}
- Bear eval: {bear_eval}

OUTPUT SCHEMA (strict JSON, no other text):
{{
  "ticker": "{ticker}",
  "verdict": "HOLD" | "SELL",
  "conviction": <integer 1-5; only meaningful for SELL>,
  "rationale": "<one line - the headline reason>",
  "what_changed": "<2-4 sentences - what materially deteriorated since buy, if anything. For HOLD, briefly say why the thesis still holds.>"
}}

Output JSON only."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _truncate(text: str, limit: int = 2000) -> str:
    text = text or ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _format_thesis_block(thesis: dict | None) -> tuple[str, str]:
    """Return (source_label, rendered_block) for the prompt."""
    if not thesis:
        return ("none — judge on current data + mandate only", "(no recorded thesis)")
    source = thesis.get("source") or "unknown"
    text = (thesis.get("thesis_text") or "").strip()
    extend = thesis.get("extend_signals") or []
    breaks = thesis.get("break_signals") or []

    parts: list[str] = []
    if text:
        parts.append(f"Thesis text:\n{text}")
    else:
        parts.append("Thesis text: (snapshot-only buy, no narrative)")

    if extend:
        rendered = "\n".join(
            f"  - {s.get('field')} {s.get('op')} {s.get('value')}"
            + (f"  ({s.get('description')})" if s.get('description') else "")
            for s in extend
        )
        parts.append(f"Extend signals (would confirm thesis if true):\n{rendered}")
    if breaks:
        rendered = "\n".join(
            f"  - {s.get('field')} {s.get('op')} {s.get('value')}"
            + (f"  ({s.get('description')})" if s.get('description') else "")
            for s in breaks
        )
        parts.append(f"Break signals (would invalidate thesis if true):\n{rendered}")

    return (source, "\n\n".join(parts))


def _format_signal_check(check: dict | None) -> str:
    """Render the output of theses.check_thesis as a compact summary.

    The signal list highlights which break_signals are CURRENTLY firing —
    the strongest deterministic input to the SELL decision. The LLM can
    still override (rare false positives), but a triggered break_signal
    is the agent's chief reason-to-sell.
    """
    if not check:
        return "(no recorded thesis to machine-check)"
    verdict = check.get("verdict") or "?"
    broken = check.get("broken_signals") or []
    if not broken:
        return f"verdict={verdict}; no break signals firing"
    rendered = "\n".join(
        f"  ⚠ {s.get('field')} {s.get('op')} {s.get('value')}"
        + (f"  ({s.get('description')})" if s.get('description') else "")
        for s in broken
    )
    return f"verdict={verdict}; {len(broken)} break signal(s) firing:\n{rendered}"


# ---------------------------------------------------------------------------
# Per-position evaluation
# ---------------------------------------------------------------------------


def _evaluate_position(
    *,
    provider: str,
    model: str,
    ticker: str,
    quantity: float,
    avg_cost_usd: float,
    first_bought_at: str | None,
    current_price: float,
    portfolio: dict,
    portfolio_mandate: str | None,
    thesis: dict | None,
    signal_check: dict | None,
    current_data: dict,
    max_tokens: int,
    temperature: float,
) -> dict:
    """One LLM call. Returns either the parsed verdict dict or
    `{ticker, error, raw_response_truncated}` on failure. Never raises.
    """
    market_value = quantity * current_price
    unrealized = market_value - quantity * avg_cost_usd
    pnl_pct = (
        (unrealized / (quantity * avg_cost_usd) * 100.0)
        if avg_cost_usd > 0
        else 0.0
    )

    thesis_source, thesis_block = _format_thesis_block(thesis)
    signal_block = _format_signal_check(signal_check)

    narrative = (current_data or {}).get("narrative") or {}
    bull_eval = narrative.get("bull_eval") or "—"
    bear_eval = narrative.get("bear_eval") or "—"

    user = REVIEWER_USER_TEMPLATE.format(
        portfolio_mandate_block=_mandate_block(portfolio_mandate),
        total_value_usd=float(portfolio.get("total_value_usd") or 0),
        cash_usd=float(portfolio.get("cash_usd") or 0),
        num_holdings=len(portfolio.get("holdings") or []),
        ticker=ticker,
        quantity=quantity,
        avg_cost_usd=avg_cost_usd,
        current_price=current_price,
        market_value_usd=market_value,
        unrealized_pnl_usd=unrealized,
        unrealized_pnl_pct=pnl_pct,
        first_bought_at=first_bought_at or "(unknown)",
        thesis_source=thesis_source,
        thesis_block=thesis_block,
        break_signal_check=signal_block,
        current_data_json=json.dumps(current_data, default=str, ensure_ascii=False),
        bull_eval=bull_eval,
        bear_eval=bear_eval,
    )

    try:
        resp = call_llm(
            provider=provider,
            model=model,
            system=REVIEWER_SYSTEM_PROMPT,
            user=user,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    except LLMProviderError as exc:
        return {"ticker": ticker, "error": f"LLM call failed: {exc}"}

    try:
        parsed, _retry = _parse_with_retry(
            provider, model, resp.text, system=REVIEWER_SYSTEM_PROMPT,
        )
    except LLMProviderError as exc:
        return {
            "ticker": ticker,
            "error": f"JSON parse failed: {exc}",
            "raw_response_truncated": _truncate(resp.text),
        }

    verdict = str(parsed.get("verdict") or "").strip().upper()
    if verdict not in ("HOLD", "SELL"):
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
        "what_changed": str(parsed.get("what_changed") or "").strip(),
        "input_tokens": resp.input_tokens,
        "output_tokens": resp.output_tokens,
        # Thread the thesis id through so the caller can mark it broken.
        "_thesis_id": (thesis or {}).get("id"),
    }


# ---------------------------------------------------------------------------
# Strategy entrypoint
# ---------------------------------------------------------------------------


def _active_theses_by_ticker(db, portfolio_id: str) -> dict[str, dict]:
    """All active investment_theses for a portfolio, keyed by ticker."""
    resp = (
        db.client.table("investment_theses")
        .select("*")
        .eq("portfolio_id", portfolio_id)
        .eq("status", "active")
        .order("opened_at", desc=True)
        .execute()
    )
    by_ticker: dict[str, dict] = {}
    for row in resp.data or []:
        ticker = str(row.get("ticker") or "").upper()
        if ticker and ticker not in by_ticker:
            by_ticker[ticker] = row
    return by_ticker


def rebalance_portfolio_reviewer(ctx: RebalanceContext) -> RebalanceResult:
    """Sell-side reviewer for human-owned portfolios.

    Flow:
      0. No-op on legacy 1:1 agent portfolios.
      1. Load the book; if no holdings, exit.
      2. Load active theses + the extended-tier universe snapshot.
      3. For each held ticker, call the LLM with: position data, recorded
         thesis (if any), machine-check of break signals, current company
         data. Parallel via ThreadPoolExecutor.
      4. Filter to verdict=SELL AND conviction >= sell_conviction_threshold.
      5. For each qualifying position:
            a. Mark the thesis as `broken` (if a thesis exists), so the
               audit trail captures the *why* — the modified
               close_theses_for_position preserves terminal statuses
               through the sell.
            b. Sell the full position at current price via ctx.sell
               (atomic RPC path).
    """
    result = RebalanceResult()
    params = {**PORTFOLIO_REVIEWER_DEFAULTS, **(ctx.params or {})}
    handle = ctx.agent.get("handle", ctx.agent["id"][:8])

    if not ctx.portfolio_id:
        result.notes["reason"] = "portfolio_reviewer only runs on a human portfolio"
        return result

    provider = params["provider"]
    model = params["model"]
    if not provider or not model:
        result.errors.append("agents.config must set provider + model")
        return result

    portfolio = ctx.get_book()
    holdings = portfolio.get("holdings") or []
    if not holdings:
        result.notes["reason"] = "no holdings to review"
        return result

    # The reviewer is user-driven: it follows the owner's portfolio
    # mandate (portfolios.description). Without a mandate the agent has
    # nothing to act on, so bail before any LLM work.
    portfolio_mandate = ctx.mandate
    if not (portfolio_mandate or "").strip():
        result.notes["reason"] = (
            "no mandate set — the reviewer follows the owner's "
            "portfolio mandate. Write one via /account to enable."
        )
        return result

    # Theses for context (and to mark broken later).
    active_theses = _active_theses_by_ticker(ctx.db, ctx.portfolio_id)

    # Extended snapshot once for the whole batch.
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

    # Per-position context bundles.
    work: list[dict] = []
    missing_snapshot: list[str] = []
    missing_price: list[str] = []
    for h in holdings:
        ticker = str(h.get("ticker") or "").upper()
        if not ticker:
            continue
        qty = float(h.get("quantity") or 0)
        if qty <= 0:
            continue
        avg_cost = float(h.get("avg_cost_usd") or 0)
        first_bought_at = h.get("first_bought_at")

        try:
            current_price = ctx.pm.get_price(ticker)
        except PortfolioError:
            missing_price.append(ticker)
            continue

        current_data = by_ticker_data.get(ticker)
        if not current_data:
            missing_snapshot.append(ticker)
            continue

        thesis = active_theses.get(ticker)
        signal_check: dict | None = None
        if thesis and thesis.get("id"):
            try:
                # Use the existing read-only oracle to flag firing break
                # signals — feeds them to the LLM as a strong prior.
                from theses import check_thesis
                signal_check = check_thesis(ctx.db, thesis["id"])
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "%s: check_thesis(%s) failed: %s", handle, ticker, exc,
                )

        work.append({
            "ticker": ticker,
            "quantity": qty,
            "avg_cost_usd": avg_cost,
            "first_bought_at": first_bought_at,
            "current_price": current_price,
            "current_data": current_data,
            "thesis": thesis,
            "signal_check": signal_check,
        })

    if missing_price:
        result.notes["unpriced"] = missing_price
    if missing_snapshot:
        result.notes["missing_from_snapshot"] = missing_snapshot

    if not work:
        result.notes["reason"] = "no priceable + snapshotted positions"
        return result

    concurrency = max(1, int(params["concurrency"]))
    timeout_sec = float(params["per_call_timeout_sec"])
    max_tokens = int(params["max_tokens"])
    temperature = float(params["temperature"])

    logger.info(
        "%s: reviewing %d positions, concurrency=%d, timeout=%.0fs",
        handle, len(work), concurrency, timeout_sec,
    )

    evaluations: list[dict] = []
    parse_failures: dict[str, str] = {}
    timeouts: list[str] = []

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(
                _evaluate_position,
                provider=provider,
                model=model,
                ticker=item["ticker"],
                quantity=item["quantity"],
                avg_cost_usd=item["avg_cost_usd"],
                first_bought_at=item["first_bought_at"],
                current_price=item["current_price"],
                portfolio=portfolio,
                portfolio_mandate=portfolio_mandate,
                thesis=item["thesis"],
                signal_check=item["signal_check"],
                current_data=item["current_data"],
                max_tokens=max_tokens,
                temperature=temperature,
            ): item["ticker"]
            for item in work
        }
        for fut, ticker in list(futures.items()):
            try:
                ev = fut.result(timeout=timeout_sec)
            except FutureTimeoutError:
                timeouts.append(ticker)
                fut.cancel()
                continue
            except Exception as exc:  # noqa: BLE001
                parse_failures[ticker] = f"unexpected: {exc}"
                continue
            if "error" in ev:
                parse_failures[ticker] = ev["error"]
                continue
            evaluations.append(ev)

    if timeouts:
        result.notes["timeouts"] = timeouts
    if parse_failures:
        result.notes["per_ticker_errors"] = parse_failures

    input_tok = sum(int(e.get("input_tokens") or 0) for e in evaluations)
    output_tok = sum(int(e.get("output_tokens") or 0) for e in evaluations)
    result.notes["positions_reviewed"] = len(evaluations)
    result.notes["input_tokens"] = input_tok
    result.notes["output_tokens"] = output_tok

    # Journal every verdict for transparency, sell only those that clear
    # the conviction gate.
    threshold = int(params["sell_conviction_threshold"])
    sells: list[dict] = []
    holds: list[dict] = []
    for ev in evaluations:
        record = {
            "ticker": ev["ticker"],
            "verdict": ev["verdict"],
            "conviction": ev["conviction"],
            "rationale": ev["rationale"],
            "what_changed": ev["what_changed"],
        }
        if ev["verdict"] == "SELL" and ev["conviction"] >= threshold:
            sells.append({**record, "_thesis_id": ev.get("_thesis_id")})
        else:
            holds.append(record)

    result.notes["verdicts"] = {
        "sell_qualifying": sells,
        "hold_or_subthreshold": holds,
    }

    if not sells:
        result.notes["reason"] = "no positions met the sell threshold"
        return result

    # Map ticker -> qty for the sell loop.
    qty_by_ticker = {
        str(h.get("ticker") or "").upper(): float(h.get("quantity") or 0)
        for h in holdings
    }

    if ctx.dry_run:
        result.notes["dry_run_sells"] = sells
        logger.info(
            "[dry-run] %s: would sell %d positions",
            handle, len(sells),
        )
        return result

    # Live execution. Mark thesis broken FIRST so the audit trail captures
    # the *why* — close_theses_for_position now preserves terminal
    # statuses (theses.py change), so the sell-time close pass won't
    # overwrite the 'broken' status with 'closed'.
    for item in sells:
        ticker = item["ticker"]
        qty = qty_by_ticker.get(ticker, 0)
        if qty <= 0:
            continue
        thesis_id = item.get("_thesis_id")
        if thesis_id:
            try:
                from theses import mark_thesis_status
                mark_thesis_status(
                    ctx.db,
                    thesis_id,
                    status="broken",
                    reason=item["rationale"][:120],
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "%s: mark_thesis_status(%s, broken) failed: %s",
                    handle, ticker, exc,
                )

        note = f"portfolio-reviewer drift ({item['rationale'][:80]})"
        try:
            ctx.sell(ticker, qty, note=note)
            result.sells += 1
        except PortfolioError as exc:
            result.errors.append(f"sell {ticker} x{qty}: {exc}")

    return result
