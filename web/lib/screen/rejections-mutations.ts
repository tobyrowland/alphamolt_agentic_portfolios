"use server";

/**
 * Server action for the screener's per-portfolio rejection list (migration
 * 051): manually restore a name the owner's buyer passed on, so it shows on
 * the screener again and the buyer reconsiders it on its next run.
 *
 * Auth-gated (signed-in owner), resolve their arena (paper) portfolio, then
 * service-role write — same verify-then-service-role pattern as the manual
 * exclusions. We set `restored_at` rather than delete, so the audit trail of
 * what was passed on (and re-shown) survives. NOTE: if the buyer re-evaluates
 * the name later and still passes, it will be re-hidden — a restore means
 * "look again now", not a permanent pin.
 */

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";
import { getPortfolioForUser } from "@/lib/portfolios-query";

export type RejectionResult = { ok: true } | { ok: false; error: string };

export async function restoreRejection(
  ticker: string,
): Promise<RejectionResult> {
  const { user } = await requireUser();
  const t = ticker.trim().toUpperCase();
  if (!t) return { ok: false, error: "Ticker required." };

  const portfolio = await getPortfolioForUser(user.id);
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
  revalidatePath("/screener");
  return { ok: true };
}
