/**
 * Request-memoized data loaders for /company/{ticker}.
 *
 * Split so the page can stream: the *instant shell* (identity, price,
 * score, P/S chart, fundamentals strips) needs only the fast
 * `companies` + `price_sales` + `metric_stats` reads, while everything
 * that touches agent activity (behavioural status, lifecycle, held-by,
 * "what the agents did", the ledger) is loaded behind Suspense via
 * `loadAgentActivity` — the heavy 500-row trade fetch + holders + theses
 * + swarm. (brief §8.10 — SSR above-the-fold, lazy-load the ledger tail.)
 *
 * Each loader is wrapped in React `cache()` so it runs at most once per
 * request even though several streamed components (and generateMetadata)
 * call it independently — the multiple Suspense boundaries share a single
 * `loadAgentActivity` round-trip rather than each re-querying.
 */

import { cache } from "react";
import { getSupabase } from "@/lib/supabase";
import { getEquityL0 } from "@/lib/level0-query";
import type { Company, PriceSales } from "@/lib/types";
import {
  getCompanyHolders,
  getCompanyTradeTape,
  getCompanySwarmSnapshot,
  type CompanyHolder,
  type CompanyTrade,
  type CompanySwarmSnapshot,
} from "@/lib/company-agents-query";
import {
  getActiveThesesForTicker,
  getWatchlistCount,
  buildLifecycle,
  buildBehaviouralStatus,
  buildBoughtReasons,
  buildSoldReasons,
  buildSellTriggerLine,
  type ActiveThesis,
  type Lifecycle,
  type BehaviouralStatus,
  type ReasonGroup,
  type SellTriggerLine,
} from "@/lib/company-report-query";
import { getMetricStats, type MetricStatsBundle } from "@/lib/metric-stats-query";

/**
 * The AI narrative + bull/bear lens for one ticker, read from the Level 0
 * `ai_analysis` home (migration 053) — NOT the legacy `companies` columns.
 */
interface AiAnalysisRow {
  bull_eval: string | null;
  bear_eval: string | null;
  bull_at: string | null;
  bear_at: string | null;
  short_outlook: string | null;
  key_risks: string | null;
  full_outlook: string | null;
  event_impact: string | null;
  analyzed_at: string | null;
  updated_at: string | null;
}

/**
 * The company shell, reconstructed from the Level 0 fact store:
 *   - identity / price / fundamentals / valuation / bull-bear → `api_universe_facts`
 *     RPC (web/lib/level0-query.ts `getEquityL0`)
 *   - narrative + bull/bear text → `ai_analysis`
 *   - `updated_at` → `securities.updated_at`
 *
 * Opinionated TradingView-era columns with no Level 0 equivalent
 * (`composite_score`, `sort_order`, `rating`, `flags`, the
 * `annual_revenue_5y` / `quarterly_revenue` text blobs, `eps_yoy_pct`,
 * `gm_trend`, etc.) are surfaced as null so the page renders "—" / omits
 * them rather than inventing data. Returns null when the ticker isn't in
 * the Tier 1 universe.
 */
