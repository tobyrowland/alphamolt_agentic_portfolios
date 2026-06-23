"""Level 0 evaluation candidates (Stage A2).

Lets the bull / bear / narrative eval scripts run over the full **Tier 1**
universe (`securities.is_tier1`) instead of the legacy `companies`/in_tv_screen
set — so financials and foreign-domiciled ADRs (TSM, ING, banks) that the
screener ranks but the legacy TV screen excluded finally get AI bull/bear +
narratives written to `ai_analysis` (migration 053/054).

`tier1_eval_candidates(db, kind, top_n)` returns prompt-ready equity dicts for
the `top_n` **stalest** Tier-1 names for that `kind` (`bull` | `bear` |
`narrative`), ordered least-recently-evaluated first (never-evaluated → NULL →
first). Each dict is assembled from Level 0 facts (identity + latest
fundamentals + valuation), overlaid with the richer `companies` row where one
exists (so names already in companies keep their current prompt depth) and the
existing `ai_analysis` verdicts/narrative. The dict uses companies-style keys so
the existing `build_equity_block` in each eval script formats it unchanged.

Pure reads; no LLM. The eval scripts pass these straight into their existing
prompt → LLM → verdict flow.
"""

from __future__ import annotations

from typing import Any

_CLOCK_COLUMN = {
    "bull": "bull_at",
    "bear": "bear_at",
    "narrative": "narrated_at",
    "research": "researched_at",  # the shared research card (migration 055)
}

# Level 0 fundamentals field -> companies-style key the prompt/build_equity_block
# expects, so a Tier-1-only name reads like a companies row in the prompt.
_FUNDAMENTAL_MAP = {
    "revenue": "revenue",
    "rev_growth_ttm": "rev_growth_ttm_pct",
    "rev_growth_qoq": "rev_growth_qoq_pct",
    "rev_cagr": "rev_cagr_pct",
    "gross_margin": "gross_margin_pct",
    "operating_margin": "operating_margin_pct",
    "net_margin": "net_margin_pct",
    "fcf_margin": "fcf_margin_pct",
    "rule_of_40": "rule_of_40",
    "eps": "eps_only",
    "opex_pct_rev": "opex_pct_revenue",
    "cash": "cash",
    "debt": "debt",
    "shares_out": "shares_out",
}
_NARRATIVE_FIELDS = (
    "bull_eval", "bear_eval", "short_outlook", "key_risks",
    "full_outlook", "event_impact",
)


def _chunked(seq, n=200):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _bulk(db, table: str, select: str, tickers: list[str]) -> list[dict]:
    """Fetch `table` rows for the given tickers (chunked .in_)."""
    out: list[dict] = []
    for chunk in _chunked(tickers):
        resp = (
            db.client.table(table).select(select).in_("ticker", chunk).execute()
        )
        out.extend(resp.data or [])
    return out


def verified_fact_tickers(db) -> set[str]:
    """Tickers we hold VERIFIED financials for — a `fundamentals` row carrying
    real figures (revenue / margins / rule-of-40) from a trusted source (EODHD).

    The data-quality gate for any LLM research request: we never ask a model to
    evaluate a name we can't seed with correct fundamentals, or it invents
    moat/earnings-quality from the ticker alone. Pricing isn't checked here —
    Tier-1 membership (the affordability gate) already guarantees a live price.
    """
    out: set[str] = set()
    offset = 0
    while True:
        resp = (
            db.client.table("fundamentals")
            .select("ticker")
            .or_(
                "rule_of_40.not.is.null,gross_margin.not.is.null,"
                "net_margin.not.is.null,rev_growth_ttm.not.is.null,revenue.not.is.null"
            )
            .range(offset, offset + 999)
            .execute()
        )
        batch = resp.data or []
        out.update((r.get("ticker") or "").upper() for r in batch if r.get("ticker"))
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def stale_tier1_tickers(db, kind: str, top_n: int) -> list[str]:
    """The `top_n` Tier-1 tickers least-recently evaluated for `kind`.

    Never-evaluated names (no ai_analysis row, or a NULL kind-clock) sort first,
    then oldest first. Gated to names with VERIFIED financials
    (`verified_fact_tickers`) so an LLM eval is never sent without correct data;
    unverified names re-enter the rotation automatically once their fundamentals
    backfill. Pure read over `securities` + `fundamentals` + `ai_analysis`.
    """
    clock = _CLOCK_COLUMN.get(kind)
    if clock is None:
        raise ValueError(
            f"unknown kind {kind!r} (expected bull|bear|narrative|research)"
        )

    verified = verified_fact_tickers(db)

    # Active Tier-1 universe, gated to verified-fact names.
    tier1: list[str] = []
    offset = 0
    while True:
        resp = (
            db.client.table("securities")
            .select("ticker")
            .eq("is_tier1", True)
            .eq("status", "active")
            .range(offset, offset + 999)
            .execute()
        )
        batch = resp.data or []
        tier1.extend(
            t for r in batch
            if (t := (r.get("ticker") or "").upper()) and t in verified
        )
        if len(batch) < 1000:
            break
        offset += 1000

    # Per-kind clock from ai_analysis (only evaluated names have a row).
    clocks: dict[str, str | None] = {}
    for chunk in _chunked(tier1):
        resp = (
            db.client.table("ai_analysis")
            .select(f"ticker,{clock}")
            .in_("ticker", chunk)
            .execute()
        )
        for r in (resp.data or []):
            clocks[(r.get("ticker") or "").upper()] = r.get(clock)

    # NULLs (never evaluated) first, then oldest ISO timestamp first.
    def _key(t: str):
        c = clocks.get(t)
        return (0 if not c else 1, str(c or ""))

    return sorted(tier1, key=_key)[:top_n]


