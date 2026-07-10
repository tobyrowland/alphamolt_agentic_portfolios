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
      "weights": {"quality": 60, "value": 25, "momentum": 15, "inflection": 0},
      "aiMultiplier": true,
      "aiBudget": 0.7,
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
    "sector", "industry", "country", "ps", "rev_growth_ttm", "gross_margin",
    "fcf_margin", "net_margin", "operating_margin", "rule_of_40", "ret_52w",
    "perf_52w_vs_spy",  # derived in load_facts (ret_52w − SPY's 52w return)
    "price",
    # Turnaround facts (migration 074). Washout structure:
    "drawdown_52w",       # % below the 52-week closing high (positive)
    "above_low_26w",      # % above the 26-week closing low
    "ps_vs_median",       # signed % premium to the name's own 12-mo median P/S
    # Inflection gate: how many of the three QoQ streaks (GM expanding, QoQ
    # revenue growth improving, FCF margin improving) are ≥ 2 quarters (0–3).
    "inflection_signals",
    # Survivability gate (hard filters, never scored):
    "net_debt_ebitda",
    "interest_coverage",
    # Series-only fields (migration 075): no scalar matview column — usable
    # only WITH a transform (see SERIES_FIELDS / _TRANSFORMS below).
    "rev_growth_qoq",
    "revenue",
}
TEXT_FIELDS = {"sector", "industry", "country"}

# ---- filter transforms (migration 075) --------------------------------------
# Time-series math over the stored quarterly metric series (the `quarters`
# JSONB on each screen_facts row — eodhd_updater.compute_quarterly_series,
# newest-first, up to 12 quarters). A filter carrying `transform` compares its
# value against the transform of the metric's series instead of the row scalar.
# Every rule here MUST match web/lib/screen/transforms.ts exactly — same null
# rules, same arithmetic expressions (shared parity fixture:
# tests/fixtures/transform_parity.json).

# Filter field → key inside the `quarters` series object.
SERIES_FIELDS = {
    "gross_margin": "gross_margin",
    "operating_margin": "operating_margin",
    "net_margin": "net_margin",
    "fcf_margin": "fcf_margin",
    "rev_growth_qoq": "rev_growth_qoq",
    "revenue": "revenue",
}
# Fields with no scalar matview column — a transform-less filter on one is a
# no-constraint (matches everything), the same on both scorers.
SERIES_ONLY_FIELDS = {"rev_growth_qoq", "revenue"}


def _series_for(quarters, key: str) -> list[float | None] | None:
    """One metric's numeric series (newest-first) off the quarters object;
    None when absent/malformed. Mirrors transforms.ts seriesFor."""
    if not isinstance(quarters, dict):
        return None
    raw = quarters.get(key)
    if not isinstance(raw, list):
        return None
    return [_f(v) for v in raw]


def _t_delta_qoq(s: list[float | None]) -> float | None:
    if len(s) < 2 or s[0] is None or s[1] is None:
        return None
    return s[0] - s[1]


def _t_yoy(s: list[float | None]) -> float | None:
    if len(s) < 5 or s[0] is None or s[4] is None:
        return None
    return s[0] - s[4]


def _t_streak_qtrs(s: list[float | None]) -> float | None:
    """Consecutive improving steps from the newest value backwards — the same
    semantics as eodhd_updater._improvement_streak."""
    if len(s) < 2 or s[0] is None or s[1] is None:
        return None
    n = 0
    for cur, prev in zip(s, s[1:]):
        if cur is None or prev is None or cur <= prev:
            break
        n += 1
    return float(n)


def _t_slope_4q(s: list[float | None]) -> float | None:
    """Least-squares trend per quarter over the last 4 points (positive =
    improving toward the present). Closed form for times [0,−1,−2,−3] so both
    implementations evaluate the identical expression. Needs all 4 present."""
    if len(s) < 4 or any(v is None for v in s[:4]):
        return None
    v0, v1, v2, v3 = s[0], s[1], s[2], s[3]
    return (1.5 * v0 + 0.5 * v1 - 0.5 * v2 - 1.5 * v3) / 5


