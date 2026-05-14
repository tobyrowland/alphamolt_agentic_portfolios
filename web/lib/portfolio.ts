/**
 * TypeScript port of PortfolioManager — used by the REST API and MCP server.
 *
 * Mirrors the Python `portfolio.py` module so interactive agent trades and
 * the nightly valuation job follow identical rules. Both flows converge on
 * the same Supabase tables (agent_accounts, agent_holdings, agent_trades,
 * agent_portfolio_history).
 *
 * v1 simplifications (matches the Python side):
 *   - All prices treated as USD even for non-US listings
 *   - No fees, slippage, shorting, margin, splits, or dividends
 *   - Single-writer per agent; no row-level locks (a future RPC should wrap
 *     cash debit + holding upsert in a single transaction)
 */

import { getSupabase } from "@/lib/supabase";
import {
  closeThesesForPosition,
  recordThesis,
  type ThesisInput,
} from "@/lib/theses";

export const DEFAULT_STARTING_CASH = 1_000_000;

export class PortfolioError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// ----- Types --------------------------------------------------------------

export interface AgentAccount {
  agent_id: string;
  starting_cash: number;
  cash_usd: number;
  inception_date: string;
}

export interface AgentHolding {
  agent_id: string;
  ticker: string;
  quantity: number;
  avg_cost_usd: number;
  first_bought_at: string;
}

export interface TradeResult {
  agent_id: string;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  price_usd: number;
  gross_usd: number;
  cash_after_usd: number;
  executed_at: string;
  note: string;
}

export interface HoldingWithMtm {
  ticker: string;
  company_name: string | null;
  quantity: number;
  avg_cost_usd: number;
  price_usd: number;
  market_value_usd: number;
  unrealized_pnl_usd: number;
}

export interface PortfolioSnapshot {
  agent_id: string;
  cash_usd: number;
  starting_cash: number;
  holdings: HoldingWithMtm[];
  holdings_value_usd: number;
  total_value_usd: number;
  pnl_usd: number;
  pnl_pct: number;
}

export interface LeaderboardRow {
  handle: string;
  display_name: string;
  is_house_agent: boolean;
  snapshot_date: string;
  cash_usd: number;
  holdings_value_usd: number;
  total_value_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  num_positions: number;
}

// ----- Internals ----------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

interface CompanyMeta {
  price: number | null;
  company_name: string | null;
}

/**
 * Bulk-fetch price + company_name for a set of tickers in a single SELECT.
 * Returns an empty map if `tickers` is empty. Tickers missing from `companies`
 * simply won't appear in the result map — callers handle that as a fallback.
 */
async function getCompaniesMeta(
  tickers: string[],
): Promise<Map<string, CompanyMeta>> {
  const out = new Map<string, CompanyMeta>();
  if (tickers.length === 0) return out;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("companies")
    .select("ticker, price, company_name")
    .in("ticker", tickers);
  if (error) {
    throw new PortfolioError(
      "price_lookup_failed",
      `Bulk company lookup failed: ${error.message}`,
    );
  }
  for (const row of (data ?? []) as {
    ticker: string;
    price: number | string | null;
    company_name: string | null;
  }[]) {
    const priceNum = row.price == null ? null : Number(row.price);
    out.set(row.ticker, {
      price: priceNum != null && Number.isFinite(priceNum) ? priceNum : null,
      company_name: row.company_name ?? null,
    });
  }
  return out;
}

/**
 * Public helper for callers that only need name resolution (e.g. the recent
 * trades table) without going through the full portfolio MTM path.
 */
export async function getCompanyNamesForTickers(
  tickers: string[],
): Promise<Map<string, string>> {
  const distinct = Array.from(new Set(tickers));
  const meta = await getCompaniesMeta(distinct);
  const out = new Map<string, string>();
  for (const [t, m] of meta) {
    if (m.company_name) out.set(t, m.company_name);
  }
  return out;
}

async function getPrice(ticker: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("companies")
    .select("ticker, price")
    .eq("ticker", ticker)
    .maybeSingle();
  if (error) {
    throw new PortfolioError(
      "price_lookup_failed",
      `Price lookup failed for ${ticker}: ${error.message}`,
    );
  }
  if (!data) {
    throw new PortfolioError("unknown_ticker", `Unknown ticker: ${ticker}`);
  }
  const price = Number((data as { price: number | null }).price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new PortfolioError(
      "no_price",
      `No usable price for ${ticker} (companies.price is null or <=0)`,
    );
  }
  return price;
}

async function getAccountRow(agentId: string): Promise<AgentAccount | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agent_accounts")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) {
    throw new PortfolioError(
      "db_error",
      `agent_accounts lookup failed: ${error.message}`,
    );
  }
  if (!data) return null;
  const row = data as {
    agent_id: string;
    starting_cash: string | number;
    cash_usd: string | number;
    inception_date: string;
  };
  return {
    agent_id: row.agent_id,
    starting_cash: Number(row.starting_cash),
    cash_usd: Number(row.cash_usd),
    inception_date: row.inception_date,
  };
}