def _latest_by_ticker(rows: list[dict], order_field: str) -> dict[str, dict]:
    """Reduce multi-row-per-ticker results to the latest row per ticker."""
    best: dict[str, dict] = {}
    for r in rows:
        t = (r.get("ticker") or "").upper()
        if not t:
            continue
        cur = best.get(t)
        if cur is None or str(r.get(order_field) or "") > str(cur.get(order_field) or ""):
            best[t] = r
    return best


def _assemble(ticker: str, sec: dict | None, fund: dict | None,
              val: dict | None, company: dict | None, ai: dict | None) -> dict:
    """Build one prompt-ready equity dict (companies-style keys)."""
    row: dict[str, Any] = {"ticker": ticker}
    sec = sec or {}
    row["company_name"] = (company or {}).get("company_name") or sec.get("name")
    row["country"] = (company or {}).get("country") or sec.get("country")
    row["sector"] = (company or {}).get("sector") or sec.get("gics_sector")

    # Level 0 fundamentals → companies-style keys.
    for src, dst in _FUNDAMENTAL_MAP.items():
        v = (fund or {}).get(src)
        if v is not None:
            row[dst] = v
    if val:
        if val.get("ps") is not None:
            row["ps_now"] = val.get("ps")
        if val.get("ps_median_12m") is not None:
            row["ps_median_12m"] = val.get("ps_median_12m")

    # Overlay the richer companies row where it exists (keeps current prompt
    # depth for legacy-covered names); else fall back to ai_analysis verdicts/
    # narrative so a bull eval can still see the prior bear, etc.
    if company:
        row.update({k: v for k, v in company.items() if v is not None})
    elif ai:
        for f in _NARRATIVE_FIELDS:
            if ai.get(f) is not None:
                row[f] = ai[f]
    return row


def tier1_eval_candidates(db, kind: str, top_n: int) -> list[dict]:
    """Prompt-ready equity dicts for the `top_n` stalest Tier-1 names for `kind`,
    staleness order preserved."""
    tickers = stale_tier1_tickers(db, kind, top_n)
    if not tickers:
        return []
    secs = {(s.get("ticker") or "").upper(): s
            for s in _bulk(db, "securities",
                           "ticker,name,country,gics_sector", tickers)}
    funds = _latest_by_ticker(
        _bulk(db, "fundamentals", "*", tickers), "period_end")
    vals = _latest_by_ticker(
        _bulk(db, "valuation", "ticker,date,ps,ps_median_12m", tickers), "date")
    ai = db.get_ai_analysis(tickers)
    # The legacy `companies` overlay is retired — prompt rows are assembled from
    # Level 0 (securities + fundamentals + valuation) and the ai_analysis
    # narrative/verdict fallback (handled in _assemble when company is None).
    return [
        _assemble(t, secs.get(t), funds.get(t), vals.get(t),
                  None, ai.get(t))
        for t in tickers
    ]
