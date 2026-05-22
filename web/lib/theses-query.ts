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
