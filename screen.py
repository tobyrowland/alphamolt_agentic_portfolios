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
import math
from typing import Any

logger = logging.getLogger("screen")

FILTER_FIELDS = {
    "sector", "country", "ps", "rev_growth_ttm", "gross_margin", "fcf_margin",
    "net_margin", "operating_margin", "rule_of_40", "ret_52w",
    "perf_52w_vs_spy",  # derived in load_facts (ret_52w − SPY's 52w return)
    "price",
}
TEXT_FIELDS = {"sector", "country"}

MOM_FLOOR = -50.0  # falling-knife collar
MOM_CAP = 40.0     # blow-off-top collar

# ---- single-score constants (migration 057 / screener redesign brief §2) ----
# One ordering score: final_z = base_z + adj_z, displayed as a universe
# percentile round(Φ(final_z)·100). These MUST match web/lib/screen/score.ts.
W_MOAT = 0.58       # AI moat weight inside the trajectory adjustment
W_EARN = 0.42       # AI earnings-quality weight
# (break-count penalty removed from the screen score — see _adj_z)
FLOOR = -1.5        # asymmetric floor on adj_z (in σ)
BUDGET = 0.7        # AI authority ceiling (in σ) — fixed server constant (decision 1)
LENS_NAMES = ("quality", "value", "momentum")


# ---- normal CDF (Abramowitz–Stegun erf), ported from the v8 mockup ----------
# Both scorers use the identical approximation so round(Φ(z)·100) is byte-equal.

def _erf(x: float) -> float:
    s = -1.0 if x < 0 else 1.0
    x = abs(x)
    a1, a2, a3, a4, a5, p = (
        0.254829592, -0.284496736, 1.421413741,
        -1.453152027, 1.061405429, 0.3275911,
    )
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x)
    return s * y


def phi(z: float) -> float:
    """Standard-normal CDF Φ(z) ∈ (0,1)."""
    return 0.5 * (1.0 + _erf(z / math.sqrt(2.0)))


# ---- pure scoring ---------------------------------------------------------

def _percentiles(values: list[float | None]) -> list[float | None]:
    """value -> 0..1 empirical percentile over a column (nulls stay None).

    Retained for back-compat / external callers; the single-score path uses
    cross-sectional z-scores (compute_lens_stats), not per-column percentiles.
    """
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
        if b == "":
            return True  # unset text filter = no constraint (parity with score.ts)
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


def _f(v: Any) -> float | None:
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x else None  # drop NaN


# ---- raw lens values (brief §2) -------------------------------------------
# Each lens is a single raw scalar, standardized against materialized universe
# moments (compute_lens_stats). The derivations here MUST match score.ts.

def _lens_values(row: dict) -> tuple[float | None, float | None, float | None]:
    """(xQuality, xValue, xMomentum) raw lens values for a fact row, or None
    per lens when its inputs are absent."""
    r40 = _f(row.get("rule_of_40"))
    fcf = _f(row.get("fcf_margin"))
    gm = _f(row.get("gross_margin"))
    # Quality: weighted blend; null only when ALL three components are missing
    # (fundamentals arrive as a unit). A missing component contributes 0.
    if r40 is None and fcf is None and gm is None:
        xq: float | None = None
    else:
        xq = 0.60 * (r40 or 0) + 0.25 * (fcf or 0) + 0.15 * (gm or 0)
    # Value: −(P/S ÷ own 12-mo median) so cheaper ⇒ higher. Median falls back to
    # raw P/S; denominator guarded so ps=0 yields None (unscoreable), not NaN.
    ps = _f(row.get("ps"))
    med = _f(row.get("ps_median_12m"))
    denom = med if (med and med > 0) else ps
    xv = -(ps / denom) if (ps is not None and denom) else None
    # Momentum: collared alpha vs SPY (perf_52w_vs_spy = ret_52w − SPY 52w).
    perf = _f(row.get("perf_52w_vs_spy"))
    xm = None if perf is None else max(MOM_FLOOR, min(MOM_CAP, perf))
    return xq, xv, xm


