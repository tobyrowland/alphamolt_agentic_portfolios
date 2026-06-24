/**
 * Deterministic scoring-as-a-function (screener redesign brief §2).
 *
 * One ordering score: `final_z = base_z + adj_z`, ranked on `final_z`, displayed
 * as a universe percentile `round(Φ(final_z)·100)`. The old 0–100 composite and
 * the hidden ±20% AI/quality multipliers are gone.
 *
 *  - **base_z** standardizes each raw lens value (Quality / Value / Momentum)
 *    against the materialized universe moments (`screen_lens_stats`, migration
 *    057), winsorized to ±3σ, then blends them with the lens weights.
 *  - **adj_z** is the AI trajectory adjustment from the research card (moat +
 *    earnings, minus a per-break-signal penalty), bounded `[FLOOR, +budget]`.
 *    Growth durability is NOT in the formula (already in R40). No card ⇒ 0.
 *
 * Pure computation — no LLM, no DB. Mirrored byte-for-byte in screen.py so the
 * Python buyer ranks the identical top N (the parity constraint, brief §7).
 */

import type { Filter, ScreenConfig } from "@/lib/screen/config";
import { TEXT_FIELDS } from "@/lib/screen/config";

/** One scored dimension of the research card (moat / earnings / growth). */
export interface CardDim {
  score: number;
  rationale?: string;
  evidence?: string;
}
/** A machine-checkable break signal stored on the card. */
export interface CardBreak {
  op?: string;
  field?: string;
  value?: number;
  description?: string;
}
/** The AI research card (ai_analysis.research_card) — sparse (~3% of names).
 *  Carried verbatim so the page COMPILES copy from stored evidence (brief §7). */
export interface ResearchCard {
  moat?: CardDim;
  earnings_quality?: CardDim;
  growth_durability?: CardDim;
  break_signals?: CardBreak[];
  quality_score?: number;
  model?: string;
  version?: number;
}

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
  /** Trailing-quarter % change of the P/S multiple (migration 058). >0 = the
   *  multiple is re-rating up, <0 = compressing. Display + LLM only, not scored. */
  ps_trend_pct: number | null;
  ret_52w: number | null;
  /** 52-week return minus SPY's; derived in the loader, not a raw fact column. */
  perf_52w_vs_spy: number | null;
  // AI verdict overlay (lens; Level 0 itself is strategy-neutral)
  bull: boolean | null;
  bear: boolean | null;
  // Graded bull/bear conviction 1-5 (migration 066) — drive verdict_z.
  bull_score: number | null;
  bear_score: number | null;
  // Research-card scalars (migration 057). null ⇒ no card / dim absent.
  quality_score: number | null;
  moat_score: number | null;
  earnings_score: number | null;
  growth_score: number | null; // read-only on the card; never scored
  break_count: number | null;
  has_card: boolean;
  /** Full card JSON — present (~3%) for compiling thesis/dim copy at render. */
  research_card: ResearchCard | null;
  // Peer median P/S (migration 057) — display only this task (brief §5).
  industry_ps_median: number | null;
  sector_ps_median: number | null;
  peer_ps_median: number | null;
  peer_basis: string | null; // 'industry' | 'sector'
}

export interface ScoredRow extends ScreenFacts {
  rank: number;
  score: number; // = final_z, the single ordering score
  adj_z: number;
  moat_z: number;
  earn_z: number;
  break_z: number;
  verdict_z: number; // graded bull/bear tilt (migration 066)
  bull_z: number;
  bear_z: number;
  capped: boolean;
  floored: boolean;
  quality_pct: number; // lens empirical percentile (0–100) over the universe
  value_pct: number;
  momentum_pct: number;
  base_score: number; // weighted blend of lens percentiles, ∈ [0,1]
  base_z: number; // probit(base_score)
  base_pct: number; // round(base_score·100) — the quant percentile
  final_pct: number; // round(Φ(final_z)·100) — the displayed Score
  firing_breaks: number; // break signals currently firing against the row's facts
}

// Momentum collar (brief): a falling knife floors, a blow-off top caps — applied
// to the raw lens value before standardizing. Momentum is alpha vs SPY.
const MOM_FLOOR = -50;
const MOM_CAP = 40;