def _present_4(s: list[float | None]) -> list[float]:
    return [v for v in s[:4] if v is not None]


def _t_mean_4q(s: list[float | None]) -> float | None:
    vals = _present_4(s)
    if len(vals) < 2:
        return None
    return sum(vals) / len(vals)


def _t_min_4q(s: list[float | None]) -> float | None:
    vals = _present_4(s)
    return min(vals) if vals else None


def _t_max_4q(s: list[float | None]) -> float | None:
    vals = _present_4(s)
    return max(vals) if vals else None


def _t_range_4q(s: list[float | None]) -> float | None:
    vals = _present_4(s)
    if len(vals) < 2:
        return None
    return max(vals) - min(vals)


def _t_pctile_own(s: list[float | None]) -> float | None:
    """The latest value's empirical percentile (0–100) within the whole stored
    series — count(v ≤ latest)/n, the lens pctRank convention. Needs ≥ 4."""
    if not s or s[0] is None:
        return None
    latest = s[0]
    vals = [v for v in s if v is not None]
    if len(vals) < 4:
        return None
    return sum(1 for v in vals if v <= latest) / len(vals) * 100


_TRANSFORMS = {
    "delta_qoq": _t_delta_qoq,       # latest quarter minus prior
    "yoy": _t_yoy,                   # latest quarter minus the year-ago quarter
    "streak_qtrs": _t_streak_qtrs,   # consecutive improving steps
    "slope_4q": _t_slope_4q,         # LSQ trend per quarter over the last 4
    "mean_4q": _t_mean_4q,
    "min_4q": _t_min_4q,
    "max_4q": _t_max_4q,
    "range_4q": _t_range_4q,
    "pctile_own": _t_pctile_own,     # latest vs the name's own stored history
}


def apply_transform(series: list[float | None] | None, transform) -> float | None:
    """Evaluate a transform over a series; None series / unknown transform /
    not enough data ⇒ None (a numeric filter then excludes the row)."""
    fn = _TRANSFORMS.get(transform)
    if fn is None or series is None:
        return None
    return fn(series)

MOM_FLOOR = -50.0  # falling-knife collar
MOM_CAP = 40.0     # blow-off-top collar

# Value lens blend (migration 058): the lens reads cheapness BOTH vs the name's
# own 12-mo P/S median (self-relative) AND vs its peer-group median P/S
# (sector-relative). Equal-weight by default; falls back to pure self-relative
# when a name has no peer median. MUST match web/lib/screen/score.ts.
VAL_W_SELF = 0.5
VAL_W_PEER = 0.5

# Inflection lens (migration 074) — the turnaround screen's cross-sectional
# signal: a blend of the latest quarter-over-quarter deltas (QoQ revenue-growth
# acceleration, gross-margin change, FCF-margin change, all in pp), each
# collared so a micro-denominator quarter can't own the lens. Null when all
# three inputs are missing (⇒ neutral 0.5 percentile), so names whose
# fundamentals rotation hasn't computed the facts yet rank unaffected.
# MUST match web/lib/screen/score.ts.
INF_W_REV = 0.45
INF_W_GM = 0.35
INF_W_FCF = 0.20
INF_REV_COLLAR = 30.0   # pp collar on QoQ revenue-growth acceleration
INF_MARGIN_COLLAR = 20.0  # pp collar on the two margin deltas

# Financial-sector lens neutralisation. P/S is a category error for banks/
# insurers/REITs (their "sales" are gross interest/trading/rental flows, so P/S
# reads near-zero ⇒ a spurious "−99% cheap" Value boost), and R40 is distorted by
# volatile financial revenue. For these sectors we neutralise BOTH the Quality and
# Value lenses (→ None ⇒ scored at the median, 0σ), leaving Momentum as the only
# active lens — financials stay rankable/buyable but stop manufacturing spurious
# #1s. The set spans BOTH sector taxonomies present in the data ("Finance" and
# "Financial Services") plus "Real Estate". MUST match web/lib/screen/score.ts.
_FINANCIAL_SECTORS = frozenset({"finance", "financial services", "real estate"})


