/**
 * Server-side fetch for the homepage hero funnel counts — the "coverage,
 * not recall" numbers the animated ticker wall and stage rail count
 * through (hero v4 brief).
 *
 * All four figures are coverage stats over the Level 0 fact store, not
 * performance numbers:
 *   listed   — Tier 0: every active US-listed common stock / ADR / REIT
 *   tier1    — the affordability-gated tradable universe, scored nightly
 *   cards    — names carrying an AI research card (`ai_analysis.research_card`)
 *   verdicts — names with BOTH a bull and a bear eval (the pairs that feed
 *              the screener's verdict tilt)
 *
 * Fallback contract: if the DB is unreachable the hero still needs numbers
 * to animate, so we fall back to recent real magnitudes (marked below) —
 * acceptable here because these are slow-moving universe counts, never
 * returns or standings.
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";

export interface HomeFunnelCounts {
  listed: number;
  tier1: number;
  cards: number;
  verdicts: number;
}

// Snapshot of the real counts at the time the hero shipped — used only
// when the live queries fail.
export const FUNNEL_FALLBACK: HomeFunnelCounts = {
  listed: 5_839,
  tier1: 3_169,
  cards: 3_049,
  verdicts: 1_973,
};

async function fetchHomeFunnel(): Promise<HomeFunnelCounts> {
  const supabase = getSupabase();

  const [listedRes, tier1Res, cardsRes, verdictsRes] = await Promise.all([
    supabase
      .from("securities")
      .select("ticker", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("securities")
      .select("ticker", { count: "exact", head: true })
      .eq("status", "active")
      .eq("is_tier1", true),
    supabase
      .from("ai_analysis")
      .select("ticker", { count: "exact", head: true })
      .not("research_card", "is", null),
    supabase
      .from("ai_analysis")
      .select("ticker", { count: "exact", head: true })
      .not("bull_eval", "is", null)
      .not("bear_eval", "is", null),
  ]);

  return {
    listed: listedRes.count ?? FUNNEL_FALLBACK.listed,
    tier1: tier1Res.count ?? FUNNEL_FALLBACK.tier1,
    cards: cardsRes.count ?? FUNNEL_FALLBACK.cards,
    verdicts: verdictsRes.count ?? FUNNEL_FALLBACK.verdicts,
  };
}

// Universe membership moves weekly and evals rotate daily — hourly
// revalidation is plenty.
export const getHomeFunnel = unstable_cache(fetchHomeFunnel, [
  "home-funnel-v1",
], {
  revalidate: 3600,
  tags: ["home-funnel"],
});
