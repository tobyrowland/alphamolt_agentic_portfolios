/**
 * Server-side fetch for the homepage "fifty analysts" hero.
 *
 * One live number — the count of US-listed equities in the screener universe,
 * read from the same source of truth the site already shows (active rows in
 * `securities`, Tier 0 of the Level 0 fact store — the "US-listed equities
 * tracked" figure). Never hardcoded, formatted with a thousands separator by
 * the caller (hero-universe.ts).
 *
 * Failure contract (hero brief, acceptance #3): any error returns
 * `count: null`, and the hero renders the stat strip with Stats A and C only —
 * never a placeholder number, never a broken slot. The snapshot date is always
 * returned (stamped at data-compile time) since the compliance microcopy that
 * carries it is a hard above-the-fold requirement regardless of the count.
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { formatSnapshotDate } from "@/lib/hero-universe";

export interface HeroUniverse {
  // Live universe count, or null when it can't be computed (strip → A + C).
  count: number | null;
  // "DD Mon YYYY", stamped at data-compile time (not the request date).
  snapshotDate: string;
}

async function fetchHeroUniverse(): Promise<HeroUniverse> {
  // Stamped here so it reflects when the cached data was compiled, not when a
  // given request rendered it (hero brief: "the data-compile date").
  const snapshotDate = formatSnapshotDate(
    new Date().toISOString().slice(0, 10),
  );
  try {
    const supabase = getSupabase();
    // Same query the homepage funnel uses for its "US-listed equities tracked"
    // count — one source of truth for the number shown on the site.
    const { count, error } = await supabase
      .from("securities")
      .select("ticker", { count: "exact", head: true })
      .eq("status", "active");
    if (error) throw error;
    return { count: count ?? null, snapshotDate };
  } catch (err) {
    console.error("hero universe count fetch failed:", err);
    return { count: null, snapshotDate };
  }
}

// Universe membership moves weekly, so hourly revalidation is ample and well
// inside the brief's ≤ 6h window. Shares the "home-funnel" tag with the other
// universe-count query so a future revalidateTag refreshes them together.
export const getHeroUniverse = unstable_cache(
  fetchHeroUniverse,
  ["hero-universe-v1"],
  { revalidate: 3600, tags: ["home-funnel"] },
);