def _is_financial(sector) -> bool:
    return str(sector or "").strip().lower() in _FINANCIAL_SECTORS

# ---- single-score constants (migration 057 / screener redesign brief §2) ----
# One ordering score: final_z = base_z + adj_z, displayed as a universe
# percentile round(Φ(final_z)·100). These MUST match web/lib/screen/score.ts.
W_MOAT = 0.58       # AI moat weight inside the trajectory adjustment
W_EARN = 0.42       # AI earnings-quality weight
# (break-count penalty removed from the screen score — see _adj_z)
FLOOR = -1.5        # asymmetric floor on adj_z (in σ)
BUDGET = 0.7        # AI authority ceiling (in σ) — the DEFAULT
# The AI budget is per-screen configurable since migration 074 (the turnaround
# screen leans harder on the research card — "is something actually changing
# here" is exactly the card's trajectory read). config["aiBudget"] ∈ [0, 1.5],
# default BUDGET. MUST match web/lib/screen/config.ts AI_BUDGET_*.
AI_BUDGET_MAX = 1.5
# ---- verdict tilt (migration 066): graded bull/bear feed the rank ----------
# final_z = base_z + adj_z + verdict_z. A GENTLE additive tilt from the
# adversarial bull (Claude) + bear (Gemini) 1-5 scores — independent of the
# Gemini research card (adj_z). Neutral (0) unless BOTH scores are present.
# MUST match web/lib/screen/score.ts.
VERDICT_BUDGET = 0.3   # bull/bear authority ceiling (in σ) — structural bound ±0.3
W_BULL = 0.5
W_BEAR = 0.5
LENS_NAMES = ("quality", "value", "momentum", "inflection")


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


def probit(p: float) -> float:
    """Inverse normal CDF Φ⁻¹(p), p ∈ (0,1) — Acklam's approximation. Maps a
    blended percentile back to σ-space so the AI adjustment adds consistently.
    Mirrors web/lib/screen/score.ts probit()."""
    a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
         1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
    b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
         6.680131188771972e1, -1.328068155288572e1]
    c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
         -2.549732539343734, 4.374664141464968, 2.938163982698783]
    d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
         3.754408661907416]
    pl, ph = 0.02425, 1 - 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p <= ph:
        q = p - 0.5
        r = q * q
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
               (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)


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
    if field in TEXT_FIELDS:
        raw = row.get(field)
        a = ("" if raw is None else str(raw)).lower()
        b = str(f.get("value", "")).lower()
        if b == "":
            return True  # unset text filter = no constraint (parity with score.ts)
        return {
            "==": a == b, "!=": a != b, "<=": a <= b,
            ">=": a >= b, "<": a < b, ">": a > b,
        }.get(op, True)
    # Transform filters (migration 075): compare against time-series math over
    # the quarterly series instead of the row scalar. Unknown transform / a
    # field with no series ⇒ no constraint (parity with score.ts).
    transform = f.get("transform")
    if transform:
        key = SERIES_FIELDS.get(field)
        if key is None or transform not in _TRANSFORMS:
            return True
        v = apply_transform(_series_for(row.get("quarters"), key), transform)
    elif field in SERIES_ONLY_FIELDS:
        return True  # series-only field without a transform = no constraint
    else:
        v = _f(row.get(field))
    if v is None:
        return False  # a numeric filter excludes names missing that datum
    try:
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

