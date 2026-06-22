/**
 * GET /api/companies
 *
 * Public, no-auth feed of every ticker AlphaMolt has a company page
 * for — the superset that includes all consensus tickers + everything
 * else in `companies`. Used by the reply-writer Chrome extension to
 * verify a page exists before linking to /company/<TICKER>.
 *
 * Sibling of /api/consensus and /api/agents — same shape conventions
 * (CORS-permissive, 1h CDN cache, daily client cache).
 *
 * Invariant: consensus_snapshots tickers are written by the heartbeat,
 * which can only buy tickers present in `companies` (PortfolioManager
 * validates via get_price()). So consensus is a strict subset of
 * companies by construction — the extension can rely on it.
 *
 * Filter: any row with a non-null ticker, regardless of in_tv_screen.
 * The /company/[ticker] page renders any ticker that exists in the
 * table, so we shouldn't pre-filter to the active screen.
 */

import { errorResponse, jsonResponse, optionsResponse } from "@/lib/api-utils";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CompanyRow = {
  ticker: string;
  company_name: string | null;
  updated_at: string | null;
};

export async function OPTIONS() {
  return optionsResponse();
}

export async function GET() {
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("securities")
      .select("ticker, name, updated_at")
      .eq("status", "active")
      .not("ticker", "is", null)
      .order("ticker", { ascending: true });
    if (error) {
      return errorResponse(error.message, 500);
    }
    const rows = ((data ?? []) as unknown as {
      ticker: string;
      name: string | null;
      updated_at: string | null;
    }[]).map((r) => ({
      ticker: r.ticker,
      company_name: r.name,
      updated_at: r.updated_at,
    })) as CompanyRow[];

    // Dedupe by ticker (first occurrence wins per the brief).
    const seen = new Set<string>();
    const entries: Array<{ ticker: string; name?: string }> = [];
    let latestUpdate = 0;
    for (const r of rows) {
      const ticker = r.ticker?.trim().toUpperCase();
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      const name = r.company_name?.trim();
      entries.push(name ? { ticker, name } : { ticker });
      if (r.updated_at) {
        const t = Date.parse(r.updated_at);
        if (!Number.isNaN(t) && t > latestUpdate) latestUpdate = t;
      }
    }

    return jsonResponse(
      {
        version: 1,
        updatedAt:
          latestUpdate > 0 ? new Date(latestUpdate).toISOString() : null,
        entries,
      },
      { headers: cacheHeaders() },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 500);
  }
}

function cacheHeaders(): Record<string, string> {
  return {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
  };
}
