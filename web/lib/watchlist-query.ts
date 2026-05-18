/**
 * Read-side queries for the per-portfolio watchlist (migration 027).
 *
 * Uses the service-role client like the other portfolio queries — the
 * page resolves the signed-in user and their portfolio first, then reads
 * the watchlist by `portfolio_id`. RLS on the table is defense-in-depth.
 */

import { getSupabase } from "@/lib/supabase";

export interface WatchlistItem {
  ticker: string;
  company_name: string | null;
  sector: string | null;
  price: number | null;
  composite_score: number | null;
  status: string | null;
  /** Who added it — 'user' (the owner) or 'agent'. */
  source: "user" | "agent";
  rationale: string | null;
  created_at: string;
}

export async function getWatchlistForPortfolio(
  portfolioId: string,
): Promise<WatchlistItem[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolio_watchlist")
    .select(
      "ticker, source, rationale, created_at, " +
        "companies (company_name, sector, price, composite_score, status)",
    )
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getWatchlistForPortfolio failed:", error);
    return [];
  }

  // PostgREST embeds a to-one join as either an object or a length-1
  // array depending on inference — normalise to the object.
  type EmbeddedCompany = {
    company_name: string | null;
    sector: string | null;
    price: number | string | null;
    composite_score: number | string | null;
    status: string | null;
  };
  type Row = {
    ticker: string;
    source: string;
    rationale: string | null;
    created_at: string;
    companies: EmbeddedCompany | EmbeddedCompany[] | null;
  };

  const rows = (data as unknown as Row[] | null) ?? [];
  return rows.map((r) => {
    const c = Array.isArray(r.companies) ? r.companies[0] : r.companies;
    return {
      ticker: r.ticker,
      company_name: c?.company_name ?? null,
      sector: c?.sector ?? null,
      price: c?.price != null ? Number(c.price) : null,
      composite_score:
        c?.composite_score != null ? Number(c.composite_score) : null,
      status: c?.status ?? null,
      source: r.source === "agent" ? "agent" : "user",
      rationale: r.rationale,
      created_at: r.created_at,
    };
  });
}
