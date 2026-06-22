/**
 * GET /api/portfolios/<slug>/activity
 *
 * The portfolio "Activity" drawer feed: what the portfolio's team actually did
 * — every agent run (including deliberate no-ops), the fills, and (owner-only)
 * the names a buyer passed on. Resolves the slug, applies the same visibility
 * gate as the detail page (public OR the viewer's own), and only includes the
 * private rejection list for the owner.
 *
 * Caching mirrors `/api/screen/holdings`: a non-owner view of a public
 * portfolio is cacheable; the owner view (which carries the private pass list)
 * is `private, no-store`.
 */

import { errorResponse, jsonResponse } from "@/lib/api-utils";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioBySlug } from "@/lib/portfolios-query";
import { getPortfolioActivity } from "@/lib/activity-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug: rawSlug } = await params;
    const slug = decodeURIComponent(rawSlug).toLowerCase();

    const portfolio = await getPortfolioBySlug(slug);
    if (!portfolio) return jsonResponse({ events: [] }, noStore());

    // Resolve the viewer once — used for both the private-portfolio gate and
    // the owner-only rejection list.
    let userId: string | null = null;
    try {
      const supa = await createSupabaseServerClient();
      const {
        data: { user },
      } = await supa.auth.getUser();
      userId = user?.id ?? null;
    } catch {
      userId = null;
    }
    const isOwner = !!userId && portfolio.owner_user_id === userId;

    // Visibility gate (migration 024): a private portfolio is owner-only.
    if (!portfolio.is_public && !isOwner) {
      return jsonResponse({ events: [] }, noStore());
    }

    const events = await getPortfolioActivity(
      portfolio.id,
      portfolio.owner_agent_id ?? null,
      { includeRejections: isOwner },
    );

    // The owner view carries the private pass list, so it must never be cached
    // at the edge; a public, non-owner view is safe to cache.
    const cache = isOwner
      ? noStore()
      : { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } };
    return jsonResponse({ events }, cache);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}

function noStore() {
  return { headers: { "Cache-Control": "private, no-store" } };
}