def _stats_from_values(vals: list[float]) -> dict:
    """Population μ/σ over the present values; σ guarded ≥ tiny so z is finite."""
    n = len(vals)
    if n == 0:
        return {"mu": 0.0, "sigma": 1.0, "n": 0}
    mu = sum(vals) / n
    var = sum((v - mu) ** 2 for v in vals) / n
    sigma = math.sqrt(var)
    if not (sigma > 0):  # no spread (or NaN) → neutral scale
        sigma = 1.0
    return {"mu": mu, "sigma": sigma, "n": n}


def lens_stats_from_facts(facts: list[dict]) -> dict[str, dict]:
    """μ/σ/n per lens over the (pre-filter) universe of fact rows. Used as the
    in-memory fallback when screen_lens_stats hasn't been materialized yet; the
    same derivation both scorers apply, so parity holds."""
    cols: dict[str, list[float]] = {k: [] for k in LENS_NAMES}
    for r in facts:
        xq, xv, xm = _lens_values(r)
        if xq is not None:
            cols["quality"].append(xq)
        if xv is not None:
            cols["value"].append(xv)
        if xm is not None:
            cols["momentum"].append(xm)
    return {k: _stats_from_values(cols[k]) for k in LENS_NAMES}


def _z(x: float | None, st: dict | None) -> float:
    """Winsorized z-score of a raw lens value (None ⇒ 0 = at the mean)."""
    if x is None or not st:
        return 0.0
    sigma = st.get("sigma") or 1.0
    return max(-3.0, min(3.0, (x - st.get("mu", 0.0)) / sigma))


def _adj_z(row: dict, budget: float = BUDGET) -> dict:
    """AI trajectory adjustment (brief §2). Only for carded names; otherwise 0.
    Growth durability is deliberately NOT in the formula (already in R40)."""
    moat = _f(row.get("moat_score"))
    earn = _f(row.get("earnings_score"))
    has_card = bool(row.get("has_card")) and moat is not None and earn is not None
    if not has_card:
        return {"adj_z": 0.0, "moat_z": 0.0, "earn_z": 0.0, "break_z": 0.0,
                "capped": False, "floored": False, "has_card": False}
    u_moat = (moat - 3) / 2
    u_earn = (earn - 3) / 2
    moat_z = budget * W_MOAT * u_moat
    earn_z = budget * W_EARN * u_earn
    # Break signals are forward-looking watch-conditions (e.g. "fcf_margin < 5%"),
    # not faults that are currently true — and every card ships a base set of 3+.
    # Counting them sank EVERY researched name below the unresearched ones, so the
    # screen score no longer penalizes them. They stay visible on the card + the
    # badge flag pip, and still drive the buyer/reviewer.
    break_z = 0.0
    smooth_unit = W_MOAT * u_moat + W_EARN * u_earn  # natural max = 1.0 ⇒ +budget
    adj = moat_z + earn_z
    floored = adj < FLOOR
    if floored:
        adj = FLOOR
    # Upward bound is structural: the smooth part maxes at +budget (both u=1).
    capped = (smooth_unit >= 0.999 and budget > 0)
    return {"adj_z": adj, "moat_z": moat_z, "earn_z": earn_z, "break_z": break_z,
            "capped": capped, "floored": floored, "has_card": True}