async function requireAccount(agentId: string): Promise<AgentAccount> {
  const account = await getAccountRow(agentId);
  if (!account) {
    throw new PortfolioError(
      "no_account",
      `No agent_accounts row for ${agentId} — call openAccount() first`,
    );
  }
  return account;
}

async function getHoldingRow(
  agentId: string,
  ticker: string,
): Promise<AgentHolding | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agent_holdings")
    .select("*")
    .eq("agent_id", agentId)
    .eq("ticker", ticker)
    .maybeSingle();
  if (error) {
    throw new PortfolioError(
      "db_error",
      `agent_holdings lookup failed: ${error.message}`,
    );
  }
  if (!data) return null;
  const row = data as {
    agent_id: string;
    ticker: string;
    quantity: string | number;
    avg_cost_usd: string | number;
    first_bought_at: string;
  };
  return {
    agent_id: row.agent_id,
    ticker: row.ticker,
    quantity: Number(row.quantity),
    avg_cost_usd: Number(row.avg_cost_usd),
    first_bought_at: row.first_bought_at,
  };
}

async function getAllHoldings(agentId: string): Promise<AgentHolding[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agent_holdings")
    .select("*")
    .eq("agent_id", agentId);
  if (error) {
    throw new PortfolioError(
      "db_error",
      `agent_holdings lookup failed: ${error.message}`,
    );
  }
  return (data ?? []).map((row) => {
    const r = row as {
      agent_id: string;
      ticker: string;
      quantity: string | number;
      avg_cost_usd: string | number;
      first_bought_at: string;
    };
    return {
      agent_id: r.agent_id,
      ticker: r.ticker,
      quantity: Number(r.quantity),
      avg_cost_usd: Number(r.avg_cost_usd),
      first_bought_at: r.first_bought_at,
    };
  });
}

// ----- Public API ---------------------------------------------------------

/**
 * Idempotently create an agent_accounts row. If one already exists it is
 * returned unchanged — safe to call on every request (first-trade lazy init).
 *
 * Also creates a 1:1 ``portfolios`` row (slug = agent.handle, owner = this
 * agent) and the ``portfolio_agents`` membership row so multi-agent
 * portfolios are wired in from day one (migration 021).
 */
export async function openAccount(
  agentId: string,
  startingCash: number = DEFAULT_STARTING_CASH,
): Promise<AgentAccount> {
  const existing = await getAccountRow(agentId);
  if (existing) {
    await ensurePortfolioForAgent(agentId);
    return existing;
  }

  const portfolioId = await ensurePortfolioForAgent(agentId);
  const supabase = getSupabase();
  const { error } = await supabase.from("agent_accounts").upsert({
    agent_id: agentId,
    portfolio_id: portfolioId,
    starting_cash: startingCash,
    cash_usd: startingCash,
    inception_date: new Date().toISOString().slice(0, 10),
  });
  if (error) {
    throw new PortfolioError(
      "db_error",
      `openAccount insert failed: ${error.message}`,
    );
  }
  const row = await getAccountRow(agentId);
  if (!row) {
    throw new PortfolioError(
      "db_error",
      "openAccount insert succeeded but row not found on readback",
    );
  }
  return row;
}

/**
 * Resolve (creating if necessary) the portfolio_id this agent's trades
 * should attribute to. During the 1:1 shim period the portfolio_id
 * equals the agent_id. Idempotent — safe to call on every buy/sell.
 */
export async function ensurePortfolioForAgent(agentId: string): Promise<string> {
  const supabase = getSupabase();

  // 1. Already owns a portfolio?
  const owned = await supabase
    .from("portfolios")
    .select("id")
    .eq("owner_agent_id", agentId)
    .limit(1)
    .maybeSingle();
  if (owned.data?.id) {
    return owned.data.id as string;
  }

  // 2. Already a member of one?
  const member = await supabase
    .from("portfolio_agents")
    .select("portfolio_id")
    .eq("agent_id", agentId)
    .limit(1)
    .maybeSingle();
  if (member.data?.portfolio_id) {
    return member.data.portfolio_id as string;
  }

  // 3. Create one. portfolio.id = agent.id during the 1:1 shim.
  const agentRow = await supabase
    .from("agents")
    .select("id, handle, display_name, description")
    .eq("id", agentId)
    .maybeSingle();
  if (!agentRow.data) {
    throw new PortfolioError("unknown_agent", `No agents row for ${agentId}`);
  }
  const a = agentRow.data as {
    id: string;
    handle: string;
    display_name: string;
    description: string | null;
  };

  const { error: pErr } = await supabase.from("portfolios").upsert(
    {
      id: a.id,
      slug: a.handle,
      display_name: a.display_name,
      description: a.description,
      owner_agent_id: a.id,
    },
    { onConflict: "id" },
  );
  if (pErr) {
    throw new PortfolioError(
      "db_error",
      `portfolios upsert failed: ${pErr.message}`,
    );
  }

  const { error: mErr } = await supabase
    .from("portfolio_agents")
    .upsert(
      { portfolio_id: a.id, agent_id: a.id },
      { onConflict: "portfolio_id,agent_id" },
    );
  if (mErr) {
    throw new PortfolioError(
      "db_error",
      `portfolio_agents upsert failed: ${mErr.message}`,
    );
  }
  return a.id;
}

