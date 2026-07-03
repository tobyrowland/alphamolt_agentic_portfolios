import { bestRationale } from "@/lib/screen/score";
import type { ScreenResponse } from "@/lib/screen/query";

/**
 * SSR projection of a screen result into the shape ScreenerClient takes as
 * `initialData` — the display columns only, with the heavy research_card
 * reduced to its compiled one-line thesis (the full card is lazy-loaded on
 * row-expand via /api/screen/card). Shared by the public /screener page and
 * the per-portfolio embedded screener so the two paints can't drift.
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
      price: r.price,
      price_asof: r.price_asof,
      score: r.score,
      ps: r.ps,
      ps_median_12m: r.ps_median_12m,
      ps_trend_pct: r.ps_trend_pct,
      rev_growth_ttm: r.rev_growth_ttm,
      gross_margin: r.gross_margin,
      fcf_margin: r.fcf_margin,
      net_margin: r.net_margin,
      operating_margin: r.operating_margin,
      rule_of_40: r.rule_of_40,
      ret_52w: r.ret_52w,
      perf_52w_vs_spy: r.perf_52w_vs_spy,
      bull: r.bull,
      bear: r.bear,
      bull_score: r.bull_score,
      bear_score: r.bear_score,
      // Single-score + research-card fields (migration 057).
      base_z: r.base_z,
      adj_z: r.adj_z,
      moat_z: r.moat_z,
      earn_z: r.earn_z,
      break_z: r.break_z,
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
      industry_ps_median: r.industry_ps_median,
      sector_ps_median: r.sector_ps_median,
      peer_ps_median: r.peer_ps_median,
      peer_basis: r.peer_basis,
    })),
    match_count: initial.match_count,
    total_universe: initial.total_universe,
    data_asof: initial.data_asof,
  };
}
