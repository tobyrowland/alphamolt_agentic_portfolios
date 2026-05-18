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
import { roleFor } from "@/lib/agent-roles";

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
  const { error } = await supabase.from("portfolios").insert({
    slug,
    display_name: displayName,
    description: mandate || null,
    owner_user_id: user.id,
    owner_agent_id: null,
    is_public: true,
  });

  if (error) {
    // 23505 here is almost certainly the one-portfolio-per-user partial index.
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
    console.error("setPortfolioVisibility failed:", error);
    return { ok: false, error: "Could not update visibility. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}

export async function launchPortfolio(): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await getOwnedPortfolio(user.id);
  if (!portfolio) return { ok: false, error: "You don't have a portfolio yet." };

  const supabase = getSupabase();

  // Role gate: a launchable portfolio needs both a shortlist builder
  // (curate phase) and a buying agent (trade phase). Resolve the members'
  // strategies and check before spending the launch RPC.
  const { data: memberRows } = await supabase
    .from("portfolio_agents")
    .select("agents (strategy)")
    .eq("portfolio_id", portfolio.id);
  type StratRow = { agents: { strategy: string | null } | { strategy: string | null }[] | null };
  const phases = ((memberRows as unknown as StratRow[] | null) ?? []).map((r) => {
    const a = Array.isArray(r.agents) ? r.agents[0] : r.agents;
    return roleFor(a?.strategy ?? null).phase;
  });
  const hasCurator = phases.includes("curate");
  const hasBuyer = phases.includes("trade");
  if (!hasCurator || !hasBuyer) {
    return {
      ok: false,
      error: "Add a Shortlist Builder and a Buying Agent before going live.",
    };
  }

  const { data, error } = await supabase.rpc("launch_portfolio", {
    p_portfolio_id: portfolio.id,
  });

  if (error) {
    console.error("launchPortfolio failed:", error);
    return { ok: false, error: "Could not launch the portfolio. Try again." };
  }

  const status = (data as { status?: string } | null)?.status;
  if (status === "no_members") {
    return {
      ok: false,
      error: "Add at least one agent before going live.",
    };
  }
  // "ok" and "already_launched" both leave the portfolio live.

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
