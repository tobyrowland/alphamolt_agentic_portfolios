"use server";

/**
 * Server Actions for a signed-in human managing their portfolios (up to
 * MAX_PAPER_PORTFOLIOS paper books since migration 070).
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
import { PRESETS, DEFAULT_PRESET, presetConfig } from "@/lib/screen/config";
import { MAX_PAPER_PORTFOLIOS } from "@/lib/portfolios-query";

export type ActionResult = { ok: true } | { ok: false; error: string };

const MAX_NAME = 80;
const MAX_MANDATE = 2000;

/** How many paper (arena) portfolios the caller already owns. Service-role
 *  read, scoped to `mode='paper'` so the private live follower doesn't
 *  count. The friendly half of the cap — the RPC enforces it for real. */
async function countOwnedPaperPortfolios(userId: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("portfolios")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", userId)
    .eq("mode", "paper");
  if (error) {
    console.error("countOwnedPaperPortfolios lookup failed:", error);
    return 0;
  }
  return count ?? 0;
}

/**
 * Verify that `portfolioId` belongs to `userId` and return its slug.
 * Single query, no race window — replaces the pre-write
 * `getOwnedPortfolio(user.id)` lookup that previously surfaced as "You
 * don't have a portfolio yet" when it transiently failed. The DB error
 * case is logged so server logs separate "ownership mismatch" from
 * "DB error" instead of both rendering as the same red banner.
 */
async function resolveOwnedPortfolio(
  portfolioId: string,
  userId: string,
): Promise<{ slug: string } | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .select("slug")
    .eq("id", portfolioId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("resolveOwnedPortfolio lookup failed:", error);
    return null;
  }
  return (data as { slug: string } | null) ?? null;
}

const NOT_FOUND_ERROR =
  "Couldn't find your portfolio. Refresh the page and try again.";

function revalidate(slug: string): void {
  revalidatePath("/account");
  revalidatePath(`/portfolios/${slug}`);
}

