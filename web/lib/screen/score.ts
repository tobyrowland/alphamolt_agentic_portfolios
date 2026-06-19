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
  ret_52w: number | null;
  /** 52-week return minus SPY's; derived in the loader, not a raw fact column. */
  perf_52w_vs_spy: number | null;
  // AI verdict overlay (lens; Level 0 itself is strategy-neutral)
  bull: boolean | null;
  bear: boolean | null;
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
  base_z: number;
  adj_z: number;
  moat_z: number;
  earn_z: number;
  break_z: number;
  capped: boolean;
  floored: boolean;
  quality_z: number;
  value_z: number;
  momentum_z: number;
  base_pct: number; // round(Φ(base_z)·100)
  final_pct: number; // round(Φ(final_z)·100) — the displayed Score
}

export interface LensStat {
  mu: number;
  sigma: number;
  n: number;
}
export type LensStats = Record<"quality" | "value" | "momentum", LensStat>;

// Momentum collar (brief): a falling knife floors, a blow-off top caps — applied
// to the raw lens value before standardizing. Momentum is alpha vs SPY.
const MOM_FLOOR = -50;
const MOM_CAP = 40;

// Single-score constants (migration 057) — MUST match screen.py.
const W_MOAT = 0.58;
const W_EARN = 0.42;
// (break-count penalty removed from the screen score — see adjZ)
const FLOOR = -1.5;
export const BUDGET = 0.7; // AI authority ceiling (σ) — fixed server constant
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

// ---- raw lens values (brief §2) — must match screen.py _lens_values ---------
function lensValues(r: ScreenFacts): {
  xQ: number | null;
  xV: number | null;
  xM: number | null;
} {
  const r40 = num(r.rule_of_40);
  const fcf = num(r.fcf_margin);
  const gm = num(r.gross_margin);
  let xQ: number | null;
  if (r40 == null && fcf == null && gm == null) xQ = null;
  else xQ = 0.6 * (r40 ?? 0) + 0.25 * (fcf ?? 0) + 0.15 * (gm ?? 0);

  const ps = num(r.ps);
  const med = num(r.ps_median_12m);
  const denom = med && med > 0 ? med : ps;
  const xV = ps != null && denom ? -(ps / denom) : null;

  const perf = num(r.perf_52w_vs_spy);
  const xM = perf == null ? null : Math.max(MOM_FLOOR, Math.min(MOM_CAP, perf));
  return { xQ, xV, xM };
}

function statsFromValues(vals: number[]): LensStat {
  const n = vals.length;
  if (n === 0) return { mu: 0, sigma: 1, n: 0 };
  const mu = vals.reduce((a, b) => a + b, 0) / n;
  const variance = vals.reduce((a, v) => a + (v - mu) * (v - mu), 0) / n;
  let sigma = Math.sqrt(variance);
  if (!(sigma > 0)) sigma = 1; // no spread (or NaN) → neutral scale
  return { mu, sigma, n };
}

/** Per-lens μ/σ over the (pre-filter) facts — the in-memory fallback before the
 *  stats table is materialized. Identical derivation to screen.py so parity holds. */
export function lensStatsFromFacts(facts: ScreenFacts[]): LensStats {
  const cols: Record<string, number[]> = { quality: [], value: [], momentum: [] };
  for (const r of facts) {
    const { xQ, xV, xM } = lensValues(r);
    if (xQ != null) cols.quality.push(xQ);
    if (xV != null) cols.value.push(xV);
    if (xM != null) cols.momentum.push(xM);
  }
  return {
    quality: statsFromValues(cols.quality),
    value: statsFromValues(cols.value),
    momentum: statsFromValues(cols.momentum),
  } as LensStats;
}

function z(x: number | null, st: LensStat | undefined): number {
  if (x == null || !st) return 0;
  const sigma = st.sigma || 1;
  return Math.max(-3, Math.min(3, (x - st.mu) / sigma));
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
 * for the `total_universe` field; defaults to facts.length. `stats` are the
 * materialized lens μ/σ (screen_lens_stats); when omitted they're derived from
 * the full `facts` set — identically to screen.py, so parity holds.
 */
export function scoreScreen(
  facts: ScreenFacts[],
  config: ScreenConfig,
  total?: number,
  stats?: LensStats,
): ScreenResult {
  const st = stats ?? lensStatsFromFacts(facts);
  const subset = applyFilters(facts, config.filters);

  const { quality: wq, value: wv, momentum: wm } = config.weights;
  const wsum = wq + wv + wm || 1;

  const scored: ScoredRow[] = subset.map((r) => {
    const { xQ, xV, xM } = lensValues(r);
    const zq = z(xQ, st.quality);
    const zv = z(xV, st.value);
    const zm = z(xM, st.momentum);
    const base_z = (wq * zq + wv * zv + wm * zm) / wsum;
    const a = adjZ(r);
    const final_z = base_z + a.adj_z;
    return {
      ...r,
      rank: 0,
      score: final_z,
      base_z,
      adj_z: a.adj_z,
      moat_z: a.moat_z,
      earn_z: a.earn_z,
      break_z: a.break_z,
      capped: a.capped,
      floored: a.floored,
      quality_z: zq,
      value_z: zv,
      momentum_z: zm,
      base_pct: Math.round(Phi(base_z) * 100),
      final_pct: Math.round(Phi(final_z) * 100),
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
