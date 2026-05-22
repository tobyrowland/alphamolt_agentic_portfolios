"use server";

/**
 * Server Actions for a signed-in human managing their one portfolio.
 *
 * Auth model: the SSR cookie session (a `profiles` user), NOT an agent API
 * key — distinct from the `/api/v1/...` routes. Each action verifies the
 * caller owns the portfolio, then writes with the service-role client,
 * mirroring the codebase's verify-then-service-role convention.
 */

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";
import { uniquePortfolioSlug } from "@/lib/slug";

export type ActionResult = { ok: true } | { ok: false; error: string };

const MAX_NAME = 80;
const MAX_MANDATE = 2000;

interface OwnedPortfolio {
  id: string;
  slug: string;
}

/** The caller's single portfolio, or null. Service-role read. */
async function getOwnedPortfolio(userId: string): Promise<OwnedPortfolio | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("portfolios")
    .select("id, slug")
    .eq("owner_user_id", userId)
    .maybeSingle();
  return (data as OwnedPortfolio | null) ?? null;
}

function revalidate(slug: string): void {
  revalidatePath("/account");
  revalidatePath(`/portfolios/${slug}`);
}

export async function createPortfolio(input: {
  displayName: string;
  mandate: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const displayName = input.displayName.trim();
  const mandate = input.mandate.trim();

  if (!displayName) return { ok: false, error: "Portfolio name is required." };
  if (displayName.length > MAX_NAME)
    return { ok: false, error: `Name must be ${MAX_NAME} characters or fewer.` };
  if (mandate.length > MAX_MANDATE)
    return {
      ok: false,
      error: `Mandate must be ${MAX_MANDATE} characters or fewer.`,
    };

  if (await getOwnedPortfolio(user.id)) {
    return { ok: false, error: "You already have a portfolio." };
  }

  const supabase = getSupabase();
  const slug = await uniquePortfolioSlug(displayName);

  // Atomic creation: inserts the portfolios row + seeds the $1M
  // portfolio_accounts row in one transaction. The RPC sets is_public=false
  // (migration 031 default). Replaces the old two-step insert + launch flow.
  const { error } = await supabase.rpc("create_portfolio_funded", {
    p_owner_user_id: user.id,
    p_slug: slug,
    p_display_name: displayName,
    p_description: mandate || null,
  });

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "You already have a portfolio." };
    }
    console.error("createPortfolio failed:", error);
    return { ok: false, error: "Could not create the portfolio. Try again." };
  }

  revalidate(slug);
  return { ok: true };
}

export async function updatePortfolioDetails(input: {
  name: string;
  mandate: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const name = input.name.trim();
  const mandate = input.mandate.trim();

  if (!name) return { ok: false, error: "Portfolio name is required." };
  if (name.length > MAX_NAME)
    return { ok: false, error: `Name must be ${MAX_NAME} characters or fewer.` };
  if (mandate.length > MAX_MANDATE)
    return {
      ok: false,
      error: `Mandate must be ${MAX_MANDATE} characters or fewer.`,
    };

  const portfolio = await getOwnedPortfolio(user.id);
  if (!portfolio) return { ok: false, error: "You don't have a portfolio yet." };

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolios")
    .update({ display_name: name, description: mandate || null })
    .eq("id", portfolio.id)
    .eq("owner_user_id", user.id);

  if (error) {
    console.error("updatePortfolioDetails failed:", error);
    return { ok: false, error: "Could not save changes. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}

export async function updatePortfolioBuyMandate(input: {
  buyMandate: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const buyMandate = input.buyMandate.trim();

  if (buyMandate.length > MAX_MANDATE)
    return {
      ok: false,
      error: `Buy mandate must be ${MAX_MANDATE} characters or fewer.`,
    };

  const portfolio = await getOwnedPortfolio(user.id);
  if (!portfolio) return { ok: false, error: "You don't have a portfolio yet." };

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolios")
    .update({ buy_mandate: buyMandate || null })
    .eq("id", portfolio.id)
    .eq("owner_user_id", user.id);

  if (error) {
    console.error("updatePortfolioBuyMandate failed:", error);
    return { ok: false, error: "Could not save changes. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}

export async function setPortfolioVisibility(input: {
  isPublic: boolean;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await getOwnedPortfolio(user.id);
  if (!portfolio) return { ok: false, error: "You don't have a portfolio yet." };

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolios")
    .update({ is_public: input.isPublic })
    .eq("id", portfolio.id)
    .eq("owner_user_id", user.id);

  if (error) {
    // Migration 031's `enforce_portfolio_public_threshold` trigger refuses
    // false->true flips when the portfolio holds <15 equities.
    if (
      error.code === "23514" ||
      /needs >= 15/.test(error.message ?? "")
    ) {
      return {
        ok: false,
        error: "Hold at least 15 equities to flip public.",
      };
    }
    console.error("setPortfolioVisibility failed:", error);
    return { ok: false, error: "Could not update visibility. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}

interface ResolvedAgent {
  id: string;
  available_for_hire: boolean;
}

async function resolveAgent(handle: string): Promise<ResolvedAgent | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("agents")
    .select("id, available_for_hire")
    .eq("handle", handle.trim().toLowerCase())
    .maybeSingle();
  return (data as ResolvedAgent | null) ?? null;
}

export async function addAgentToPortfolio(input: {
  handle: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await getOwnedPortfolio(user.id);
  if (!portfolio) return { ok: false, error: "You don't have a portfolio yet." };

  const agent = await resolveAgent(input.handle);
  if (!agent) return { ok: false, error: "That agent no longer exists." };
  if (!agent.available_for_hire) {
    return {
      ok: false,
      error: "That agent hasn't opted in to being added to portfolios.",
    };
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolio_agents")
    .upsert(
      { portfolio_id: portfolio.id, agent_id: agent.id },
      { onConflict: "portfolio_id,agent_id", ignoreDuplicates: true },
    );

  if (error) {
    console.error("addAgentToPortfolio failed:", error);
    return { ok: false, error: "Could not add the agent. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}

export async function removeAgentFromPortfolio(input: {
  handle: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await getOwnedPortfolio(user.id);
  if (!portfolio) return { ok: false, error: "You don't have a portfolio yet." };

  const agent = await resolveAgent(input.handle);
  if (!agent) {
    // Already gone — treat as success so the UI settles.
    revalidate(portfolio.slug);
    return { ok: true };
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolio_agents")
    .delete()
    .eq("portfolio_id", portfolio.id)
    .eq("agent_id", agent.id);

  if (error) {
    console.error("removeAgentFromPortfolio failed:", error);
    return { ok: false, error: "Could not remove the agent. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}
