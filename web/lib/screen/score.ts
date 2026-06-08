/**
 * Deterministic scoring-as-a-function (brief v2 §2/§6).
 *
 * Given the shared Level 0 facts (one row per Tier 1 ticker from
 * screen_facts()) and a screen config, produce the ranked rows for THAT
 * config. Pure computation — no LLM, no per-user precomputed pipeline, no DB
 * access. The same formula is mirrored in screen.py so the Python buyer ranks
 * the identical top N.
 *
 * Lens-relative by construction: each component is an EMPIRICAL percentile
 * within the filtered candidate set, so outliers (e.g. a Rule-of-40 of 26,000
 * from a tiny-revenue base) pin to the top percentile instead of blowing up
 * the scale. Composite = weighted blend of the three component percentiles,
 * scaled 0–100, then an optional AI bull/bear multiplier.
 */

import type { Filter, ScreenConfig } from "@/lib/screen/config";
import { TEXT_FIELDS } from "@/lib/screen/config";

export interface ScreenFacts {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  price: number | null;
  price_asof: string | null;
  rev_growth_ttm: number | null;
  gross_margin: number | null;
  fcf_margin: number | null;
  net_margin: number | null;
  operating_margin: number | null;
  rule_of_40: number | null;
  ps: number | null;
  ps_median_12m: number | null;
  ret_52w: number | null;
  // AI verdict overlay (from companies; Level 0 itself is strategy-neutral)
  bull: boolean | null;
  bear: boolean | null;
}

export interface ScoredRow extends ScreenFacts {
  rank: number;
  score: number;
  quality_pct: number; // 0–100, for transparency / debugging
  value_pct: number;
  momentum_pct: number;
}

// Momentum collar (brief / CLAUDE.md): a falling knife scores 0, a blow-off
// top is capped — applied before percentile-ranking the 52w return.
const MOM_FLOOR = -50;
const MOM_CAP = 40;

/** A value→0..1 empirical percentile map over a column (nulls stay null). */
function percentiles(values: (number | null)[]): (number | null)[] {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return values.map(() => null);
  const sorted = [...present].sort((a, b) => a - b);
  const n = sorted.length;
  return values.map((v) => {
    if (v == null || !Number.isFinite(v)) return null;
    // fraction of values <= v (upper bound), in [1/n, 1]
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  });
}

function matchesFilter(row: ScreenFacts, f: Filter): boolean {
  const raw = (row as unknown as Record<string, unknown>)[f.field === "ps" ? "ps" : f.field];
  if (TEXT_FIELDS.has(f.field)) {
    const a = (raw == null ? "" : String(raw)).toLowerCase();
    const b = String(f.value).toLowerCase();
    if (f.op === "==") return a === b;
    if (f.op === "!=") return a !== b;
    // ordering ops on text fall back to string compare
    if (f.op === "<=") return a <= b;
    if (f.op === ">=") return a >= b;
    if (f.op === "<") return a < b;
    return a > b;
  }
  const v = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (v == null) return false; // a numeric filter excludes names missing that datum
  const t = Number(f.value);
  switch (f.op) {
    case "<=":
      return v <= t;
    case ">=":
      return v >= t;
    case "<":
      return v < t;
    case ">":
      return v > t;
    case "==":
      return v === t;
    case "!=":
      return v !== t;
  }
}

export function applyFilters(facts: ScreenFacts[], filters: Filter[]): ScreenFacts[] {
  if (!filters.length) return facts;
  return facts.filter((row) => filters.every((f) => matchesFilter(row, f)));
}

function aiMultiplier(bull: boolean | null, bear: boolean | null): number {
  if (bull == null || bear == null) return 1.0; // no penalty for missing eval
  if (bull && bear) return 1.3; // dual-positive
  if (!bull && bear) return 1.0; // sound, no edge
  if (bull && !bear) return 0.7; // story but red flags
  return 0.4; // avoid
}

export interface ScreenResult {
  rows: ScoredRow[];
  match_count: number;
  total_universe: number;
  cut_index: number; // rows[0..cut_index) are the buyer's candidates (top N)
}

/**
 * Rank the universe for a config. `total` is the full Tier 1 count (pre-filter)
 * for the `total_universe` field; defaults to facts.length.
 */
export function scoreScreen(
  facts: ScreenFacts[],
  config: ScreenConfig,
  total?: number,
): ScreenResult {
  const subset = applyFilters(facts, config.filters);

  // Value driver: P/S relative to the stock's own 12-month median (cheaper =
  // better). Falls back to raw P/S when no median is recorded; guards the
  // denominator so a P/S of 0 yields null (unscoreable) instead of NaN.
  const psRatio = subset.map((r) => {
    if (r.ps == null) return null;
    const denom = r.ps_median_12m && r.ps_median_12m > 0 ? r.ps_median_12m : r.ps;
    return denom ? r.ps / denom : null;
  });
  const mom = subset.map((r) =>
    r.ret_52w == null ? null : Math.max(MOM_FLOOR, Math.min(MOM_CAP, r.ret_52w)),
  );

  const pR40 = percentiles(subset.map((r) => r.rule_of_40));
  const pFcf = percentiles(subset.map((r) => r.fcf_margin));
  const pGm = percentiles(subset.map((r) => r.gross_margin));
  const pVal = percentiles(psRatio); // lower ratio → lower pct → inverted below
  const pMom = percentiles(mom);

  const { quality: wq, value: wv, momentum: wm } = config.weights;
  const wsum = wq + wv + wm || 1;

  const scored: ScoredRow[] = subset.map((r, i) => {
    const quality = 0.6 * (pR40[i] ?? 0) + 0.25 * (pFcf[i] ?? 0) + 0.15 * (pGm[i] ?? 0);
    const value = pVal[i] == null ? 0 : 1 - (pVal[i] as number); // invert: cheap = high
    const momentum = pMom[i] ?? 0;
    let score = ((wq * quality + wv * value + wm * momentum) / wsum) * 100;
    if (config.aiMultiplier) score *= aiMultiplier(r.bull, r.bear);
    return {
      ...r,
      rank: 0,
      score,
      quality_pct: Math.round(quality * 100),
      value_pct: Math.round(value * 100),
      momentum_pct: Math.round(momentum * 100),
    };
  });

  // Sort: by the configured column (default score), then ticker for stability.
  const col = config.sort.column;
  const dir = config.sort.dir === "asc" ? 1 : -1;
  scored.sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[col];
    const bv = (b as unknown as Record<string, unknown>)[col];
    const an = typeof av === "number" ? av : Number.NEGATIVE_INFINITY;
    const bn = typeof bv === "number" ? bv : Number.NEGATIVE_INFINITY;
    if (an !== bn) return (an - bn) * dir;
    return a.ticker.localeCompare(b.ticker);
  });
  scored.forEach((r, i) => (r.rank = i + 1));

  return {
    rows: scored,
    match_count: scored.length,
    total_universe: total ?? facts.length,
    cut_index: Math.min(config.topN, scored.length),
  };
}