export async function buy(
  agentId: string,
  ticker: string,
  quantity: number,
  note = "",
  thesis: ThesisInput | null = null,
): Promise<TradeResult> {
  if (!(quantity > 0)) {
    throw new PortfolioError(
      "invalid_quantity",
      `buy quantity must be > 0, got ${quantity}`,
    );
  }

  const account = await openAccount(agentId); // lazy bootstrap
  const portfolioId = await ensurePortfolioForAgent(agentId);
  const price = await getPrice(ticker);
  const gross = round2(quantity * price);
  const cash = account.cash_usd;

  if (gross > cash + 1e-9) {
    throw new PortfolioError(
      "insufficient_cash",
      `Insufficient cash: need $${gross.toFixed(2)}, have $${cash.toFixed(2)}`,
    );
  }

  const newCash = round2(cash - gross);
  const supabase = getSupabase();

  const existing = await getHoldingRow(agentId, ticker);
  if (existing) {
    const newQty = existing.quantity + quantity;
    const newAvgCost = round4(
      (existing.quantity * existing.avg_cost_usd + quantity * price) / newQty,
    );
    const { error: hErr } = await supabase.from("agent_holdings").upsert({
      agent_id: agentId,
      portfolio_id: portfolioId,
      ticker,
      quantity: newQty,
      avg_cost_usd: newAvgCost,
      first_bought_at: existing.first_bought_at,
    });
    if (hErr) {
      throw new PortfolioError(
        "db_error",
        `agent_holdings upsert failed: ${hErr.message}`,
      );
    }
  } else {
    const { error: hErr } = await supabase.from("agent_holdings").upsert({
      agent_id: agentId,
      portfolio_id: portfolioId,
      ticker,
      quantity,
      avg_cost_usd: round4(price),
    });
    if (hErr) {
      throw new PortfolioError(
        "db_error",
        `agent_holdings insert failed: ${hErr.message}`,
      );
    }
  }

  const { error: aErr } = await supabase
    .from("agent_accounts")
    .update({ cash_usd: newCash, portfolio_id: portfolioId })
    .eq("agent_id", agentId);
  if (aErr) {
    throw new PortfolioError(
      "db_error",
      `agent_accounts update failed: ${aErr.message}`,
    );
  }

  const executed_at = new Date().toISOString();
  const trade = {
    agent_id: agentId,
    portfolio_id: portfolioId,
    ticker,
    side: "buy" as const,
    quantity,
    price_usd: round4(price),
    gross_usd: gross,
    cash_after_usd: newCash,
    executed_at,
    note,
  };
  const { data: tradeRow, error: tErr } = await supabase
    .from("agent_trades")
    .insert(trade)
    .select("id")
    .single();
  if (tErr) {
    throw new PortfolioError(
      "db_error",
      `agent_trades insert failed: ${tErr.message}`,
    );
  }
  const tradeId = (tradeRow as { id: number } | null)?.id ?? null;

  // Mandatory snapshot capture + optional thesis text. Matches the Python
  // path's behaviour (theses.py). Errors are logged inside recordThesis
  // and never propagated — a thesis I/O failure must not roll back the
  // trade itself.
  await recordThesis({ agentId, portfolioId, ticker, tradeId, thesis });

  return trade;
}

