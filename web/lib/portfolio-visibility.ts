import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioBySlug, type Portfolio } from "@/lib/portfolios-query";

/**
 * Fetch a portfolio by slug, applying the migration-024 visibility gate: a
 * private portfolio is visible only to its owner (the signed-in human).
 * Shared by /portfolios/[slug] and its /universe sibling page.
 */
export async function resolveVisiblePortfolio(
  slug: string,
): Promise<Portfolio | null> {
  const portfolio = await getPortfolioBySlug(slug);
  if (!portfolio) return null;
  if (portfolio.is_public) return portfolio;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user && portfolio.owner_user_id && user.id === portfolio.owner_user_id) {
    return portfolio;
  }
  return null;
}

export async function isViewerOwner(portfolio: Portfolio): Promise<boolean> {
  if (!portfolio.owner_user_id) return false;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return !!user && user.id === portfolio.owner_user_id;
}
