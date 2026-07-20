/**
 * Server-side badge reads. Service-role client (badge_grants is service-role
 * only — a grant can belong to a private portfolio, so the website reads it
 * server-side and filters visibility at the call site).
 *
 * Grants are materialised nightly by `award_badges.py`, so the catalog read
 * (with global earn-rates) is cached daily.
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import type { Badge, CatalogBadge, EarnedBadge } from "@/lib/badges";

const BADGE_COLUMNS =
  "id, slug, name, description, condition_text, category, rarity, icon, is_period, phase, sort_order";

async function fetchBadges(): Promise<Badge[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("badges")
    .select(BADGE_COLUMNS)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("fetchBadges failed:", error.message);
    return [];
  }
  return (data as Badge[]) ?? [];
}

/**
 * The full catalog decorated with each badge's global earn-rate. Earn-rate =
 * grants of that badge / eligible portfolios (non-live portfolios that have
 * been valued at least once). Cached daily — the numbers only move when the
 * nightly sweep runs.
 */
async function fetchCatalog(): Promise<CatalogBadge[]> {
  const supabase = getSupabase();
  const badges = await fetchBadges();

  // Grant counts per badge (small table — count in JS rather than an RPC).
  const counts = new Map<number, number>();
  const { data: grants, error: gErr } = await supabase
    .from("badge_grants")
    .select("badge_id");
  if (gErr) {
    console.error("fetchCatalog grant counts failed:", gErr.message);
  } else {
    for (const g of (grants as { badge_id: number }[]) ?? []) {
      counts.set(g.badge_id, (counts.get(g.badge_id) ?? 0) + 1);
    }
  }

  // Eligible denominator: non-live portfolios (the set the sweep runs over).
  const { count: eligibleCount, error: pErr } = await supabase
    .from("portfolios")
    .select("id", { count: "exact", head: true })
    .neq("mode", "live");
  const eligible = pErr || !eligibleCount ? 0 : eligibleCount;
  if (pErr) console.error("fetchCatalog eligible count failed:", pErr.message);

  return badges.map((b) => {
    const grant_count = counts.get(b.id) ?? 0;
    return {
      ...b,
      grant_count,
      earn_rate: eligible > 0 ? grant_count / eligible : 0,
    };
  });
}

export const getBadgeCatalog = unstable_cache(fetchCatalog, ["badge-catalog-v1"], {
  revalidate: 86400,
  tags: ["badges"],
});

/** Earned badges (grant joined to catalog) for one portfolio. */
export async function getEarnedBadges(portfolioId: string): Promise<EarnedBadge[]> {
  if (!portfolioId) return [];
  const supabase = getSupabase();
  const [badges, grantsRes] = await Promise.all([
    fetchBadges(),
    supabase
      .from("badge_grants")
      .select("badge_id, period_id, granted_at, context")
      .eq("portfolio_id", portfolioId),
  ]);
  if (grantsRes.error) {
    console.error("getEarnedBadges failed:", grantsRes.error.message);
    return [];
  }
  const byId = new Map(badges.map((b) => [b.id, b]));
  const out: EarnedBadge[] = [];
  for (const g of (grantsRes.data as GrantRow[]) ?? []) {
    const badge = byId.get(g.badge_id);
    if (!badge) continue;
    out.push({
      ...badge,
      granted_at: g.granted_at,
      period_id: g.period_id ?? "",
      context: (g.context as Record<string, unknown>) ?? {},
    });
  }
  return out;
}

interface GrantRow {
  badge_id: number;
  period_id: string | null;
  granted_at: string;
  context: unknown;
  portfolio_id?: string;
}

/**
 * Batch: earned badges for many portfolios in one query, keyed by
 * portfolio_id. Used by the leaderboard (one query for the whole board).
 */
export async function getEarnedBadgesForPortfolios(
  portfolioIds: string[],
): Promise<Map<string, EarnedBadge[]>> {
  const out = new Map<string, EarnedBadge[]>();
  const ids = [...new Set(portfolioIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const supabase = getSupabase();
  const [badges, grantsRes] = await Promise.all([
    fetchBadges(),
    supabase
      .from("badge_grants")
      .select("portfolio_id, badge_id, period_id, granted_at, context")
      .in("portfolio_id", ids),
  ]);
  if (grantsRes.error) {
    console.error("getEarnedBadgesForPortfolios failed:", grantsRes.error.message);
    return out;
  }
  const byId = new Map(badges.map((b) => [b.id, b]));
  for (const g of (grantsRes.data as GrantRow[]) ?? []) {
    const badge = byId.get(g.badge_id);
    if (!badge || !g.portfolio_id) continue;
    const list = out.get(g.portfolio_id) ?? [];
    list.push({
      ...badge,
      granted_at: g.granted_at,
      period_id: g.period_id ?? "",
      context: (g.context as Record<string, unknown>) ?? {},
    });
    out.set(g.portfolio_id, list);
  }
  return out;
}
