/**
 * Read-side queries for portfolios (migration 021).
 *
 * Today every portfolio has exactly one member (the owner agent) by
 * virtue of the 1:1 backfill. Multi-agent portfolios are supported by
 * the schema; the API surface for adding additional members is a
 * follow-up PR.
 *
 * The corresponding writers live in `web/lib/portfolio.ts`
 * (`openAccount` + `ensurePortfolioForAgent`) and `web/lib/theses.ts`.
 */

import { getSupabase } from "@/lib/supabase";
import type { Trade } from "@/components/trade-tape";

export interface Portfolio {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  /** Null for human-owned portfolios (migration 024). */
  owner_agent_id: string | null;
  /** Null for legacy agent-owned portfolios (migration 024). */
  owner_user_id: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

/** Count of distinct equities a portfolio currently holds. Drives the
 *  Public/Private hysteresis gate (migration 031): a portfolio needs ≥ 15
 *  to flip public and auto-reverts to private below 10. */
export async function getHoldingsCountForPortfolio(
  portfolioId: string,
): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("portfolio_holdings")
    .select("ticker", { count: "exact", head: true })
    .eq("portfolio_id", portfolioId);
  if (error) {
    console.error("getHoldingsCountForPortfolio failed:", error);
    return 0;
  }
  return count ?? 0;
}

export interface PortfolioMember {
  agent_id: string;
  handle: string;
  display_name: string;
  description: string | null;
  is_house_agent: boolean;
  powered_by: string | null;
  /** Strategy key — drives the agent's role (see `agent-roles.ts`). */
  strategy: string | null;
  notes: string | null;
  joined_at: string;
}

export interface PortfolioMembershipForAgent {
  portfolio: Portfolio;
  notes: string | null;
  joined_at: string;
  current_total_value_usd: number | null;
  current_pnl_pct: number | null;
}

export async function getPortfolioBySlug(slug: string): Promise<Portfolio | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    console.error("getPortfolioBySlug failed:", error);
    return null;
  }
  return (data as Portfolio | null) ?? null;
}

/** The single portfolio owned by a human user (migration 024), or null. */
export async function getPortfolioForUser(
  userId: string,
): Promise<Portfolio | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .select("*")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("getPortfolioForUser failed:", error);
    return null;
  }
  return (data as Portfolio | null) ?? null;
}

export async function getPortfolioById(id: string): Promise<Portfolio | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("getPortfolioById failed:", error);
    return null;
  }
  return (data as Portfolio | null) ?? null;
}

/**
 * Return every portfolio this agent is a member of (owned or otherwise),
 * enriched with the portfolio's latest MTM value + P/L %. Used by the
 * agent profile page's "Portfolios" section.
 */
export async function getPortfoliosForAgent(
  agentId: string,
): Promise<PortfolioMembershipForAgent[]> {
  const supabase = getSupabase();
  const { data: memberships, error } = await supabase
    .from("portfolio_agents")
    .select("portfolio_id, notes, joined_at")
    .eq("agent_id", agentId)
    .order("joined_at", { ascending: true });
  if (error) {
    console.error("getPortfoliosForAgent memberships failed:", error);
    return [];
  }
  const rows = memberships ?? [];
  if (rows.length === 0) return [];

  // Resolve portfolio rows. Filter out private portfolios (migration 024) so
  // a human's private portfolio doesn't leak via a member agent's profile.
  const ids = rows.map((r) => (r as { portfolio_id: string }).portfolio_id);
  const { data: portfolios } = await supabase
    .from("portfolios")
    .select("*")
    .in("id", ids)
    .eq("is_public", true);
  const byId = new Map<string, Portfolio>(
    ((portfolios as Portfolio[] | null) ?? []).map((p) => [p.id, p]),
  );

  // Latest MTM per portfolio from agent_leaderboard (one row per portfolio).
  const { data: leaderboard } = await supabase
    .from("agent_leaderboard")
    .select("portfolio_id, total_value_usd, pnl_pct")
    .in("portfolio_id", ids);
  const mtmById = new Map<
    string,
    { total_value_usd: number | null; pnl_pct: number | null }
  >(
    (
      (leaderboard as
        | { portfolio_id: string; total_value_usd: number; pnl_pct: number }[]
        | null) ?? []
    ).map((r) => [
      r.portfolio_id,
      { total_value_usd: r.total_value_usd, pnl_pct: r.pnl_pct },
    ]),
  );

  const out: PortfolioMembershipForAgent[] = [];
  for (const m of rows) {
    const r = m as { portfolio_id: string; notes: string | null; joined_at: string };
    const portfolio = byId.get(r.portfolio_id);
    if (!portfolio) continue;
    const mtm = mtmById.get(r.portfolio_id);
    out.push({
      portfolio,
      notes: r.notes,
      joined_at: r.joined_at,
      current_total_value_usd: mtm?.total_value_usd ?? null,
      current_pnl_pct: mtm?.pnl_pct ?? null,
    });
  }
  return out;
}

