import { bestRationale } from "@/lib/screen/score";
import type { ScreenResponse } from "@/lib/screen/query";

/** Round to 4 decimals — z-scores and raw numerics otherwise serialize at full
 *  float64 precision (~17 digits each), which roughly doubles the bulk payload
 *  for no display or re-rank benefit (the client renders at 0–2 dp and the
 *  local re-rank tolerates 1e-4 noise). */
function r4(v: number | null): number | null {
  return v == null ? null : Math.round(v * 10000) / 10000;
}
/** Same rounding for the always-present score fields (keeps them `number`). */
function rz(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Projection of a screen result into the shape ScreenerClient takes as
 * `initialData` — the display columns only, with the heavy research_card
 * reduced to its compiled one-line thesis (the full card is lazy-loaded on
 * row-expand via /api/screen/card). Shared by the public /screener page, the
 * per-portfolio embedded screener AND the /api/screen live re-rank so the
 * three paints can't drift.
 */
export function projectDisplayRows(initial: ScreenResponse) {
  return {
    rows: initial.rows.map((r) => ({
      rank: r.rank,
      ticker: r.ticker,
      name: r.name,
      sector: r.sector,
      industry: r.industry,
      country: r.country,
      price: r4(r.price),
      score: rz(r.score),
      ps: r4(r.ps),
      ps_median_12m: r4(r.ps_median_12m),
      ps_trend_pct: r4(r.ps_trend_pct),
      rev_growth_ttm: r4(r.rev_growth_ttm),
      gross_margin: r4(r.gross_margin),
      fcf_margin: r4(r.fcf_margin),
      net_margin: r4(r.net_margin),
      operating_margin: r4(r.operating_margin),
      rule_of_40: r4(r.rule_of_40),
      ret_52w: r4(r.ret_52w),
      perf_52w_vs_spy: r4(r.perf_52w_vs_spy),
      // Turnaround facts (migration 074) — filterable, and the QoQ deltas are
      // the Inflection lens inputs (the client re-ranks locally on a weight
      // change, so the lens must be computable from these rows).
      drawdown_52w: r4(r.drawdown_52w),
      above_low_26w: r4(r.above_low_26w),
      ps_vs_median: r4(r.ps_vs_median),
      gm_delta_qoq: r4(r.gm_delta_qoq),
      gm_expansion_qtrs: r.gm_expansion_qtrs,
      rev_qoq_accel: r4(r.rev_qoq_accel),
      rev_accel_qtrs: r.rev_accel_qtrs,
      fcf_delta_qoq: r4(r.fcf_delta_qoq),
      fcf_improving_qtrs: r.fcf_improving_qtrs,
      inflection_signals: r.inflection_signals,
      net_debt_ebitda: r4(r.net_debt_ebitda),
      interest_coverage: r4(r.interest_coverage),
      bull_score: r.bull_score,
      bear_score: r.bear_score,
      // Single-score + research-card fields (migration 057).
      base_z: rz(r.base_z),
      adj_z: rz(r.adj_z),
      moat_z: rz(r.moat_z),
      earn_z: rz(r.earn_z),
      base_pct: r.base_pct,
      final_pct: r.final_pct,
      capped: r.capped,
      floored: r.floored,
      quality_score: r.quality_score,
      moat_score: r.moat_score,
      earnings_score: r.earnings_score,
      growth_score: r.growth_score,
      break_count: r.break_count,
      firing_breaks: r.firing_breaks,
      has_card: r.has_card,
      // Ship only the compiled one-line thesis; the heavy research_card
      // text is lazy-loaded on row-expand.
      thesis_line: bestRationale(r.research_card),
      industry_ps_median: r4(r.industry_ps_median),
      sector_ps_median: r4(r.sector_ps_median),
      peer_ps_median: r4(r.peer_ps_median),
      peer_basis: r.peer_basis,
    })),
    match_count: initial.match_count,
    total_universe: initial.total_universe,
    data_asof: initial.data_asof,
  };
}