export async function createPortfolio(input: {
  displayName: string;
  mandate: string;
  /** House universe preset (onboarding brief §3). Defaults, never blocks. */
  presetId?: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const displayName = input.displayName.trim();
  const mandate = input.mandate.trim();

  if (!displayName) return { ok: false, error: "Portfolio name is required." };
  if (displayName.length > MAX_NAME)
    return { ok: false, error: `Name must be ${MAX_NAME} characters or fewer.` };
  // The mandate is the one real decision onboarding asks for (brief §2): it's
  // the brief the team trades to, so it's required — no silent empty portfolio.
  if (!mandate)
    return {
      ok: false,
      error: "Write a one-line mandate — it's the brief your team trades to.",
    };
  if (mandate.length > MAX_MANDATE)
    return {
      ok: false,
      error: `Mandate must be ${MAX_MANDATE} characters or fewer.`,
    };

  const capError = `You've hit the limit of ${MAX_PAPER_PORTFOLIOS} paper portfolios.`;
  if ((await countOwnedPaperPortfolios(user.id)) >= MAX_PAPER_PORTFOLIOS) {
    return { ok: false, error: capError };
  }

  const supabase = getSupabase();
  const slug = await uniquePortfolioSlug(displayName);

  // Atomic creation: inserts the portfolios row + seeds the $1M
  // portfolio_accounts row in one transaction. The RPC sets is_public=false
  // (migration 031 default) and enforces the paper cap (migration 070).
  const { data: created, error } = await supabase.rpc("create_portfolio_funded", {
    p_owner_user_id: user.id,
    p_slug: slug,
    p_display_name: displayName,
    p_description: mandate || null,
  });

  if (error) {
    if (
      error.code === "23514" ||
      /portfolio limit/i.test(error.message ?? "")
    ) {
      return { ok: false, error: capError };
    }
    console.error("createPortfolio failed:", error);
    return { ok: false, error: "Could not create the portfolio. Try again." };
  }

  // Attach the universe (brief §3) — a best-effort follow-up: the portfolio
  // (and its $1M book) already exists, so a hiccup here leaves an editable
  // default, never a failed creation. The RPC returns the new row's id.
  const createdId = (created as { id?: string } | null)?.id;
  if (createdId) {
    const presetId =
      input.presetId && PRESETS[input.presetId] ? input.presetId : DEFAULT_PRESET;
    const { error: cfgErr } = await supabase
      .from("portfolios")
      .update({ screen_config: presetConfig(presetId) })
      .eq("id", createdId);
    if (cfgErr) console.error("createPortfolio: set universe failed:", cfgErr);

    // No default roster: the team builder (brief v2) starts empty so the owner
    // drags their first agent in. Each save deploys that agent live.
  }

  revalidate(slug);
  return { ok: true };
}

export async function updatePortfolioDetails(input: {
  portfolioId: string;
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

  // Single update with the ownership check in the WHERE clause — no
  // separate lookup, no race window. If the row doesn't exist or this
  // user doesn't own it, `data` comes back null.
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .update({ display_name: name, description: mandate || null })
    .eq("id", input.portfolioId)
    .eq("owner_user_id", user.id)
    .select("slug")
    .maybeSingle();

  if (error) {
    console.error("updatePortfolioDetails failed:", error);
    return { ok: false, error: "Could not save changes. Try again." };
  }
  if (!data) {
    return {
      ok: false,
      error:
        "Couldn't find your portfolio. Refresh the page and try again.",
    };
  }

  revalidate(data.slug);
  return { ok: true };
}

/**
 * Owner-initiated full-position sell from the portfolio detail page.
 * Uses the `execute_portfolio_sell` RPC for atomicity (cash credit +
 * holding delete + trade-journal insert happen in one Postgres
 * transaction). Attributes the trade to the `manual` house agent
 * (migration 035) so the trade tape shows "[Manual] SOLD X" rather
 * than misattributing to a real autonomous agent.
 *
 * After a successful sell, any active investment_theses row for the
 * position is closed — preserving terminal statuses (broken/improved)
 * is handled by `close_theses_for_position`'s active-only filter, but
 * we update here directly since the Python flow isn't on the path.
 *
 * The buyer's 90-day re-buy cooldown picks this up automatically (it
 * queries `agent_trades` for recent sells), so the ticker won't be
 * re-considered for purchase by either the LLM buyer or the
 * mechanical `watchlist_buyer` for the next 90 days.
 */
export async function sellHolding(input: {
  portfolioId: string;
  ticker: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const ticker = input.ticker.trim().toUpperCase();
  if (!ticker) return { ok: false, error: "Ticker is required." };

  const portfolio = await resolveOwnedPortfolio(input.portfolioId, user.id);
  if (!portfolio) return { ok: false, error: NOT_FOUND_ERROR };

  const supabase = getSupabase();

  // Look up the current holding's quantity.
  const { data: holding, error: holdingErr } = await supabase
    .from("portfolio_holdings")
    .select("quantity")
    .eq("portfolio_id", input.portfolioId)
    .eq("ticker", ticker)
    .maybeSingle();
  if (holdingErr) {
    console.error("sellHolding: holding lookup failed:", holdingErr);
    return { ok: false, error: "Could not load the position. Try again." };
  }
  if (!holding) {
    return { ok: false, error: `You don't hold ${ticker}.` };
  }
  const quantity = Number((holding as { quantity: number | string }).quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, error: "Position quantity is zero or invalid." };
  }

  // Latest price from the Level 0 price home (`securities.price`, migration
  // 058 — 15-min delayed during market hours, close-of-business otherwise).
  const { data: company, error: companyErr } = await supabase
    .from("securities")
    .select("price")
    .eq("ticker", ticker)
    .maybeSingle();
  if (companyErr) {
    console.error("sellHolding: price lookup failed:", companyErr);
    return { ok: false, error: "Could not load the latest price." };
  }
  const price = Number((company as { price: number | string } | null)?.price);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      ok: false,
      error: `No current price on file for ${ticker}. Try again later.`,
    };
  }

  // Manual house agent (migration 035) — placeholder for owner trades.
  const { data: manual, error: manualErr } = await supabase
    .from("agents")
    .select("id")
    .eq("handle", "manual")
    .maybeSingle();
  if (manualErr || !manual) {
    console.error("sellHolding: manual agent lookup failed:", manualErr);
    return {
      ok: false,
      error:
        "Manual-trade agent not found. Apply migration 035 then retry.",
    };
  }
  const manualAgentId = (manual as { id: string }).id;

  // Atomic sell: cash credit + holding delete + agent_trades journal,
  // all in one Postgres transaction.
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "execute_portfolio_sell",
    {
      p_portfolio_id: input.portfolioId,
      p_agent_id: manualAgentId,
      p_ticker: ticker,
      p_quantity: quantity,
      p_price_usd: Math.round(price * 10000) / 10000,
      p_note: "owner-initiated full sell",
    },
  );
  if (rpcErr) {
    console.error("sellHolding: execute_portfolio_sell failed:", rpcErr);
    return { ok: false, error: "Sell failed. Try again." };
  }
  const status = (rpcData as { status?: string } | null)?.status;
  if (status !== "ok") {
    return {
      ok: false,
      error: `Sell rejected: ${status ?? "unknown error"}`,
    };
  }

  // Position is fully exited — close any active investment_theses row.
  // Terminal statuses (broken/improved/superseded) stay as they are;
  // the .eq("status", "active") filter mirrors
  // theses.close_theses_for_position.
  await supabase
    .from("investment_theses")
    .update({
      status: "closed",
      status_changed_at: new Date().toISOString(),
      closed_at: new Date().toISOString(),
    })
    .eq("portfolio_id", input.portfolioId)
    .eq("ticker", ticker)
    .eq("status", "active");

  revalidate(portfolio.slug);
  return { ok: true };
}

