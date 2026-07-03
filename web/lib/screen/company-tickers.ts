import { getSupabase } from "@/lib/supabase";

/**
 * Tickers that have a /company/<ticker> page. The page renders any active
 * Tier 1 security straight from the Level 0 fact store, so EVERY name the
 * screener ranks is linkable — gate on `securities.is_tier1` (active), which
 * is the same universe the screen ranks over.
 *
 * In-process cached (1 h) — Tier 1 membership only changes on the weekly
 * universe sync, so re-fetching ~3.1k rows on every render is wasted TTFB.
 * Mirrors the `loadFacts` fact cache in lib/screen/query.ts. Shared by the
 * public /screener page and the per-portfolio embedded screener.
 */
let tickerCache: { at: number; data: string[] } | null = null;
const TICKER_TTL_MS = 60 * 60 * 1000;

export async function getCompanyTickers(): Promise<string[]> {
  if (tickerCache && Date.now() - tickerCache.at < TICKER_TTL_MS) {
    return tickerCache.data;
  }
  const tickers: string[] = [];
  const supabase = getSupabase();
  const PAGE = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("securities")
      .select("ticker")
      .eq("is_tier1", true)
      .eq("status", "active")
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) {
      console.error("getCompanyTickers failed:", error);
      // Serve a stale cache on a transient error rather than dropping all links.
      if (tickerCache) return tickerCache.data;
      break;
    }
    const batch = (data ?? []) as { ticker: string }[];
    tickers.push(...batch.map((r) => r.ticker));
    if (batch.length < PAGE) break;
  }
  tickerCache = { at: Date.now(), data: tickers };
  return tickers;
}