export async function sell(
  agentId: string,
  ticker: string,
  quantity: number,
  note = "",
): Promise<TradeResult> {
  if (!(quantity > 0)) {
    throw new PortfolioError(
      "invalid_quantity",
      `sell quantity must be > 0, got ${quantity}`,
    );
  }

  const account = await requireAccount(agentId);
  const portfolioId = await ensurePortfolioForAgent(agentId);
  const holding = await getHoldingRow(agentId, ticker);
  if (!holding) {
    throw new PortfolioError(
      "no_position",
      `No position in ${ticker} for agent ${agentId}`,
    );
  }
  if (quantity > holding.quantity + 1e-9) {
    throw new PortfolioError(
      "oversell",
      `Cannot sell ${quantity} of ${ticker}: holding only ${holding.quantity}`,
    );
  }

  const price = await getPrice(ticker);
  const gross = round2(quantity * price);
  const newCash = round2(account.cash_usd + gross);
  const remaining = Math.round((holding.quantity - quantity) * 1e6) / 1e6;
  const supabase = getSupabase();

  if (remaining <= 1e-9) {
    const { error: dErr } = await supabase
      .from("agent_holdings")
      .delete()
      .eq("agent_id", agentId)
      .eq("ticker", ticker);
    if (dErr) {
      throw new PortfolioError(
        "db_error",
        `agent_holdings delete failed: ${dErr.message}`,
      );
    }
  } else {
    // avg_cost_usd unchanged on sells (weighted-avg convention)
    const { error: uErr } = await supabase.from("agent_holdings").upsert({
      agent_id: agentId,
      portfolio_id: portfolioId,
      ticker,
      quantity: remaining,
      avg_cost_usd: holding.avg_cost_usd,
      first_bought_at: holding.first_bought_at,
    });
    if (uErr) {
      throw new PortfolioError(
        "db_error",
        `agent_holdings upsert failed: ${uErr.message}`,
      );
    }
  }

  const { error: aErr } = await supabase
    .from("agent_accounts")
    .update({ cash_usd: newCash, portfolio_id: portfolioId })
    .eq("agent_id", agentId);
  if (aErr) {
    throw new PortfolioError(
      "db_error",
      `agent_accounts update failed: ${aErr.message}`,
    );
  }

  const executed_at = new Date().toISOString();
  const trade = {
    agent_id: agentId,
    portfolio_id: portfolioId,
    ticker,
    side: "sell" as const,
    quantity,
    price_usd: round4(price),
    gross_usd: gross,
    cash_after_usd: newCash,
    executed_at,
    note,
  };
  const { error: tErr } = await supabase.from("agent_trades").insert(trade);
  if (tErr) {
    throw new PortfolioError(
      "db_error",
      `agent_trades insert failed: ${tErr.message}`,
    );
  }

  // Close any open theses if the position is fully exited. Idempotent
  // (no-op when no rows match). Matches the Python sell path.
  if (remaining <= 1e-9) {
    await closeThesesForPosition({ agentId, portfolioId, ticker });
  }

  return trade;
}

/**
 * Mark-to-market valuation for a single agent. Lazily opens an account on
 * first call so new agents always see a fresh $1M portfolio.
 */
export async function getPortfolio(
  agentId: string,
): Promise<PortfolioSnapshot> {
  const account = await openAccount(agentId);
  const holdings = await getAllHoldings(agentId);

  // Bulk-fetch price + name for every holding in one round-trip. Previously
  // we did N sequential SELECTs from companies — for an agent with 30
  // positions that turned the page into 30 chained network hops.
  const meta = await getCompaniesMeta(holdings.map((h) => h.ticker));

  const enriched: HoldingWithMtm[] = [];
  let holdingsValue = 0;

  for (const h of holdings) {
    const row = meta.get(h.ticker);
    const rawPrice = row?.price ?? null;
    // Fall back to avg cost when price unavailable so the row still shows.
    const price =
      rawPrice != null && Number.isFinite(rawPrice) && rawPrice > 0
        ? rawPrice
        : h.avg_cost_usd;
    const mv = round2(h.quantity * price);
    holdingsValue += mv;
    enriched.push({
      ticker: h.ticker,
      company_name: row?.company_name ?? null,
      quantity: h.quantity,
      avg_cost_usd: h.avg_cost_usd,
      price_usd: round4(price),
      market_value_usd: mv,
      unrealized_pnl_usd: round2((price - h.avg_cost_usd) * h.quantity),
    });
  }

  holdingsValue = round2(holdingsValue);
  const total = round2(account.cash_usd + holdingsValue);
  const pnl = round2(total - account.starting_cash);
  const pnlPct =
    account.starting_cash > 0
      ? Math.round((pnl / account.starting_cash) * 1_000_000) / 10_000
      : 0;

  return {
    agent_id: agentId,
    cash_usd: account.cash_usd,
    starting_cash: account.starting_cash,
    holdings: enriched,
    holdings_value_usd: holdingsValue,
    total_value_usd: total,
    pnl_usd: pnl,
    pnl_pct: pnlPct,
  };
}

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agent_leaderboard")
    .select(
      "handle, display_name, is_house_agent, snapshot_date, cash_usd, holdings_value_usd, total_value_usd, pnl_usd, pnl_pct, num_positions",
    )
    .order("pnl_pct", { ascending: false, nullsFirst: false });
  if (error) {
    throw new PortfolioError(
      "db_error",
      `agent_leaderboard query failed: ${error.message}`,
    );
  }
  return (data ?? []) as unknown as LeaderboardRow[];
}
