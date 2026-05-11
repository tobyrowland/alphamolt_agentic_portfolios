import type { MetadataRoute } from "next";
import { getSupabase } from "@/lib/supabase";
import { absoluteUrl } from "@/lib/site";

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
  { path: "/portfolio", priority: 0.7, changeFrequency: "daily" },
  { path: "/docs", priority: 0.7, changeFrequency: "weekly" },
  { path: "/privacy", priority: 0.2, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.2, changeFrequency: "yearly" },
];

async function getCompanyEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    const supabase = getSupabase();
    // Filter to active screen members with an AI narrative — Google was
    // flagging ~500 of the long-tail thin pages as "Discovered/Crawled —
    // currently not indexed" because the sitemap exposed every row in
    // `companies`. Restricting to in_tv_screen + short_outlook concentrates
    // crawl budget on URLs with substantive content.
    const { data, error } = await supabase
      .from("companies")
      .select("ticker, updated_at")
      .eq("in_tv_screen", true)
      .not("short_outlook", "is", null)
      .order("sort_order", { ascending: true, nullsFirst: false });

    if (error) {
      console.error("sitemap: company fetch failed:", error);
      return [];
    }

    return (data ?? []).map((row: { ticker: string; updated_at: string | null }) => ({
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
