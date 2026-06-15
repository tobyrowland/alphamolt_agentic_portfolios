"use server";

/**
 * Server Action for the "Sync to Alpaca" button on a live portfolio.
 *
 * Dispatches the `live-mirror.yml` workflow with `action=mirror` for the
 * caller's LIVE follower portfolio — placing real buy/sell orders on their
 * Alpaca account to converge it onto the paper sibling's target weights (only
 * names that have drifted past the mirror's threshold). The routine path runs
 * this automatically (market-hours cron + the heartbeat's inline mirror); this
 * is the manual "do it now" trigger.
 *
 * Defense in depth: real orders only fire when the portfolio is mode='live'
 * AND ALPACA_LIVE_EXECUTION_ENABLED is set in the workflow env — so dispatching
 * against a portfolio that isn't truly live is a no-op on the real account.
 * We still gate the dispatch on owner + mode='live' here so the button never
 * fires for the wrong portfolio.
 */

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Confirm the portfolio is the caller's own LIVE follower, returning its slug.
 *  Scoped to owner_user_id + mode='live' so it can't resolve a paper book or
 *  someone else's portfolio. Service-role read on an owner-authenticated path. */
async function resolveOwnedLivePortfolio(
  portfolioId: string,
  userId: string,
): Promise<{ slug: string } | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .select("slug")
    .eq("id", portfolioId)
    .eq("owner_user_id", userId)
    .eq("mode", "live")
    .maybeSingle();
  if (error) {
    console.error("resolveOwnedLivePortfolio failed:", error);
    return null;
  }
  return (data as { slug: string } | null) ?? null;
}

/** POST to GitHub's `workflow_dispatch` for `live-mirror.yml`. 204 = success. */
async function dispatchLiveMirror(inputs: {
  action: string;
  slug: string;
  dry_run: string;
}): Promise<ActionResult> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    console.error("GITHUB_DISPATCH_TOKEN is not set");
    return { ok: false, error: "Live sync isn't configured on this server." };
  }
  const owner = process.env.GITHUB_DISPATCH_OWNER || "tobyrowland";
  const repo = process.env.GITHUB_DISPATCH_REPO || "update_ai_analysis";
  const ref = process.env.GITHUB_DISPATCH_REF || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/live-mirror.yml/dispatches`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref, inputs }),
      cache: "no-store",
    });
  } catch (err) {
    console.error("live-mirror dispatch fetch failed:", err);
    return { ok: false, error: "Could not reach GitHub. Try again." };
  }

  if (response.status === 204) return { ok: true };

  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  console.error(
    `live-mirror dispatch returned ${response.status}: ${body || "(empty)"}`,
  );
  return {
    ok: false,
    error: `GitHub returned ${response.status}: ${body || "no body"}`,
  };
}

/**
 * Trigger a real-money mirror of the caller's live portfolio onto Alpaca.
 * Eligibility: signed in → owns a portfolio with this id at mode='live'.
 */
export async function syncLivePortfolioToAlpaca(input: {
  portfolioId: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();

  const live = await resolveOwnedLivePortfolio(input.portfolioId, user.id);
  if (!live) {
    return { ok: false, error: "That isn't your live portfolio." };
  }

  // action=mirror: buy/sell only the names that have drifted past the mirror's
  // threshold so the real account converges on the paper book. dry_run=false so
  // it actually trades (still gated by ALPACA_LIVE_EXECUTION_ENABLED server-side).
  const result = await dispatchLiveMirror({
    action: "mirror",
    slug: live.slug,
    dry_run: "false",
  });
  if (!result.ok) return result;

  revalidatePath(`/portfolios/${live.slug}`);
  return { ok: true };
}