def score_screen(facts: list[dict], config: dict,
                 stats: dict[str, dict] | None = None) -> list[dict]:
    """Return the ranked rows (each a copy of the fact dict + score fields).

    Single ordering score (brief §2): final_z = base_z + adj_z, ranked on it,
    surfaced as a universe percentile. `stats` are the materialized lens μ/σ
    (screen_lens_stats); when omitted they're derived from the full `facts` set
    (the graceful fallback before materialization) — identically in score.ts.
    """
    filters = config.get("filters") or []
    weights = config.get("weights") or {"quality": 45, "value": 25, "momentum": 20}
    if stats is None:
        stats = lens_stats_from_facts(facts)
    subset = apply_filters(facts, filters)

    wq = float(weights.get("quality", 0))
    wv = float(weights.get("value", 0))
    wm = float(weights.get("momentum", 0))
    wsum = wq + wv + wm or 1.0

    scored: list[dict] = []
    for r in subset:
        xq, xv, xm = _lens_values(r)
        zq = _z(xq, stats.get("quality"))
        zv = _z(xv, stats.get("value"))
        zm = _z(xm, stats.get("momentum"))
        base_z = (wq * zq + wv * zv + wm * zm) / wsum
        a = _adj_z(r)
        final_z = base_z + a["adj_z"]
        row = dict(r)
        row["base_z"] = base_z
        row["adj_z"] = a["adj_z"]
        row["moat_z"] = a["moat_z"]
        row["earn_z"] = a["earn_z"]
        row["break_z"] = a["break_z"]
        row["capped"] = a["capped"]
        row["floored"] = a["floored"]
        row["quality_z"] = zq
        row["value_z"] = zv
        row["momentum_z"] = zm
        row["base_pct"] = round(phi(base_z) * 100)
        row["final_pct"] = round(phi(final_z) * 100)
        # `score` stays the canonical sort key (now = final_z, the single score).
        row["score"] = final_z
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


def _spy_ret_52w(db) -> float | None:
    """SPY's trailing 52-week return (%), from benchmark_prices. Same 52-weeks-ago
    anchor as the per-ticker ret_52w, so the difference is a consistent vs-SPY.
    Mirrors web/lib/screen/query.ts fetchSpyRet52w()."""
    from datetime import date, timedelta
    cutoff = (date.today() - timedelta(weeks=52)).isoformat()
    try:
        latest = (db.client.table("benchmark_prices").select("close")
                  .eq("ticker", "SPY.US").order("price_date", desc=True)
                  .limit(1).execute())
        ago = (db.client.table("benchmark_prices").select("close")
               .eq("ticker", "SPY.US").lte("price_date", cutoff)
               .order("price_date", desc=True).limit(1).execute())
    except Exception:  # noqa: BLE001 — never let the benchmark read break the screen
        return None
    lv = _f((latest.data or [{}])[0].get("close")) if latest.data else None
    av = _f((ago.data or [{}])[0].get("close")) if ago.data else None
    if lv is None or av is None or av <= 0:
        return None
    return (lv / av - 1) * 100


def _active_exclusions(db) -> set[str]:
    """Tickers on the manual 1-year blocklist (migration 048) — dropped from the
    screen, so the buyer never considers them. Mirrors query.ts. Fail-open: a
    read error returns no exclusions rather than blocking the whole screen."""
    from datetime import datetime, timezone
    try:
        resp = (
            db.client.table("screener_exclusions")
            .select("ticker")
            .gt("expires_at", datetime.now(timezone.utc).isoformat())
            .execute()
        )
    except Exception:  # noqa: BLE001
        return set()
    return {(r.get("ticker") or "").upper() for r in (resp.data or [])}


def load_facts(db) -> list[dict]:
    """Load Level 0 facts for the whole Tier 1 universe + the AI overlay."""
    facts = _rpc_all(db, "screen_facts")
    overlay = {r["ticker"]: r for r in _rpc_all(db, "screen_ai_overlay")}
    excluded = _active_exclusions(db)
    if excluded:
        facts = [r for r in facts if (r.get("ticker") or "").upper() not in excluded]
    spy = _spy_ret_52w(db)
    for r in facts:
        v = overlay.get(r["ticker"]) or {}
        r["bull"] = v.get("bull")
        r["bear"] = v.get("bear")
        # Research-card scalars from the overlay (migration 057) — Python reads
        # them here so the buyer scores the same adj_z without the matview wait.
        r["quality_score"] = v.get("quality_score")
        r["moat_score"] = v.get("moat_score")
        r["earnings_score"] = v.get("earnings_score")
        r["growth_score"] = v.get("growth_score")
        r["break_count"] = v.get("break_count")
        r["has_card"] = bool(v.get("has_card"))
        # Derived "vs SPY" — kept in lockstep with query.ts so the buyer ranks
        # the identical filtered set.
        ret = _f(r.get("ret_52w"))
        r["perf_52w_vs_spy"] = (
            round(ret - spy, 1) if (ret is not None and spy is not None) else None
        )
    return facts