// Value lens blend (migration 058) — cheapness vs the name's own 12-mo median
// AND vs its peer-group median P/S. Equal-weight; pure self-relative fallback
// when no peer median. MUST match screen.py.
const VAL_W_SELF = 0.5;
const VAL_W_PEER = 0.5;

// Financial-sector lens neutralisation. P/S is a category error for banks/
// insurers/REITs (their "sales" are gross interest/trading/rental flows, so P/S
// reads near-zero ⇒ a spurious "−99% cheap" Value boost), and R40 is distorted
// by volatile financial revenue. For these sectors we neutralise BOTH the
// Quality and Value lenses (→ null ⇒ scored at the median, 0σ), leaving Momentum
// as the only active lens — so financials stay rankable/buyable but stop
// manufacturing spurious #1s. The set spans BOTH sector taxonomies present in
// the data ("Finance" and "Financial Services") plus "Real Estate". MUST match
// screen.py _FINANCIAL_SECTORS.
const FINANCIAL_SECTORS = new Set(["finance", "financial services", "real estate"]);

export function isFinancialSector(sector: string | null | undefined): boolean {
  return FINANCIAL_SECTORS.has((sector ?? "").trim().toLowerCase());
}

// Single-score constants (migration 057) — MUST match screen.py.
const W_MOAT = 0.58;
const W_EARN = 0.42;
// (break-count penalty removed from the screen score — see adjZ)
const FLOOR = -1.5;
export const BUDGET = 0.7; // AI authority ceiling (σ) — fixed server constant
// Verdict tilt (migration 066): graded bull/bear feed the rank as a GENTLE
// additive term. MUST match screen.py.
export const VERDICT_BUDGET = 0.3; // bull/bear authority ceiling (σ) — ±0.3 bound
const W_BULL = 0.5;
const W_BEAR = 0.5;
const LENS_NAMES = ["quality", "value", "momentum"] as const;

// ---- normal CDF (Abramowitz–Stegun erf), shared with screen.py --------------
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return s * y;
}
export const Phi = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

// Inverse normal CDF Φ⁻¹(p) — Acklam's approximation. Maps a blended percentile
// back to σ-space so the AI adjustment adds consistently. Mirrors screen.py probit().
function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pl = 0.02425, ph = 1 - 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Empirical percentile of x within a pre-sorted universe (∈[0,1]); missing
 *  value or empty universe ⇒ 0.5. Mirrors screen.py _pct_rank (bisect_right/n). */
