import type { MetadataRoute } from "next";
import { getSupabase } from "@/lib/supabase";
import { absoluteUrl } from "@/lib/site";
import { isCompanyIndexable } from "@/lib/company-indexable";

export const revalidate = 3600;

type ChangeFreq = NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;

interface StaticRoute {
  path: string;
  priority: number;
  changeFrequency: ChangeFreq;
}

const STATIC_ROUTES: StaticRoute[] = [
  { path: "/", priority: 1.0, changeFrequency: "daily" },
  { path: "/screener", priority: 0.9, changeFrequency: "daily" },
  { path: "/leaderboard", priority: 0.9, changeFrequency: "daily" },
  { path: "/consensus", priority: 0.85, changeFrequency: "weekly" },
  { path: "/sold", priority: 0.6, changeFrequency: "daily" },
  { path: "/portfolio", priority: 0.7, changeFrequency: "daily" },
  { path: "/docs", priority: 0.7, changeFrequency: "weekly" },
  { path: "/about", priority: 0.5, changeFrequency: "monthly" },
  { path: "/privacy", priority: 0.2, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.2, changeFrequency: "yearly" },
];

async function getCompanyEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    const supabase = getSupabase();
    // §8.8 index rule (shared with the page's robots tag via
    // isCompanyIndexable): a ticker is indexable when ≥1 agent has ever
    // traded it OR it has full fundamentals + an AI narrative. Untraded,
    // data-sparse pages are kept OUT of the sitemap (and `noindex`ed) so
    // thousands of thin near-duplicates can't dilute crawl budget.
    // Identity + updated_at from Level 0 (`securities`, Tier 1); the AI
    // narrative `short_outlook` lives in `ai_analysis` (migration 053).
    const [companiesRes, narrativeRes, tradedRes] = await Promise.all([
      supabase
        .from("securities")
        .select("ticker, updated_at")
        .eq("is_tier1", true)
        .eq("status", "active")
        .order("ticker", { ascending: true }),
      supabase
        .from("ai_analysis")
        .select("ticker, short_outlook")
        .not("short_outlook", "is", null),
      supabase.from("agent_trades").select("ticker"),
    ]);

    if (companiesRes.error) {
      console.error("sitemap: securities fetch failed:", companiesRes.error);
      return [];
    }
    if (narrativeRes.error) {
      console.error("sitemap: ai_analysis fetch failed:", narrativeRes.error);
    }
    if (tradedRes.error) {
      console.error("sitemap: agent_trades fetch failed:", tradedRes.error);
    }

    const tradedTickers = new Set(
      (tradedRes.data ?? []).map((r: { ticker: string }) => r.ticker),
    );
    const shortOutlookByTicker = new Map<string, string | null>(
      ((narrativeRes.data ?? []) as {
        ticker: string;
        short_outlook: string | null;
      }[]).map((r) => [r.ticker, r.short_outlook]),
    );

    return (companiesRes.data ?? [])
      .filter((row: { ticker: string }) =>
        isCompanyIndexable({
          hasTrades: tradedTickers.has(row.ticker),
          shortOutlook: shortOutlookByTicker.get(row.ticker) ?? null,
        }),
      )
      .map((row: { ticker: string; updated_at: string | null }) => ({
        url: absoluteUrl(`/company/${encodeURIComponent(row.ticker)}`),
        lastModified: row.updated_at ? new Date(row.updated_at) : new Date(),
        changeFrequency: "daily" as ChangeFreq,
        priority: 0.6,
      }));
  } catch (err) {
    // Don't blow up the whole sitemap on a DB hiccup — static routes still
    // need to be emitted so core pages stay crawlable.
    console.error("sitemap: unexpected error:", err);
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: now,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  const companyEntries = await getCompanyEntries();
  return [...staticEntries, ...companyEntries];
}