export async function getMembersForPortfolio(
  portfolioId: string,
): Promise<PortfolioMember[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolio_agents")
    .select(
      "agent_id, notes, joined_at, agents (handle, display_name, description, is_house_agent, powered_by, strategy)",
    )
    .eq("portfolio_id", portfolioId)
    .order("joined_at", { ascending: true });
  if (error) {
    console.error("getMembersForPortfolio failed:", error);
    return [];
  }
  // Supabase PostgREST sometimes infers embedded one-to-one joins as
  // arrays of length 1. Normalise via `unknown` then pluck the first
  // (and only) element if the value is an array.
  type EmbeddedAgent = {
    handle: string;
    display_name: string;
    description: string | null;
    is_house_agent: boolean;
    powered_by: string | null;
    strategy: string | null;
  };
  type Row = {
    agent_id: string;
    notes: string | null;
    joined_at: string;
    agents: EmbeddedAgent | EmbeddedAgent[] | null;
  };
  const rows = (data as unknown as Row[] | null) ?? [];
  return rows
    .map((r) => {
      const a = Array.isArray(r.agents) ? r.agents[0] : r.agents;
      if (!a) return null;
      return {
        agent_id: r.agent_id,
        handle: a.handle,
        display_name: a.display_name,
        description: a.description,
        is_house_agent: a.is_house_agent,
        powered_by: a.powered_by,
        strategy: a.strategy,
        notes: r.notes,
        joined_at: r.joined_at,
      };
    })
    .filter((m): m is PortfolioMember => m !== null);
}

/**
 * Reverse-chronological trade journal for a portfolio. Mirrors
 * `getCompanyTradeTape` but filters `agent_trades` by `portfolio_id`
 * (populated by migrations 021/022) rather than by ticker. Joined to
 * `agents` so each row can attribute and link to the executing agent.
 * Also returns a total count so the "showing N of M" line is accurate.
 */
export async function getRecentTradesForPortfolio(
  portfolioId: string,
  limit = 25,
): Promise<{ trades: Trade[]; totalTrades: number }> {
  const supabase = getSupabase();
  // Page-and-count in parallel — these two queries don't depend on each
  // other, but were running sequentially (the count waited on the page).
  const [pageResp, countResp] = await Promise.all([
    supabase
      .from("agent_trades")
      .select(
        "id, ticker, side, quantity, price_usd, executed_at, note, " +
          "agents!inner(handle, display_name)",
      )
      .eq("portfolio_id", portfolioId)
      .order("executed_at", { ascending: false })
      .limit(limit),
    supabase
      .from("agent_trades")
      .select("id", { count: "exact", head: true })
      .eq("portfolio_id", portfolioId),
  ]);
  const { data, error } = pageResp;
  const { count } = countResp;
  if (error) {
    console.error("getRecentTradesForPortfolio failed:", error);
    return { trades: [], totalTrades: 0 };
  }

  type EmbeddedAgent = { handle: string; display_name: string };
  type Row = {
    id: string;
    ticker: string;
    side: string;
    quantity: number | string;
    price_usd: number | string;
    executed_at: string;
    note: string | null;
    agents: EmbeddedAgent | EmbeddedAgent[] | null;
  };
  const trades: Trade[] = ((data as unknown as Row[] | null) ?? [])
    .map((r) => {
      const a = Array.isArray(r.agents) ? r.agents[0] : r.agents;
      if (!a) return null;
      return {
        id: r.id,
        handle: a.handle,
        display_name: a.display_name,
        ticker: r.ticker,
        side: r.side === "sell" ? "sell" : "buy",
        quantity: Number(r.quantity),
        price_usd: Number(r.price_usd),
        executed_at: r.executed_at,
        note: r.note,
      } satisfies Trade;
    })
    .filter((t): t is Trade => t !== null);

  return { trades, totalTrades: count ?? trades.length };
}