export async function setPortfolioVisibility(input: {
  portfolioId: string;
  isPublic: boolean;
}): Promise<ActionResult> {
  const { user } = await requireUser();

  // Single update with ownership in the WHERE clause — no pre-write
  // lookup. `data` returns null on either ownership mismatch or no row.
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .update({ is_public: input.isPublic })
    .eq("id", input.portfolioId)
    .eq("owner_user_id", user.id)
    .select("slug")
    .maybeSingle();

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
  if (!data) return { ok: false, error: NOT_FOUND_ERROR };

  revalidate(data.slug);
  return { ok: true };
}

/**
 * Owner control for how often the heartbeat re-evaluates the portfolio
 * (migration 051): 'daily' (24h) or 'weekly' (168h, default). Mirrors
 * setPortfolioVisibility — single update with the ownership check in the
 * WHERE clause, no pre-write lookup.
 */
export async function setPortfolioRebalanceCadence(input: {
  portfolioId: string;
  cadence: "daily" | "weekly";
}): Promise<ActionResult> {
  const { user } = await requireUser();

  if (input.cadence !== "daily" && input.cadence !== "weekly") {
    return { ok: false, error: "Cadence must be daily or weekly." };
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .update({ rebalance_cadence: input.cadence })
    .eq("id", input.portfolioId)
    .eq("owner_user_id", user.id)
    .select("slug")
    .maybeSingle();

  if (error) {
    console.error("setPortfolioRebalanceCadence failed:", error);
    return { ok: false, error: "Could not update rebalance cadence. Try again." };
  }
  if (!data) return { ok: false, error: NOT_FOUND_ERROR };

  revalidate(data.slug);
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
  portfolioId: string;
  handle: string;
  // Swarm membership (migration 041): scout an agent in as a buyer or
  // reviewer with a free-text remit + per-member knobs.
  role?: "buyer" | "reviewer";
  remit?: string;
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await resolveOwnedPortfolio(input.portfolioId, user.id);
  if (!portfolio) return { ok: false, error: NOT_FOUND_ERROR };

  const agent = await resolveAgent(input.handle);
  if (!agent) return { ok: false, error: "That agent no longer exists." };
  if (!agent.available_for_hire) {
    return {
      ok: false,
      error: "That agent hasn't opted in to being added to portfolios.",
    };
  }

  const row: Record<string, unknown> = {
    portfolio_id: input.portfolioId,
    agent_id: agent.id,
  };
  if (input.role) row.role = input.role;
  if (input.remit !== undefined) row.remit = input.remit;
  if (input.config !== undefined) row.config = input.config;

  const supabase = getSupabase();
  // upsert (not ignoreDuplicates) so re-adding updates the role/remit/knobs.
  const { error } = await supabase
    .from("portfolio_agents")
    .upsert(row, { onConflict: "portfolio_id,agent_id" });

  if (error) {
    console.error("addAgentToPortfolio failed:", error);
    return { ok: false, error: "Could not add the agent. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}

/** Update a member's swarm role / remit / knobs (config-in-place). */
export async function setMemberSwarmConfig(input: {
  portfolioId: string;
  handle: string;
  role?: "buyer" | "reviewer" | null;
  remit?: string | null;
  config?: Record<string, unknown> | null;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await resolveOwnedPortfolio(input.portfolioId, user.id);
  if (!portfolio) return { ok: false, error: NOT_FOUND_ERROR };

  const agent = await resolveAgent(input.handle);
  if (!agent) return { ok: false, error: "That agent no longer exists." };

  const patch: Record<string, unknown> = {};
  if (input.role !== undefined) patch.role = input.role;
  if (input.remit !== undefined) patch.remit = input.remit;
  if (input.config !== undefined) patch.config = input.config;
  if (Object.keys(patch).length === 0) return { ok: true };

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolio_agents")
    .update(patch)
    .eq("portfolio_id", input.portfolioId)
    .eq("agent_id", agent.id);
  if (error) {
    console.error("setMemberSwarmConfig failed:", error);
    return { ok: false, error: "Could not update the agent. Try again." };
  }
  revalidate(portfolio.slug);
  return { ok: true };
}

// ---- Team builder (migration 045) ----------------------------------------
//
// The new portfolio page is a team builder: drag a library agent in, tune its
// 1-2 params, and Save — which deploys it (inserts the portfolio_agents row).
// There is no batch deploy. `enabled` is the per-agent Run/Stop switch; edits
// to params after save are live (a plain update, no re-deploy).

/** A library action maps to the heartbeat role the coordination engine reads. */
const ROLE_FOR_ACTION: Record<string, "buyer" | "reviewer" | "manager"> = {
  buy: "buyer",
  sell: "reviewer",
  manage: "manager",
};

interface ResolvedLibraryAgent {
  id: string;
  available_for_hire: boolean;
  action: string | null;
}

async function resolveLibraryAgent(
  handle: string,
): Promise<ResolvedLibraryAgent | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("agents")
    .select("id, available_for_hire, action")
    .eq("handle", handle.trim().toLowerCase())
    .maybeSingle();
  return (data as ResolvedLibraryAgent | null) ?? null;
}

/**
 * Save (deploy) a library agent onto the team. Saving is deploying — the row
 * is inserted live and the agent begins trading on the next heartbeat. Re-save
 * updates the config in place (upsert). `params` are the tuned control values,
 * stored flat in `config` so the heartbeat merges them into the strategy's
 * params exactly like `agents.config`.
 */
export async function saveTeamAgent(input: {
  portfolioId: string;
  handle: string;
  params: Record<string, number | string>;
  /** Per-instance brief override (migration 046). null = track the agent
   *  default; the client passes null when the text equals the default. */
  mandate?: string | null;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await resolveOwnedPortfolio(input.portfolioId, user.id);
  if (!portfolio) return { ok: false, error: NOT_FOUND_ERROR };

  const agent = await resolveLibraryAgent(input.handle);
  if (!agent) return { ok: false, error: "That agent no longer exists." };
  if (!agent.action) {
    return { ok: false, error: "That agent isn't a team-builder agent." };
  }
  if (!agent.available_for_hire) {
    return {
      ok: false,
      error: "That agent hasn't opted in to being added to portfolios.",
    };
  }

  const supabase = getSupabase();
  const { error } = await supabase.from("portfolio_agents").upsert(
    {
      portfolio_id: input.portfolioId,
      agent_id: agent.id,
      role: ROLE_FOR_ACTION[agent.action] ?? null,
      config: input.params ?? {},
      mandate: normalizeMandate(input.mandate),
      enabled: true,
    },
    { onConflict: "portfolio_id,agent_id" },
  );
  if (error) {
    console.error("saveTeamAgent failed:", error);
    return { ok: false, error: "Could not save the agent. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}

/** Trim a brief to null/text — empty string collapses to null (track default). */
function normalizeMandate(mandate: string | null | undefined): string | null {
  if (mandate === undefined || mandate === null) return null;
  const trimmed = mandate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Live edit of a saved agent's params + brief (no re-deploy — brief §4). */
export async function updateTeamAgentParams(input: {
  portfolioId: string;
  handle: string;
  params: Record<string, number | string>;
  /** Per-instance brief override (migration 046). null = track the default. */
  mandate?: string | null;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await resolveOwnedPortfolio(input.portfolioId, user.id);
  if (!portfolio) return { ok: false, error: NOT_FOUND_ERROR };

  const agent = await resolveAgent(input.handle);
  if (!agent) return { ok: false, error: "That agent no longer exists." };

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolio_agents")
    .update({ config: input.params ?? {}, mandate: normalizeMandate(input.mandate) })
    .eq("portfolio_id", input.portfolioId)
    .eq("agent_id", agent.id);
  if (error) {
    console.error("updateTeamAgentParams failed:", error);
    return { ok: false, error: "Could not save changes. Try again." };
  }
  revalidate(portfolio.slug);
  return { ok: true };
}

/** Run/Stop a single team agent (it stays on the roster either way). */
export async function setTeamAgentEnabled(input: {
  portfolioId: string;
  handle: string;
  enabled: boolean;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await resolveOwnedPortfolio(input.portfolioId, user.id);
  if (!portfolio) return { ok: false, error: NOT_FOUND_ERROR };

  const agent = await resolveAgent(input.handle);
  if (!agent) return { ok: false, error: "That agent no longer exists." };

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolio_agents")
    .update({ enabled: input.enabled })
    .eq("portfolio_id", input.portfolioId)
    .eq("agent_id", agent.id);
  if (error) {
    console.error("setTeamAgentEnabled failed:", error);
    return { ok: false, error: "Could not update the agent. Try again." };
  }
  revalidate(portfolio.slug);
  return { ok: true };
}

export async function removeAgentFromPortfolio(input: {
  portfolioId: string;
  handle: string;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const portfolio = await resolveOwnedPortfolio(input.portfolioId, user.id);
  if (!portfolio) return { ok: false, error: NOT_FOUND_ERROR };

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
    .eq("portfolio_id", input.portfolioId)
    .eq("agent_id", agent.id);

  if (error) {
    console.error("removeAgentFromPortfolio failed:", error);
    return { ok: false, error: "Could not remove the agent. Try again." };
  }

  revalidate(portfolio.slug);
  return { ok: true };
}
