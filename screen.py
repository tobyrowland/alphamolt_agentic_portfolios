"""
screen.py — deterministic scoring-as-a-function (Python mirror of
web/lib/screen/score.ts).

The configurable screener is the funnel's selection stage (screener brief v2):
the ranked top N of a portfolio's screen feed the buyer directly — there is no
separate curator/watchlist anymore. This module is what the buyer ranks
through, so the top N it computes is identical to what the website shows.

Reads Level 0 facts via the `screen_facts()` RPC (one row per Tier 1 ticker:
identity + latest fundamentals + latest valuation + last price + 52w return)
and the optional `screen_ai_overlay()` (bull/bear verdict, a lens). Scoring is
pure, deterministic, lens-relative (empirical percentiles within the filtered
candidate set) — NO LLM in the ranking loop. See migration 040.

The config is a plain dict (a portfolio's `screen_config`):
    {
      "filters": [{"field": "ps", "op": "<=", "value": 15}, ...],
      "weights": {"quality": 60, "value": 25, "momentum": 15},
      "aiMultiplier": true,
      "topN": 40,
      "sort": {"column": "score", "dir": "desc"},
    }
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("screen")

FILTER_FIELDS = {
    "sector", "country", "ps", "rev_growth_ttm", "gross_margin", "fcf_margin",
    "net_margin", "operating_margin", "rule_of_40", "ret_52w", "price",
}
TEXT_FIELDS = {"sector", "country"}

MOM_FLOOR = -50.0  # falling-knife collar
MOM_CAP = 40.0     # blow-off-top collar


# ---- pure scoring ---------------------------------------------------------

def _percentiles(values: list[float | None]) -> list[float | None]:
    """value -> 0..1 empirical percentile over a column (nulls stay None)."""
    present = sorted(v for v in values if v is not None)
    n = len(present)
    if n == 0:
        return [None] * len(values)
    out: list[float | None] = []
    import bisect
    for v in values:
        if v is None:
            out.append(None)
        else:
            out.append(bisect.bisect_right(present, v) / n)
    return out


def _matches(row: dict, f: dict) -> bool:
    field = f.get("field")
    op = f.get("op")
    if field not in FILTER_FIELDS:
        return True
    raw = row.get(field)
    if field in TEXT_FIELDS:
        a = ("" if raw is None else str(raw)).lower()
        b = str(f.get("value", "")).lower()
        return {
            "==": a == b, "!=": a != b, "<=": a <= b,
            ">=": a >= b, "<": a < b, ">": a > b,
        }.get(op, True)
    if raw is None:
        return False  # a numeric filter excludes names missing that datum
    try:
        v = float(raw)
        t = float(f.get("value"))
    except (TypeError, ValueError):
        return True
    return {
        "<=": v <= t, ">=": v >= t, "<": v < t,
        ">": v > t, "==": v == t, "!=": v != t,
    }.get(op, True)


def apply_filters(facts: list[dict], filters: list[dict]) -> list[dict]:
    if not filters:
        return list(facts)
    return [r for r in facts if all(_matches(r, f) for f in filters)]


def _ai_multiplier(bull: bool | None, bear: bool | None) -> float:
    if bull is None or bear is None:
        return 1.0
    if bull and bear:
        return 1.3
    if (not bull) and bear:
        return 1.0
    if bull and (not bear):
        return 0.7
    return 0.4


def _f(v: Any) -> float | None:
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x else None  # drop NaN


def score_screen(facts: list[dict], config: dict) -> list[dict]:
    """Return the ranked rows (each a copy of the fact dict + score/rank)."""
    filters = config.get("filters") or []
    weights = config.get("weights") or {"quality": 45, "value": 25, "momentum": 20}
    subset = apply_filters(facts, filters)

    ps_ratio = []
    mom = []
    for r in subset:
        ps = _f(r.get("ps"))
        med = _f(r.get("ps_median_12m"))
        # P/S relative to its own 12-mo median; fall back to a neutral 1.0
        # (ps/ps) when the median is missing. Guard the denominator so a
        # ps of 0 (or 0 fallback) doesn't divide by zero — just unscoreable.
        denom = med if (med and med > 0) else ps
        ps_ratio.append(ps / denom if (ps is not None and denom) else None)
        ret = _f(r.get("ret_52w"))
        mom.append(None if ret is None else max(MOM_FLOOR, min(MOM_CAP, ret)))

    p_r40 = _percentiles([_f(r.get("rule_of_40")) for r in subset])
    p_fcf = _percentiles([_f(r.get("fcf_margin")) for r in subset])
    p_gm = _percentiles([_f(r.get("gross_margin")) for r in subset])
    p_val = _percentiles(ps_ratio)
    p_mom = _percentiles(mom)

    wq = float(weights.get("quality", 0))
    wv = float(weights.get("value", 0))
    wm = float(weights.get("momentum", 0))
    wsum = wq + wv + wm or 1.0
    ai_on = bool(config.get("aiMultiplier", True))

    scored: list[dict] = []
    for i, r in enumerate(subset):
        quality = 0.6 * (p_r40[i] or 0) + 0.25 * (p_fcf[i] or 0) + 0.15 * (p_gm[i] or 0)
        value = 0.0 if p_val[i] is None else 1 - p_val[i]
        momentum = p_mom[i] or 0
        score = ((wq * quality + wv * value + wm * momentum) / wsum) * 100
        if ai_on:
            score *= _ai_multiplier(r.get("bull"), r.get("bear"))
        row = dict(r)
        row["score"] = score
        row["quality_pct"] = round(quality * 100)
        row["value_pct"] = round(value * 100)
        row["momentum_pct"] = round(momentum * 100)
        scored.append(row)

    sort = config.get("sort") or {}
    col = sort.get("column", "score")
    sign = -1.0 if sort.get("dir", "desc") != "asc" else 1.0

    def _key(r: dict):
        v = r.get(col)
        nv = v if isinstance(v, (int, float)) else float("-inf")
        # Ascending sort on (sign*value, ticker): for desc this yields value
        # descending with ticker as an ascending tie-break — matching score.ts.
        return (sign * nv, r["ticker"])

    scored.sort(key=_key)
    for idx, r in enumerate(scored, 1):
        r["rank"] = idx
    return scored


# ---- data load + buyer entrypoint ----------------------------------------

def _rpc_all(db, fn: str) -> list[dict]:
    rows: list[dict] = []
    page = 0
    while True:
        resp = db.client.rpc(fn).range(page * 1000, (page + 1) * 1000 - 1).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        page += 1
    return rows


def load_facts(db) -> list[dict]:
    """Load Level 0 facts for the whole Tier 1 universe + the AI overlay."""
    facts = _rpc_all(db, "screen_facts")
    overlay = {r["ticker"]: r for r in _rpc_all(db, "screen_ai_overlay")}
    for r in facts:
        v = overlay.get(r["ticker"])
        r["bull"] = (v or {}).get("bull")
        r["bear"] = (v or {}).get("bear")
    return facts


def run_screen(db, config: dict) -> list[dict]:
    """Ranked rows for a config (the full matched subset)."""
    return score_screen(load_facts(db), config)


def top_n_tickers(db, config: dict, n: int | None = None) -> list[str]:
    """The buyer's candidate list — the top N tickers of the portfolio's
    screen. `n` defaults to config['topN'] (default 40)."""
    limit = n if n is not None else int(config.get("topN", 40))
    return [r["ticker"] for r in run_screen(db, config)[:limit]]


def portfolio_screen_config(db, portfolio_id: str | None) -> dict | None:
    """Load a portfolio's stored selection recipe (portfolios.screen_config)."""
    if not portfolio_id:
        return None
    try:
        resp = (
            db.client.table("portfolios")
            .select("screen_config")
            .eq("id", portfolio_id)
            .maybe_single()
            .execute()
        )
    except Exception:
        return None
    if not resp or not resp.data:
        return None
    return resp.data.get("screen_config")


def portfolio_screen_candidates(db, portfolio_id: str | None) -> dict[str, str | None]:
    """The buyer's candidate set: the top N of a portfolio's screen.

    The screener is the funnel's selection stage (screener brief v2 §3) — a
    portfolio's candidate names are the top N of its `screen_config`, ranked
    deterministically here. Returns ``{ticker: rationale}`` where the rationale
    records the screen rank + score (so a recorded thesis carries the "why").
    Empty when the portfolio has no screen configured.
    """
    cfg = portfolio_screen_config(db, portfolio_id)
    if not cfg:
        return {}
    ranked = run_screen(db, cfg)
    top_n = int(cfg.get("topN", 40))
    return {
        r["ticker"]: f"screen rank #{r['rank']} · score {r['score']:.1f}"
        for r in ranked[:top_n]
    }
