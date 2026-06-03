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

export const loadCompany = cache(async (ticker: string): Promise<Company | null> => {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("companies")
    .select("*")
    .eq("ticker", ticker)
    .maybeSingle();
  return (data as Company | null) ?? null;
});

export const loadPriceSales = cache(
  async (ticker: string): Promise<PriceSales | null> => {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("price_sales")
      .select("*")
      .eq("ticker", ticker)
      .maybeSingle();
    return (data as PriceSales | null) ?? null;
  },
);

export const loadMetricStats = cache(
  async (): Promise<MetricStatsBundle> => getMetricStats(),
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