def _lens_values(row: dict) -> tuple[float | None, float | None, float | None, float | None]:
    """(xQuality, xValue, xMomentum, xInflection) raw lens values for a fact
    row, or None per lens when its inputs are absent."""
    r40 = _f(row.get("rule_of_40"))
    fcf = _f(row.get("fcf_margin"))
    gm = _f(row.get("gross_margin"))
    # Growth-capped Rule-of-40 for the Quality lens: R40 = rev_growth + net_margin
    # (eodhd_updater), but micro-revenue names post absurd YoY growth (e.g. FDMT
    # +383,561%) that blow R40 to 6 figures and poison the lens. Cap the growth
    # component at +100% so the quality read reflects a real business, not a
    # tiny-denominator artifact. Falls back to the stored R40 when the components
    # aren't both present. Screener-local — stored rule_of_40 is untouched.
    rev_g = _f(row.get("rev_growth_ttm"))
    net_m = _f(row.get("net_margin"))
    r40_eff = (min(rev_g, 100.0) + net_m) if (rev_g is not None and net_m is not None) else r40
    # Quality: weighted blend; null only when ALL three components are missing
    # (fundamentals arrive as a unit). A missing component contributes 0.
    if r40_eff is None and fcf is None and gm is None:
        xq: float | None = None
    else:
        xq = 0.60 * (r40_eff or 0) + 0.25 * (fcf or 0) + 0.15 * (gm or 0)
    # Value: −(P/S ÷ reference) so cheaper ⇒ higher. The reference blends the
    # name's own 12-mo median (self-relative) with its peer-group median
    # (sector-relative, migration 058). Self denom falls back to raw P/S; the
    # peer term is dropped (weight renormalised to self) when no peer median is
    # available, so coverage gaps never null the lens. ps=0 yields None.
    ps = _f(row.get("ps"))
    med = _f(row.get("ps_median_12m"))
    peer = _f(row.get("peer_ps_median"))
    self_denom = med if (med and med > 0) else ps
    if ps is None or not self_denom:
        xv = None
    else:
        self_ratio = ps / self_denom
        if peer and peer > 0:
            peer_ratio = ps / peer
            xv = -(VAL_W_SELF * self_ratio + VAL_W_PEER * peer_ratio)
        else:
            xv = -self_ratio
    # Momentum: collared alpha vs SPY (perf_52w_vs_spy = ret_52w − SPY 52w).
    perf = _f(row.get("perf_52w_vs_spy"))
    xm = None if perf is None else max(MOM_FLOOR, min(MOM_CAP, perf))
    # Inflection (migration 074): collared blend of the latest QoQ deltas —
    # revenue-growth acceleration, gross-margin change, FCF-margin change.
    # Null only when ALL three are missing (a missing component contributes 0),
    # so uncovered names sit at the neutral median instead of sinking.
    rqa = _f(row.get("rev_qoq_accel"))
    gmd = _f(row.get("gm_delta_qoq"))
    fcd = _f(row.get("fcf_delta_qoq"))
    if rqa is None and gmd is None and fcd is None:
        xi: float | None = None
    else:
        def _collar(v: float | None, c: float) -> float:
            return 0.0 if v is None else max(-c, min(c, v))
        xi = (INF_W_REV * _collar(rqa, INF_REV_COLLAR)
              + INF_W_GM * _collar(gmd, INF_MARGIN_COLLAR)
              + INF_W_FCF * _collar(fcd, INF_MARGIN_COLLAR))
    # Financials: P/S and R40 are category errors — and so are GM/FCF deltas —
    # neutralise Quality + Value + Inflection (rank on Momentum only).
    # MUST match web/lib/screen/score.ts.
    if _is_financial(row.get("sector")):
        return None, None, xm, None
    return xq, xv, xm, xi


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
        xq, xv, xm, xi = _lens_values(r)
        if xq is not None:
            cols["quality"].append(xq)
        if xv is not None:
            cols["value"].append(xv)
        if xm is not None:
            cols["momentum"].append(xm)
        if xi is not None:
            cols["inflection"].append(xi)
    return {k: _stats_from_values(cols[k]) for k in LENS_NAMES}


def _z(x: float | None, st: dict | None) -> float:
    """Winsorized z-score of a raw lens value (None ⇒ 0 = at the mean)."""
    if x is None or not st:
        return 0.0
    sigma = st.get("sigma") or 1.0
    return max(-3.0, min(3.0, (x - st.get("mu", 0.0)) / sigma))


