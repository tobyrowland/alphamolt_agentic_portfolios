export interface Company {
  // Identity
  ticker: string;
  exchange: string;
  company_name: string;
  country: string;
  sector: string;
  description: string;

  // Screening
  status: string;
  composite_score: number | null;
  price: number | null;
  ps_now: number | null;
  price_pct_of_52w_high: number | null;
  perf_52w_vs_spy: number | null;
  rating: number | null;
  sort_order: number | null;

  // Overview
  r40_score: string;
  fundamentals_snapshot: string;
  short_outlook: string;

  // Revenue
  annual_revenue_5y: string;
  quarterly_revenue: string;
  rev_growth_ttm_pct: number | null;
  rev_growth_qoq_pct: number | null;
  rev_cagr_pct: number | null;
  rev_consistency_score: string;

  // Margins
  gross_margin_pct: number | null;
  gm_trend: string;
  operating_margin_pct: number | null;
  net_margin_pct: number | null;
  net_margin_yoy_pct: number | null;
  fcf_margin_pct: number | null;

  // Efficiency
  opex_pct_revenue: number | null;
  sm_rd_pct_revenue: number | null;
  rule_of_40: number | null;
  qrtrs_to_profitability: string;

  // Earnings
  eps_only: number | null;
  eps_yoy_pct: number | null;

  // Data quality
  one_time_events: string;
  event_impact: string;

  // AI narrative
  full_outlook: string;
  key_risks: string;

  // Evaluations (added post-migration, not in schema SQL)
  bear_eval: string | null;
  bear_eval_at: string | null;
  bull_eval: string | null;
  bull_eval_at: string | null;

  // Joined client-side from price_sales
  ps_median_12m: number | null;

  // Portfolio
  in_portfolio: boolean | null;
  portfolio_sort_order: number | null;

  // Metadata
  ai_analyzed_at: string | null;
  data_updated_at: string | null;
  scored_at: string | null;
  flags: Record<string, string> | null;
  in_tv_screen: boolean;
  created_at: string;
  updated_at: string;
}

export interface PriceSales {
  ticker: string;
  company_name: string;
  ps_now: number | null;
  high_52w: number | null;
  low_52w: number | null;
  median_12m: number | null;
  ath: number | null;
  pct_of_ath: number | null;
  history_json: Array<{ date: string; ps: number }>;
  last_updated: string | null;
  first_recorded: string | null;
}

// Columns to fetch for the screener table (lightweight)
export const SCREENER_COLUMNS = [
  "ticker",
  "exchange",
  "company_name",
  "sector",
  "country",
  "status",
  "composite_score",
  "price",
  "ps_now",
  "rev_growth_ttm_pct",
  "gross_margin_pct",
  "fcf_margin_pct",
  "rule_of_40",
  "rating",
  "sort_order",
  "bear_eval",
  "bull_eval",
  "perf_52w_vs_spy",
  "short_outlook",
].join(",");
