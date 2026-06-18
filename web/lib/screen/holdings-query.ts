/**
 * Read-only holdings overlay for the screener (redesign brief §4).
 *
 * For a selected portfolio, returns the per-ticker position state so the page
 * can mark rows (`held` / `review` / `sold`) and fill a Position block on
 * expand. Live and portfolio-specific, so it's fetched CLIENT-SIDE after the
 * cached page paints — never through the matview / ISR cache (a holdings read
 * must not vary the public, shared page).
 *
 * RLS note: the website reads with the service-role key. The owner-gating is
 * enforced upstream by the API route (which resolves the viewer's own
 * portfolios); this lib is a pure read once a portfolio id is in hand.
 */

import { getSupabase } from "@/lib/supabase";
import { getPortfolioByPortfolioId } from "@/lib/portfolio";
import { getActiveThesesForPortfolio, type InvestmentThesis } from "@/lib/theses-query";

export interface ScreenHolding {
  ticker: string;
  state: "held" | "sold";
  quantity: number | null;
  avg_cost_usd: number | null;
  last_price_usd: number | null;
  market_value_usd: number | null;
  unrealized_pnl_usd: number | null;
  thesis_status: string | null; // 'active' | 'broken' | 'closed' | …
  has_break_signals: boolean; // held + active card break signals ⇒ "review"
  exit_date: string | null; // sold: most recent sell date
}

/**
 * Position map keyed by upper-case ticker for the given portfolio. Held names
 * carry MTM + thesis status; recently-sold names (last 180d) carry the exit
 * date + closed thesis so the page can render a `sold` pill.
 */
export async function getScreenHoldings(
  portfolioId: string,
  breakTickers?: Set<string>,
): Promise<Record<string, ScreenHolding>> {
  const supabase = getSupabase();
  const out: Record<string, ScreenHolding> = {};

  const [snapshot, theses] = await Promise.all([
    getPortfolioByPortfolioId(portfolioId).catch(() => null),
    getActiveThesesForPortfolio(portfolioId).catch(
      () => ({}) as Record<string, InvestmentThesis>,
    ),
  ]);

  for (const h of snapshot?.holdings ?? []) {
    const t = h.ticker.toUpperCase();
    out[t] = {
      ticker: t,
      state: "held",
      quantity: h.quantity,
      avg_cost_usd: h.avg_cost_usd,
      last_price_usd: h.price_usd,
      market_value_usd: h.market_value_usd,
      unrealized_pnl_usd: h.unrealized_pnl_usd,
      thesis_status: theses[h.ticker]?.status ?? null,
      has_break_signals: breakTickers ? breakTickers.has(t) : false,
      exit_date: null,
    };
  }

  // Recently-sold names (last 180d) the portfolio no longer holds → `sold` pill.
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const { data: sells } = await supabase
    .from("agent_trades")
    .select("ticker, side, price_usd, executed_at")
    .eq("portfolio_id", portfolioId)
    .eq("side", "sell")
    .gte("executed_at", since)
    .order("executed_at", { ascending: false });
  for (const row of (sells ?? []) as {
    ticker: string;
    price_usd: string | number;
    executed_at: string;
  }[]) {
    const t = row.ticker.toUpperCase();
    if (out[t]) continue; // still held (a later buy) — keep the held entry
    out[t] = {
      ticker: t,
      state: "sold",
      quantity: null,
      avg_cost_usd: null,
      last_price_usd: Number(row.price_usd) || null,
      market_value_usd: null,
      unrealized_pnl_usd: null,
      thesis_status: "closed",
      has_break_signals: false,
      exit_date: row.executed_at,
    };
  }

  return out;
}