# ---- break-signal firing (display) ----------------------------------------
# A research card's break_signals are forward-looking watch-conditions; the
# screener flags a name red only when one is CURRENTLY firing against its own
# facts. Mirrors theses._evaluate_signal (the reviewer's checker) + score.ts.
# Maps the signal vocabulary (_ALLOWED_SIGNAL_FIELDS) onto screen-fact columns.
_SIGNAL_FIELD_MAP = {
    "gross_margin_pct": "gross_margin",
    "operating_margin_pct": "operating_margin",
    "net_margin_pct": "net_margin",
    "fcf_margin_pct": "fcf_margin",
    "rev_growth_ttm_pct": "rev_growth_ttm",
    "rule_of_40": "rule_of_40",
    "r40_score": "rule_of_40",
    "ps_now": "ps",
    "perf_52w_vs_spy": "perf_52w_vs_spy",
    "price": "price",
}
_STATIC_OPS = {
    ">": lambda c, t: c > t,
    ">=": lambda c, t: c >= t,
    "<": lambda c, t: c < t,
    "<=": lambda c, t: c <= t,
    "==": lambda c, t: c == t,
    "!=": lambda c, t: c != t,
}


def _signal_fires(row: dict, signal: dict) -> bool:
    """True iff this break signal's condition is currently true against the row.

    Unmapped fields, missing/non-numeric values, and change_pct_* ops (which need
    a prior snapshot the screener doesn't have) all return False — conservative,
    matching theses._evaluate_signal (no false positives)."""
    if not isinstance(signal, dict):
        return False
    col = _SIGNAL_FIELD_MAP.get(signal.get("field"))
    op = signal.get("op")
    if col is None or op not in _STATIC_OPS:
        return False
    cur = _f(row.get(col))
    thr = _f(signal.get("value"))
    if cur is None or thr is None:
        return False
    return bool(_STATIC_OPS[op](cur, thr))


def firing_break_count(row: dict) -> int:
    """How many of the row's research-card break signals are firing right now."""
    card = row.get("research_card")
    if not isinstance(card, dict):
        return 0
    signals = card.get("break_signals")
    if not isinstance(signals, list):
        return 0
    return sum(1 for s in signals if _signal_fires(row, s))


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


def _verdict_z(row: dict, budget: float = VERDICT_BUDGET) -> dict:
    """Graded bull/bear tilt (migration 066). Neutral (0) unless BOTH scores
    present — same "no penalty for unevaluated" rule as the card. bull pushes up,
    bear (red-flag severity) pushes down; structural bound ±budget. MUST match
    web/lib/screen/score.ts."""
    bull = _f(row.get("bull_score"))
    bear = _f(row.get("bear_score"))
    if bull is None or bear is None:
        return {"verdict_z": 0.0, "bull_z": 0.0, "bear_z": 0.0, "has_verdict": False}
    u_bull = (bull - 3) / 2   # ∈ [-1, 1]
    u_bear = (bear - 3) / 2
    bull_z = budget * W_BULL * u_bull
    bear_z = budget * W_BEAR * u_bear
    verdict_z = bull_z - bear_z   # natural bound ±budget (both u=±1)
    return {"verdict_z": verdict_z, "bull_z": bull_z, "bear_z": bear_z,
            "has_verdict": True}


def _pct_rank(sorted_vals: list[float], x: float | None) -> float:
    """Empirical percentile of x within a pre-sorted universe (∈[0,1]); a missing
    value or empty universe ⇒ 0.5 (neutral, at the median)."""
    if x is None or not sorted_vals:
        return 0.5
    import bisect
    return bisect.bisect_right(sorted_vals, x) / len(sorted_vals)


