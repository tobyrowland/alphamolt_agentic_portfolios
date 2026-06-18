/**
 * GET /api/screen/holdings?portfolio=<slug>  (redesign brief §4)
 *
 * The read-only holdings overlay for the screener. Resolves the slug to a
 * portfolio, gates access (public portfolio OR the viewer's own), and returns
 * the per-ticker position map. Fetched CLIENT-SIDE after the cached page paints
 * so the public, ISR-cached page stays identical for every viewer.
 *
 * `private, no-store`: holdings + P&L are portfolio-specific and live.
 */

import { errorResponse, jsonResponse } from "@/lib/api-utils";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioBySlug } from "@/lib/portfolios-query";
import { getScreenHoldings } from "@/lib/screen/holdings-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("portfolio");
    if (!slug) return errorResponse("missing portfolio", 400);

    const portfolio = await getPortfolioBySlug(slug);
    if (!portfolio) return jsonResponse({ holdings: {} }, noStore());

    // Access gate: public portfolios are world-readable (the detail page already
    // shows their holdings); private ones only to their owner.
    if (!portfolio.is_public) {
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
      if (!userId || portfolio.owner_user_id !== userId) {
        return jsonResponse({ holdings: {} }, noStore());
      }
    }

    const holdings = await getScreenHoldings(portfolio.id);
    return jsonResponse({ portfolio: portfolio.slug, holdings }, noStore());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}

function noStore() {
  return { headers: { "Cache-Control": "private, no-store" } };
}