def load_lens_stats(db) -> dict[str, dict] | None:
    """Read the materialized universe lens μ/σ (screen_lens_stats, migration
    057). Returns None when the table is empty/unavailable, so score_screen
    falls back to deriving moments from the loaded facts."""
    try:
        resp = db.client.table("screen_lens_stats").select("lens, mu, sigma, n").execute()
    except Exception:  # noqa: BLE001
        return None
    rows = resp.data or []
    if not rows:
        return None
    out: dict[str, dict] = {}
    for r in rows:
        lens = r.get("lens")
        if lens in LENS_NAMES:
            out[lens] = {"mu": _f(r.get("mu")) or 0.0,
                         "sigma": _f(r.get("sigma")) or 1.0,
                         "n": int(r.get("n") or 0)}
    return out or None


def compute_lens_stats(db, *, dry_run: bool = False) -> dict[str, dict]:
    """Compute the universe μ/σ of each raw lens value over Tier 1 and upsert
    screen_lens_stats (migration 057). The single source of moments both scorers
    read, so the cross-sectional z-scores agree. Reuses load_facts (which folds
    in the SPY-adjusted momentum), so the lens derivations match the scorer
    exactly. Called by prices_daily_updater after the matview refresh."""
    from datetime import datetime, timezone
    stats = lens_stats_from_facts(load_facts(db))
    if not dry_run:
        now = datetime.now(timezone.utc).isoformat()
        rows = [{"lens": k, "mu": stats[k]["mu"], "sigma": stats[k]["sigma"],
                 "n": stats[k]["n"], "computed_at": now} for k in LENS_NAMES]
        db.client.table("screen_lens_stats").upsert(rows).execute()
    return stats


def run_screen(db, config: dict) -> list[dict]:
    """Ranked rows for a config (the full matched subset)."""
    return score_screen(load_facts(db), config, load_lens_stats(db))


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
    return {
        r["ticker"]: f"screen rank #{r['rank']} · {r.get('final_pct', 0)}th pct"
        for r in portfolio_screen_candidate_rows(db, portfolio_id)
    }


def portfolio_screen_candidate_rows(db, portfolio_id: str | None) -> list[dict]:
    """The top-N ranked **fact rows** of a portfolio's screen (not just the
    tickers). Each row is the Level 0 fact dict + ``score``/``rank``.

    The buyer sources its per-ticker evaluation data from these rows (Level 0
    facts), rather than the legacy ``in_tv_screen`` universe snapshot — so any
    Tier-1 screen candidate is evaluable. Honours the same ``hideRejected``
    90-day filter (migration 051) as the ticker map. Empty when the portfolio
    has no screen configured.
    """
    cfg = portfolio_screen_config(db, portfolio_id)
    if not cfg:
        return []
    ranked = run_screen(db, cfg)
    # Hide names this portfolio's buyer evaluated and passed on within the last
    # 90 days (migration 051), so the buyer doesn't churn straight back into
    # re-evaluating a name it just rejected. On by default; the owner can flip
    # it off (screen_config.hideRejected=false) or manually restore a name.
    if cfg.get("hideRejected", True):
        rejected = db.get_active_screener_rejections(portfolio_id)
        if rejected:
            ranked = [
                r for r in ranked
                if (r.get("ticker") or "").upper() not in rejected
            ]
    top_n = int(cfg.get("topN", 40))
    return ranked[:top_n]
