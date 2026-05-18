"use server";

/**
 * Server Actions for a signed-in human curating their portfolio's
 * watchlist (migration 027).
 *
 * Same auth model as portfolios-mutations.ts: verify the SSR cookie
 * session owns the portfolio, then write with the service-role client.
 */

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";

export type ActionResult = { ok: true } | { ok: false; error: string };

const MAX_RATIONALE = 280;

/** The caller's single portfolio id, or null. Service-role read. */
async function getOwnedPortfolioId(userId: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("portfolios")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function addToWatchlist(input: {
  ticker: string;
  rationale?: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolioId = await getOwnedPortfolioId(user.id);
  if (!portfolioId) {
    return { ok: false, error: "You don't have a portfolio yet." };
  }

  const ticker = input.ticker.trim().toUpperCase();
  if (!ticker) return { ok: false, error: "Enter a ticker symbol." };

  const rationale = (input.rationale ?? "").trim();
  if (rationale.length > MAX_RATIONALE) {
    return {
      ok: false,
      error: `Note must be ${MAX_RATIONALE} characters or fewer.`,
    };
  }

  const supabase = getSupabase();

  // The ticker must exist in the screened universe — the FK would reject
  // an unknown ticker anyway, but checking first gives a clean message.
  const { data: company } = await supabase
    .from("companies")
    .select("ticker")
    .eq("ticker", ticker)
    .maybeSingle();
  if (!company) {
    return {
      ok: false,
      error: `“${ticker}” isn't in the equity universe.`,
    };
  }

  // Upsert so re-adding a ticker updates its note rather than erroring.
  const { error } = await supabase.from("portfolio_watchlist").upsert(
    {
      portfolio_id: portfolioId,
      ticker,
      source: "user",
      rationale: rationale || null,
    },
    { onConflict: "portfolio_id,ticker" },
  );
  if (error) {
    console.error("addToWatchlist failed:", error);
    return { ok: false, error: "Could not add to the watchlist. Try again." };
  }

  revalidatePath("/account/watchlist");
  return { ok: true };
}

export async function removeFromWatchlist(input: {
  ticker: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolioId = await getOwnedPortfolioId(user.id);
  if (!portfolioId) {
    return { ok: false, error: "You don't have a portfolio yet." };
  }

  const ticker = input.ticker.trim().toUpperCase();
  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolio_watchlist")
    .delete()
    .eq("portfolio_id", portfolioId)
    .eq("ticker", ticker);
  if (error) {
    console.error("removeFromWatchlist failed:", error);
    return {
      ok: false,
      error: "Could not remove from the watchlist. Try again.",
    };
  }

  revalidatePath("/account/watchlist");
  return { ok: true };
}
