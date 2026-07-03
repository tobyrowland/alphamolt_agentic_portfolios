"use server";

/**
 * Server action for the screener's per-portfolio rejection list (migration
 * 051): manually restore a name the owner's buyer passed on, so it shows on
 * the screener again and the buyer reconsiders it on its next run.
 *
 * Auth-gated (signed-in owner), resolve the target portfolio, then
 * service-role write — same verify-then-service-role pattern as the manual
 * exclusions. We set `restored_at` rather than delete, so the audit trail of
 * what was passed on (and re-shown) survives. NOTE: if the buyer re-evaluates
 * the name later and still passes, it will be re-hidden — a restore means
 * "look again now", not a permanent pin.
 *
 * Target resolution (migration 070 — a user may own several paper books):
 * an explicit `portfolioId` (the embedded per-portfolio screener) is
 * ownership-verified; without one, the primary (oldest) paper portfolio is
 * used — matching what the public /screener page shows.
 */

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";
import { getPortfolioForUser } from "@/lib/portfolios-query";

export type RejectionResult = { ok: true } | { ok: false; error: string };

/** The target portfolio's `{id, slug}` — explicit (ownership-verified) or the
 *  caller's primary paper book. Null when neither resolves. */
async function resolveTargetPortfolio(
  userId: string,
  portfolioId?: string,
): Promise<{ id: string; slug: string } | null> {
  if (portfolioId) {
    const { data, error } = await getSupabase()
      .from("portfolios")
      .select("id, slug")
      .eq("id", portfolioId)
      .eq("owner_user_id", userId)
      .maybeSingle();
    if (error) {
      console.error("resolveTargetPortfolio lookup failed:", error);
      return null;
    }
    return (data as { id: string; slug: string } | null) ?? null;
  }
  const portfolio = await getPortfolioForUser(userId);
  return portfolio ? { id: portfolio.id, slug: portfolio.slug } : null;
}

function revalidateScreens(slug: string): void {
  revalidatePath("/screener");
  revalidatePath(`/portfolios/${slug}`);
}

export async function restoreRejection(
  ticker: string,
  portfolioId?: string,
): Promise<RejectionResult> {
  const { user } = await requireUser();
  const t = ticker.trim().toUpperCase();
  if (!t) return { ok: false, error: "Ticker required." };

  const portfolio = await resolveTargetPortfolio(user.id, portfolioId);
  if (!portfolio) {
    return { ok: false, error: "No portfolio to restore into." };
  }

  const { error } = await getSupabase()
    .from("screener_rejections")
    .update({ restored_at: new Date().toISOString() })
    .eq("portfolio_id", portfolio.id)
    .eq("ticker", t);
  if (error) {
    console.error("restoreRejection failed:", error);
    return { ok: false, error: "Could not restore it. Try again." };
  }
  revalidateScreens(portfolio.slug);
  return { ok: true };
}

/**
 * Bulk-restore every name the owner's buyer auto-passed on (the 90-day hides),
 * in one shot. Clears only `screener_rejections` — manual `screener_exclusions`
 * are deliberate and left untouched. Same auth → portfolio → service-role
 * pattern as `restoreRejection`; sets `restored_at` (soft restore, audit trail
 * preserved) on the portfolio's open, unexpired rows.
 */
export async function restoreAllRejections(
  portfolioId?: string,
): Promise<RejectionResult> {
  const { user } = await requireUser();

  const portfolio = await resolveTargetPortfolio(user.id, portfolioId);
  if (!portfolio) {
    return { ok: false, error: "No portfolio to restore into." };
  }

  const { error } = await getSupabase()
    .from("screener_rejections")
    .update({ restored_at: new Date().toISOString() })
    .eq("portfolio_id", portfolio.id)
    .is("restored_at", null)
    .gt("expires_at", new Date().toISOString());
  if (error) {
    console.error("restoreAllRejections failed:", error);
    return { ok: false, error: "Could not restore them. Try again." };
  }
  revalidateScreens(portfolio.slug);
  return { ok: true };
}