function pctRank(sortedVals: number[], x: number | null): number {
  if (x == null || sortedVals.length === 0) return 0.5;
  let lo = 0, hi = sortedVals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedVals[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo / sortedVals.length;
}

// ---- raw lens values — must match screen.py _lens_values --------------------
function lensValues(r: ScreenFacts): {
  xQ: number | null;
  xV: number | null;
  xM: number | null;
} {
  const fcf = num(r.fcf_margin);
  const gm = num(r.gross_margin);
  // Growth-capped Rule-of-40 (cap the YoY-growth component at +100%) so
  // micro-revenue artifacts don't poison the Quality lens. Falls back to the
  // stored R40 when rev_growth/net_margin aren't both present. Matches screen.py.
  const revG = num(r.rev_growth_ttm);
  const netM = num(r.net_margin);
  const r40 = revG != null && netM != null ? Math.min(revG, 100) + netM : num(r.rule_of_40);
  let xQ: number | null;
  if (r40 == null && fcf == null && gm == null) xQ = null;
  else xQ = 0.6 * (r40 ?? 0) + 0.25 * (fcf ?? 0) + 0.15 * (gm ?? 0);

  const ps = num(r.ps);
  const med = num(r.ps_median_12m);
  const peer = num(r.peer_ps_median);
  const selfDenom = med && med > 0 ? med : ps;
  let xV: number | null;
  if (ps == null || !selfDenom) {
    xV = null;
  } else {
    const selfRatio = ps / selfDenom;
    if (peer && peer > 0) {
      xV = -(VAL_W_SELF * selfRatio + VAL_W_PEER * (ps / peer));
    } else {
      xV = -selfRatio;
    }
  }

  const perf = num(r.perf_52w_vs_spy);
  const xM = perf == null ? null : Math.max(MOM_FLOOR, Math.min(MOM_CAP, perf));

  // Financials: P/S and R40 are category errors — neutralise Quality + Value
  // (rank on Momentum only). MUST match screen.py.
  if (isFinancialSector(r.sector)) {
    return { xQ: null, xV: null, xM };
  }
  return { xQ, xV, xM };
}

interface Adj {
  adj_z: number;
  moat_z: number;
  earn_z: number;
  break_z: number;
  capped: boolean;
  floored: boolean;
}
function adjZ(r: ScreenFacts, budget = BUDGET): Adj {
  const moat = num(r.moat_score);
  const earn = num(r.earnings_score);
  const hasCard = r.has_card && moat != null && earn != null;
  if (!hasCard)
    return { adj_z: 0, moat_z: 0, earn_z: 0, break_z: 0, capped: false, floored: false };
  const uMoat = (moat! - 3) / 2;
  const uEarn = (earn! - 3) / 2;
  const moat_z = budget * W_MOAT * uMoat;
  const earn_z = budget * W_EARN * uEarn;
  // Break signals are forward-looking watch-conditions (e.g. "fcf_margin < 5%"),
  // not faults that are currently true — and every card ships a base set of 3+.
  // Counting them sank EVERY researched name below the unresearched ones, so the
  // screen score no longer penalizes them. They stay visible on the card + the
  // badge flag pip, and still drive the buyer/reviewer.
  const break_z = 0;
  const smoothUnit = W_MOAT * uMoat + W_EARN * uEarn; // natural max 1.0 ⇒ +budget
  let adj = moat_z + earn_z;
  const floored = adj < FLOOR;
  if (floored) adj = FLOOR;
  const capped = smoothUnit >= 0.999 && budget > 0;
  return { adj_z: adj, moat_z, earn_z, break_z, capped, floored };
}

interface Verdict {
  verdict_z: number;
  bull_z: number;
  bear_z: number;
}
// Graded bull/bear tilt (migration 066). Neutral (0) unless BOTH scores present —
// same "no penalty for unevaluated" rule as the card. Bull pushes up, bear
// (red-flag severity) pushes down; structural bound ±budget. MUST match screen.py.
function verdictZ(r: ScreenFacts, budget = VERDICT_BUDGET): Verdict {
  const bull = num(r.bull_score);
  const bear = num(r.bear_score);
  if (bull == null || bear == null)
    return { verdict_z: 0, bull_z: 0, bear_z: 0 };
  const uBull = (bull - 3) / 2; // ∈ [-1, 1]
  const uBear = (bear - 3) / 2;
  const bull_z = budget * W_BULL * uBull;
  const bear_z = budget * W_BEAR * uBear;
  return { verdict_z: bull_z - bear_z, bull_z, bear_z };
}

// ---- break-signal firing (display) ----------------------------------------
// A research card's break_signals are forward-looking watch-conditions; the
// screener flags a name red only when one is CURRENTLY firing against its own
// facts. Mirrors screen.py firing_break_count + theses._evaluate_signal. Maps the
// signal vocabulary (_ALLOWED_SIGNAL_FIELDS) onto ScreenFacts columns.
const SIGNAL_FIELD_MAP: Record<string, keyof ScreenFacts> = {
  gross_margin_pct: "gross_margin",
  operating_margin_pct: "operating_margin",
  net_margin_pct: "net_margin",
  fcf_margin_pct: "fcf_margin",
  rev_growth_ttm_pct: "rev_growth_ttm",
  rule_of_40: "rule_of_40",
  r40_score: "rule_of_40",
  ps_now: "ps",
  perf_52w_vs_spy: "perf_52w_vs_spy",
  price: "price",
};
const STATIC_OPS: Record<string, (c: number, t: number) => boolean> = {
  ">": (c, t) => c > t,
  ">=": (c, t) => c >= t,
  "<": (c, t) => c < t,
  "<=": (c, t) => c <= t,
  "==": (c, t) => c === t,
  "!=": (c, t) => c !== t,
};

/** True iff this break signal's condition is currently true against the facts.
 *  Unmapped fields, missing/non-numeric values, and change_pct_* ops (no
 *  snapshot in the screener) → false (conservative; matches theses). */
export function signalFires(facts: ScreenFacts, signal: CardBreak): boolean {
  const col = signal.field ? SIGNAL_FIELD_MAP[signal.field] : undefined;
  const op = signal.op;
  if (!col || !op || !(op in STATIC_OPS)) return false;
  const cur = num((facts as unknown as Record<string, unknown>)[col]);
  const thr = num(signal.value);
  if (cur == null || thr == null) return false;
  return STATIC_OPS[op](cur, thr);
}

/** How many of the card's break signals are firing right now against the row. */
export function firingBreakCount(facts: ScreenFacts, card: ResearchCard | null): number {
  const signals = card?.break_signals;
  if (!Array.isArray(signals)) return 0;
  return signals.reduce((n, s) => n + (signalFires(facts, s) ? 1 : 0), 0);
}

function matchesFilter(row: ScreenFacts, f: Filter): boolean {
  const raw = (row as unknown as Record<string, unknown>)[f.field === "ps" ? "ps" : f.field];
  if (TEXT_FIELDS.has(f.field)) {
    const a = (raw == null ? "" : String(raw)).toLowerCase();
    const b = String(f.value).toLowerCase();
    if (b === "") return true; // unset text filter = no constraint (e.g. sector not yet picked)
    if (f.op === "==") return a === b;
    if (f.op === "!=") return a !== b;
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

export interface ScreenResult {
  rows: ScoredRow[];
  match_count: number;
  total_universe: number;
  cut_index: number; // rows[0..cut_index) are the buyer's candidates (top N)
}

/**
 * Rank the universe for a config. `total` is the full Tier 1 count (pre-filter)
 * for the `total_universe` field; defaults to facts.length. The quant base ranks
 * each lens by its EMPIRICAL PERCENTILE over the loaded universe (outlier-robust),
 * blends them, then probit-maps to σ. Identical to screen.py over the same
 * universe, so parity holds.
 */
export function scoreScreen(
  facts: ScreenFacts[],
  config: ScreenConfig,
  total?: number,
): ScreenResult {
  // Lens distributions over the FULL universe (pre-filter) — a name's percentile
  // is its standing in the whole set, deterministic across TS/Python.
  const uq: number[] = [];
  const uv: number[] = [];
  const um: number[] = [];
  for (const r of facts) {
    const { xQ, xV, xM } = lensValues(r);
    if (xQ != null) uq.push(xQ);
    if (xV != null) uv.push(xV);
    if (xM != null) um.push(xM);
  }
  uq.sort((p, q) => p - q);
  uv.sort((p, q) => p - q);
  um.sort((p, q) => p - q);

  const subset = applyFilters(facts, config.filters);
  const { quality: wq, value: wv, momentum: wm } = config.weights;
  const wsum = wq + wv + wm || 1;

  const scored: ScoredRow[] = subset.map((r) => {
    const { xQ, xV, xM } = lensValues(r);
    const pq = pctRank(uq, xQ);
    const pv = pctRank(uv, xV);
    const pm = pctRank(um, xM);
    const base_score = (wq * pq + wv * pv + wm * pm) / wsum; // ∈ [0,1]
    const base_z = probit(Math.min(Math.max(base_score, 0.001), 0.999));
    const a = adjZ(r);
    const vz = verdictZ(r);
    const final_z = base_z + a.adj_z + vz.verdict_z;
    return {
      ...r,
      rank: 0,
      score: final_z,
      base_score,
      base_z,
      adj_z: a.adj_z,
      moat_z: a.moat_z,
      earn_z: a.earn_z,
      break_z: a.break_z,
      verdict_z: vz.verdict_z,
      bull_z: vz.bull_z,
      bear_z: vz.bear_z,
      capped: a.capped,
      floored: a.floored,
      quality_pct: Math.round(pq * 100),
      value_pct: Math.round(pv * 100),
      momentum_pct: Math.round(pm * 100),
      base_pct: Math.round(base_score * 100),
      final_pct: Math.round(Phi(final_z) * 100),
      firing_breaks: firingBreakCount(r, r.research_card),
    };
  });

  // Sort: by the configured column (default score = final_z), then ticker.
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

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
