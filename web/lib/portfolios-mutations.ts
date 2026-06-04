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

/** The caller's arena (paper) portfolio, or null. Service-role read.
 *
 * Scoped to `mode='paper'` because since migration 037 a user may also own
 * a private live follower; a bare `owner_user_id` lookup would match two
 * rows and make `.maybeSingle()` error. Used as the "you already have a
 * portfolio" guard in createPortfolio, which creates the paper book. */
async function getOwnedPortfolio(userId: string): Promise<OwnedPortfolio | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .select("id, slug")
    .eq("owner_user_id", userId)
    .eq("mode", "paper")
    .maybeSingle();
  if (error) {
    // Don't swallow — a transient DB error here previously surfaced as
    // "You don't have a portfolio yet" in the UI, which is wrong and
    // confusing. Bubble it up via logs so we can tell the two apart.
    console.error("getOwnedPortfolio lookup failed:", error);
    return null;
  }
  return (data as OwnedPortfolio | null) ?? null;
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

  // Latest price from companies.price (15-min delayed during market
  // hours, close-of-business otherwise — see intraday_prices.py).
  const { data: company, error: companyErr } = await supabase
    .from("companies")
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

  const supabase = getSupabase();
  const { error } = await supabase
    .from("portfolio_agents")
    .upsert(
      { portfolio_id: input.portfolioId, agent_id: agent.id },
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
