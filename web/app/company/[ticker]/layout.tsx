import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { isValidTicker } from "@/lib/company-page-data";

/**
 * Existence gate for /company/{ticker} — lives in the LAYOUT because the
 * layout resolves BEFORE the loading.tsx shell flushes. notFound() here sets
 * a real HTTP 404 for unknown/malformed tickers; the same check in page.tsx
 * (below the loading boundary) runs only after a 200 shell + skeletons have
 * already streamed, which Google filed as Soft 404s.
 *
 * The check is a single indexed read of `securities` (the page renders any
 * ACTIVE TIER 1 name — the same universe api_universe_facts serves) rather
 * than loadCompany: loadCompany resolves through the process-cached universe
 * snapshot, which degrades to an EMPTY set on a transient fetch failure — a
 * gate built on it would 404 every real ticker and ISR would cache that for
 * a day. Here a query error fails OPEN (the page still tries to render);
 * only a definitive "no such active Tier 1 ticker" 404s.
 */
export default async function CompanyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  const decoded = decodeURIComponent(ticker);
  if (!isValidTicker(decoded)) notFound();

  const { data, error } = await getSupabase()
    .from("securities")
    .select("ticker, is_tier1, status")
    .eq("ticker", decoded.toUpperCase())
    .maybeSingle();

  if (error) {
    // Transient lookup failure — never turn it into a (cacheable) 404.
    console.error(`company gate: securities lookup failed for ${decoded}:`, error.message);
  } else if (!data || data.status !== "active" || !data.is_tier1) {
    notFound();
  }

  return children;
}