def score_screen(facts: list[dict], config: dict,
                 stats: dict[str, dict] | None = None) -> list[dict]:
    """Return the ranked rows (each a copy of the fact dict + score fields).

    Single ordering score: final_z = base_z + adj_z, ranked on it, surfaced as a
    universe percentile. The quant **base** is built from EMPIRICAL PERCENTILES of
    each lens over the full universe (outlier-robust), blended by the weights, then
    mapped back to σ via probit so the AI `adj_z` adds consistently. `stats` is
    accepted but ignored (the percentile base needs no materialized μ/σ); kept for
    signature back-compat. Mirrors web/lib/screen/score.ts.
    """
    filters = config.get("filters") or []
    weights = config.get("weights") or {"quality": 45, "value": 25,
                                        "momentum": 20, "inflection": 0}
    # Per-screen AI authority (migration 074): how far the research card can
    # move a name, in σ. Defaults to the classic BUDGET; clamped to [0, MAX].
    raw_budget = _f(config.get("aiBudget"))
    ai_budget = BUDGET if raw_budget is None else max(0.0, min(AI_BUDGET_MAX, raw_budget))

    # Lens distributions over the FULL universe (pre-filter) — so a name's
    # percentile is its standing in the whole Tier-1 set, not the filtered subset,
    # and is deterministic (TS and Python load the same universe → parity).
    uq: list[float] = []
    uv: list[float] = []
    um: list[float] = []
    ui: list[float] = []
    for r in facts:
        xq, xv, xm, xi = _lens_values(r)
        if xq is not None:
            uq.append(xq)
        if xv is not None:
            uv.append(xv)
        if xm is not None:
            um.append(xm)
        if xi is not None:
            ui.append(xi)
    uq.sort()
    uv.sort()
    um.sort()
    ui.sort()

    subset = apply_filters(facts, filters)
    wq = float(weights.get("quality", 0))
    wv = float(weights.get("value", 0))
    wm = float(weights.get("momentum", 0))
    wi = float(weights.get("inflection", 0) or 0)
    wsum = wq + wv + wm + wi or 1.0

    scored: list[dict] = []
    for r in subset:
        xq, xv, xm, xi = _lens_values(r)
        pq = _pct_rank(uq, xq)
        pv = _pct_rank(uv, xv)
        pm = _pct_rank(um, xm)
        pi = _pct_rank(ui, xi)
        base_score = (wq * pq + wv * pv + wm * pm + wi * pi) / wsum  # ∈ [0,1]
        base_z = probit(min(max(base_score, 0.001), 0.999))    # back to σ-space
        a = _adj_z(r, budget=ai_budget)
        vz = _verdict_z(r)
        final_z = base_z + a["adj_z"] + vz["verdict_z"]
        row = dict(r)
        row["base_score"] = base_score
        row["base_z"] = base_z
        row["adj_z"] = a["adj_z"]
        row["moat_z"] = a["moat_z"]
        row["earn_z"] = a["earn_z"]
        row["break_z"] = a["break_z"]
        row["verdict_z"] = vz["verdict_z"]
        row["bull_z"] = vz["bull_z"]
        row["bear_z"] = vz["bear_z"]
        row["capped"] = a["capped"]
        row["floored"] = a["floored"]
        row["quality_pct"] = round(pq * 100)
        row["value_pct"] = round(pv * 100)
        row["momentum_pct"] = round(pm * 100)
        row["inflection_pct"] = round(pi * 100)
        row["base_pct"] = round(base_score * 100)
        row["final_pct"] = round(phi(final_z) * 100)
        # Count of break signals currently firing (display: the red "AI flags"
        # chip / pip), distinct from break_count (how many are defined).
        row["firing_breaks"] = firing_break_count(r)
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
        # Graded bull/bear scores (migration 066) — drive the screener verdict_z.
        r["bull_score"] = v.get("bull_score")
        r["bear_score"] = v.get("bear_score")
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
    """Ranked rows for a config (the full matched subset). The percentile base
    needs no materialized lens stats — it ranks over the loaded universe."""
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
    # Only buy names with AI analysis — require a research card (has_card). The
    # screener still ranks/displays un-carded names (it's a research tool); the
    # BUYER's candidate pool excludes them so the portfolio never buys an
    # un-analysed name. Filtered before the topN slice, so the cut is the top N
    # of *buyable* names. Default on; escapable per-portfolio via
    # screen_config.requireResearchCard=false.
    if cfg.get("requireResearchCard", True):
        ranked = [r for r in ranked if r.get("has_card")]
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
