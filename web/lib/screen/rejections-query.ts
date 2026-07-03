import { getSupabase } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioForUser } from "@/lib/portfolios-query";

export interface ScreenerRejection {
  ticker: string;
  rejected_at: string;
  expires_at: string;
  reason: string | null;
  conviction: number | null;
}

/**
 * Active (non-expired, non-restored) screener rejections for the SIGNED-IN
 * viewer's PRIMARY arena (paper) portfolio — names its buyer evaluated and
 * passed on within the last 90 days (migration 051). Per-portfolio, so it's
 * empty when logged out or with no portfolio (the public screener has no such
 * context). Since migration 070 a user may own several paper portfolios; the
 * screener's hidden panel reflects the primary (oldest) one, and the returned
 * `portfolioName` lets the UI say so.
 *
 * Read with the service-role client because the table is service-role only
 * (a rejection list can belong to a private portfolio, so it isn't world-
 * readable). Auth is resolved via the cookie-scoped SSR client first, then the
 * portfolio + rejections are read with the service key. Fail-open on error.
 */
export async function activeRejectionsForViewer(): Promise<{
  portfolioId: string | null;
  portfolioName: string | null;
  rejections: ScreenerRejection[];
}> {
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
  if (!userId) return { portfolioId: null, portfolioName: null, rejections: [] };

  const portfolio = await getPortfolioForUser(userId);
  if (!portfolio) {
    return { portfolioId: null, portfolioName: null, rejections: [] };
  }

  const { data, error } = await getSupabase()
    .from("screener_rejections")
    .select("ticker, rejected_at, expires_at, reason, conviction")
    .eq("portfolio_id", portfolio.id)
    .gt("expires_at", new Date().toISOString())
    .is("restored_at", null)
    .order("rejected_at", { ascending: false });
  if (error) {
    console.error("activeRejectionsForViewer failed:", error.message);
    return {
      portfolioId: portfolio.id,
      portfolioName: portfolio.display_name,
      rejections: [],
    };
  }
  return {
    portfolioId: portfolio.id,
    portfolioName: portfolio.display_name,
    rejections: (data ?? []) as ScreenerRejection[],
  };
}
