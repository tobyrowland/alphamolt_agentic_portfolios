/**
 * Query layer for the `investment_theses` table.
 *
 * One row per BUY (see `migrations/020_investment_theses.sql`). The Python
 * `PortfolioManager.buy()` / `buy_atomic()` records a snapshot row for every
 * trade — agents that pass a `thesis={...}` kwarg also store text + signals
 * (`source='agent'`); others are snapshot-only (`source='auto'`).
 *
 * For the agent-profile holdings dropdown we only need the *currently active*
 * thesis per (agent, ticker), so this module batches one query per agent.
 */

import { getSupabase } from "@/lib/supabase";

export interface ThesisSignal {
  field: string;
  op: string;
  value: number | string;
  description?: string;
}

export interface InvestmentThesis {
  id: number;
  agent_id: string;
  ticker: string;
  trade_id: number | null;
  snapshot: Record<string, unknown>;
  thesis_text: string | null;
  extend_signals: ThesisSignal[] | null;
  break_signals: ThesisSignal[] | null;
  source: "auto" | "agent";
  status: "active" | "broken" | "improved" | "superseded" | "closed";
  opened_at: string;
  status_changed_at: string;
  closed_at: string | null;
}

/**
 * Fetch the currently-active thesis for every (agent_id, ticker) the agent
 * still holds. Returns a map keyed by ticker. Tickers without an active
 * thesis are simply absent from the map (typical for positions opened before
 * migration 020 landed).
 */
export async function getActiveThesesForAgent(
  agentId: string,
): Promise<Record<string, InvestmentThesis>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("investment_theses")
    .select("*")
    .eq("agent_id", agentId)
    .eq("status", "active")
    .order("opened_at", { ascending: false });

  if (error) {
    // Don't blow up the profile page — log + return empty so the holdings
    // list still renders, just without thesis chips.
    console.error("getActiveThesesForAgent failed:", error);
    return {};
  }

  // Multiple `active` rows for the same ticker shouldn't happen (the Python
  // record_thesis helper supersedes prior actives), but defend anyway:
  // keep the most recent.
  const byTicker: Record<string, InvestmentThesis> = {};
  for (const row of (data ?? []) as InvestmentThesis[]) {
    if (!byTicker[row.ticker]) {
      byTicker[row.ticker] = row;
    }
  }
  return byTicker;
}

/**
 * Same as `getActiveThesesForAgent` but keyed on `portfolio_id` — for
 * human-owned portfolios where there isn't a single owner agent. Every
 * member agent's theses land on the shared book, so we want the union
 * (one active per ticker, latest wins) for the portfolio's detail page.
 */
export async function getActiveThesesForPortfolio(
  portfolioId: string,
): Promise<Record<string, InvestmentThesis>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("investment_theses")
    .select("*")
    .eq("portfolio_id", portfolioId)
    .eq("status", "active")
    .order("opened_at", { ascending: false });

  if (error) {
    console.error("getActiveThesesForPortfolio failed:", error);
    return {};
  }

  const byTicker: Record<string, InvestmentThesis> = {};
  for (const row of (data ?? []) as InvestmentThesis[]) {
    if (!byTicker[row.ticker]) {
      byTicker[row.ticker] = row;
    }
  }
  return byTicker;
}

// ---------------------------------------------------------------------------
// Current signal facts — "where does the name sit vs its trip-wires today?"
// ---------------------------------------------------------------------------

/** Signal-vocabulary field → screen_facts_mv column. The same mapping the
 *  scorers use for firing-break counts (score.ts SIGNAL_FIELD_MAP /
 *  screen.py _SIGNAL_FIELD_MAP). perf_52w_vs_spy is deliberately absent:
 *  legacy theses store it as a ratio while the matview carries ret_52w in %,
 *  so a gauge would compare mismatched units. */
const SIGNAL_FACT_COLUMNS: Record<string, string> = {
  gross_margin_pct: "gross_margin",
  operating_margin_pct: "operating_margin",
  net_margin_pct: "net_margin",
  fcf_margin_pct: "fcf_margin",
  rev_growth_ttm_pct: "rev_growth_ttm",
  rule_of_40: "rule_of_40",
  r40_score: "rule_of_40",
  ps_now: "ps",
  price: "price",
};

/** Per-ticker current values keyed by SIGNAL field names (not column names),
 *  so the thesis panel can look a signal's live value up directly. Reads the
 *  screener matview (public-read; the same freshness the screener shows).
 *  Fail-open: an error returns {} and the panel renders without gauges. */
export async function getCurrentSignalFacts(
  tickers: string[],
): Promise<Record<string, Record<string, number>>> {
  if (tickers.length === 0) return {};
  const supabase = getSupabase();
  const columns = Array.from(new Set(Object.values(SIGNAL_FACT_COLUMNS)));
  const { data, error } = await supabase
    .from("screen_facts_mv")
    .select(`ticker, ${columns.join(", ")}`)
    .in("ticker", tickers);

  if (error) {
    console.error("getCurrentSignalFacts failed:", error);
    return {};
  }

  const out: Record<string, Record<string, number>> = {};
  for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
    const ticker = String(row.ticker ?? "");
    if (!ticker) continue;
    const vals: Record<string, number> = {};
    for (const [signalField, column] of Object.entries(SIGNAL_FACT_COLUMNS)) {
      const n = Number(row[column]);
      if (row[column] != null && Number.isFinite(n)) vals[signalField] = n;
    }
    out[ticker] = vals;
  }
  return out;
}