export const loadCompany = cache(async (ticker: string): Promise<Company | null> => {
  const supabase = getSupabase();
  const t = ticker.toUpperCase();

  const [equity, aiRes, secRes, finRes] = await Promise.all([
    getEquityL0(t),
    supabase
      .from("ai_analysis")
      .select(
        "bull_eval, bear_eval, bull_at, bear_at, short_outlook, key_risks, " +
          "full_outlook, event_impact, analyzed_at, updated_at",
      )
      .eq("ticker", t)
      .maybeSingle(),
    supabase
      .from("securities")
      .select("updated_at")
      .eq("ticker", t)
      .maybeSingle(),
    // Per-period revenue + net income text blobs (income chart). Stored on the
    // Level 0 `fundamentals` table (migration 067); read the latest period_end
    // row for this ticker.
    supabase
      .from("fundamentals")
      .select(
        "annual_revenue_5y, quarterly_revenue, annual_net_income_5y, quarterly_net_income",
      )
      .eq("ticker", t)
      .order("period_end", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!equity) return null;

  const ai = (aiRes.data as AiAnalysisRow | null) ?? null;
  const fin = (finRes.data as {
    annual_revenue_5y: string | null;
    quarterly_revenue: string | null;
    annual_net_income_5y: string | null;
    quarterly_net_income: string | null;
  } | null) ?? null;
  const securityUpdatedAt =
    (secRes.data as { updated_at: string | null } | null)?.updated_at ?? null;
  const updatedAt = securityUpdatedAt ?? ai?.updated_at ?? equity.price_asof;

  const company: Company = {
    // Identity
    ticker: equity.ticker,
    exchange: equity.exchange ?? "",
    company_name: equity.company_name ?? equity.ticker,
    country: equity.country ?? "",
    sector: equity.sector ?? "",
    description: "",

    // Screening — opinionated columns with no Level 0 equivalent stay null.
    status: equity.status ?? "",
    composite_score: null,
    price: equity.price,
    price_asof: equity.price_asof,
    ps_now: equity.ps_now,
    price_pct_of_52w_high: null,
    perf_52w_vs_spy: null,
    rating: null,
    sort_order: null,

    // Overview
    r40_score: "",
    fundamentals_snapshot: "",
    short_outlook: ai?.short_outlook ?? "",

    // Revenue + net income — per-period text blobs from Level 0 `fundamentals`
    // (migration 067); power the income-statement chart.
    annual_revenue_5y: fin?.annual_revenue_5y ?? "",
    quarterly_revenue: fin?.quarterly_revenue ?? "",
    annual_net_income_5y: fin?.annual_net_income_5y ?? "",
    quarterly_net_income: fin?.quarterly_net_income ?? "",
    rev_growth_ttm_pct: equity.rev_growth_ttm_pct,
    rev_growth_qoq_pct: equity.rev_growth_qoq_pct,
    rev_cagr_pct: equity.rev_cagr_pct,
    rev_consistency_score: "",

    // Margins
    gross_margin_pct: equity.gross_margin_pct,
    gm_trend: "",
    operating_margin_pct: equity.operating_margin_pct,
    net_margin_pct: equity.net_margin_pct,
    net_margin_yoy_pct: null,
    fcf_margin_pct: equity.fcf_margin_pct,

    // Efficiency
    opex_pct_revenue: null,
    sm_rd_pct_revenue: null,
    rule_of_40: equity.rule_of_40,
    qrtrs_to_profitability: "",

    // Earnings
    eps_only: equity.eps_only,
    eps_yoy_pct: null,

    // Data quality
    one_time_events: "",
    event_impact: ai?.event_impact ?? "",

    // AI narrative
    full_outlook: ai?.full_outlook ?? "",
    key_risks: ai?.key_risks ?? "",

    // Evaluations
    bear_eval: ai?.bear_eval ?? null,
    bear_eval_at: ai?.bear_at ?? null,
    bull_eval: ai?.bull_eval ?? null,
    bull_eval_at: ai?.bull_at ?? null,

    // Joined from valuation
    ps_median_12m: equity.ps_median_12m,

    // Portfolio
    in_portfolio: null,
    portfolio_sort_order: null,

    // Metadata
    ai_analyzed_at: ai?.analyzed_at ?? null,
    data_updated_at: equity.fundamentals_asof ?? null,
    scored_at: null,
    flags: null,
    in_tv_screen: equity.is_tier1,
    created_at: updatedAt ?? "",
    updated_at: updatedAt ?? "",
  };

  return company;
});

/**
 * P/S series + 52-week stats for one ticker, read from the Level 0
 * `valuation` table (latest row per ticker) rather than the legacy
 * `price_sales` table. Falls back to `price_sales` only when valuation has
 * no row yet (mirrors web/lib/screen/ps-history-query.ts).
 */
export const loadPriceSales = cache(
  async (ticker: string): Promise<PriceSales | null> => {
    const supabase = getSupabase();
    const t = ticker.toUpperCase();

    const { data: vrow } = await supabase
      .from("valuation")
      .select(
        "ticker, ps, ps_median_12m, ps_high_52w, ps_low_52w, ps_ath, " +
          "ps_pct_of_ath, history_json, fetched_at",
      )
      .eq("ticker", t)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const v = vrow as {
      ticker: string;
      ps: number | string | null;
      ps_median_12m: number | string | null;
      ps_high_52w: number | string | null;
      ps_low_52w: number | string | null;
      ps_ath: number | string | null;
      ps_pct_of_ath: number | string | null;
      history_json: PriceSales["history_json"] | null;
      fetched_at: string | null;
    } | null;

    if (v) {
      return {
        ticker: v.ticker,
        company_name: "",
        ps_now: numOrNull(v.ps),
        high_52w: numOrNull(v.ps_high_52w),
        low_52w: numOrNull(v.ps_low_52w),
        median_12m: numOrNull(v.ps_median_12m),
        ath: numOrNull(v.ps_ath),
        pct_of_ath: numOrNull(v.ps_pct_of_ath),
        history_json: Array.isArray(v.history_json) ? v.history_json : [],
        last_updated: v.fetched_at,
        first_recorded: null,
      };
    }

    // Fallback: legacy price_sales for names valuation hasn't reached yet.
    const { data } = await supabase
      .from("price_sales")
      .select("*")
      .eq("ticker", t)
      .maybeSingle();
    return (data as PriceSales | null) ?? null;
  },
);

function numOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const loadMetricStats = cache(
  async (): Promise<MetricStatsBundle> => getMetricStats(),
);

export interface PeerTicker {
  ticker: string;
  company_name: string;
  ps_now: number | null;
}

/**
 * Up to `limit` same-sector peer tickers for the related-links grid (P5).
 * Same sector, in the TV screen (so each has its own company page), nearest
 * to the subject by P/S. Excludes the subject itself.
 */
export const loadPeers = cache(
  async (
    ticker: string,
    sector: string | null,
    psNow: number | null,
    limit = 4,
  ): Promise<PeerTicker[]> => {
    if (!sector) return [];
    // Same-sector Tier 1 peers from Level 0 (`securities`), each of which has
    // its own /company page. P/S is filled in from the cached universe facts
    // (`getEquityL0`) rather than a per-row valuation join.
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("securities")
      .select("ticker, name")
      .eq("gics_sector", sector)
      .eq("is_tier1", true)
      .eq("status", "active")
      .neq("ticker", ticker)
      .not("name", "is", null)
      .limit(60);
    if (error) {
      console.error("loadPeers failed:", error.message);
      return [];
    }
    const peerRows = (data as { ticker: string; name: string | null }[] | null) ?? [];
    const rows: PeerTicker[] = await Promise.all(
      peerRows.map(async (r) => ({
        ticker: r.ticker,
        company_name: r.name ?? r.ticker,
        ps_now: (await getEquityL0(r.ticker))?.ps_now ?? null,
      })),
    );
    // Nearest by P/S when we have a reference; otherwise first N by name.
    if (psNow != null) {
      rows.sort((a, b) => {
        const da = a.ps_now == null ? Infinity : Math.abs(a.ps_now - psNow);
        const db = b.ps_now == null ? Infinity : Math.abs(b.ps_now - psNow);
        return da - db;
      });
    }
    return rows.slice(0, limit);
  },
);

export interface AgentActivity {
  holders: CompanyHolder[];
  trades: CompanyTrade[];
  theses: ActiveThesis[];
  swarm: CompanySwarmSnapshot;
  watchlisted: number;
  lifecycle: Lifecycle;
  behavioural: BehaviouralStatus;
  bought: ReasonGroup;
  sold: ReasonGroup;
  sellTriggers: SellTriggerLine;
  traded: boolean;
  totalAgents: number;
}

export const loadAgentActivity = cache(
  async (ticker: string): Promise<AgentActivity> => {
    const [holders, trades, theses, swarm, watchlisted, company] = await Promise.all([
      getCompanyHolders(ticker),
      // Wide window so the lifecycle / ledger derivations see every
      // agent's latest action, including agents that exited months ago.
      getCompanyTradeTape(ticker, 500),
      getActiveThesesForTicker(ticker),
      getCompanySwarmSnapshot(ticker),
      getWatchlistCount(ticker),
      loadCompany(ticker), // memoized — shares the shell's fetch
    ]);

    const lifecycle = buildLifecycle(holders, trades, watchlisted);
    const behavioural = buildBehaviouralStatus(trades, lifecycle, swarm.total_agents);
    const bought = buildBoughtReasons(trades, theses);
    const sold = buildSoldReasons(holders, trades);
    const sellTriggers = company
      ? buildSellTriggerLine(theses, company)
      : { triggers: [], trippedCount: 0 };

    return {
      holders,
      trades,
      theses,
      swarm,
      watchlisted,
      lifecycle,
      behavioural,
      bought,
      sold,
      sellTriggers,
      traded: trades.length > 0,
      totalAgents: swarm.total_agents,
    };
  },
);
