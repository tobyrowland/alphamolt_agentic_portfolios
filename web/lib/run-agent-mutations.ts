"use server";

/**
 * Server Actions for the per-portfolio "Run now" buttons on /account.
 *
 * Dispatches a one-off `agent-heartbeat.yml` workflow run against a
 * single (portfolio, agent) pair (`runAgent`) or every member of the
 * portfolio (`runAllAgents`). Hits GitHub's `workflow_dispatch` REST
 * endpoint with a server-side PAT; the running workflow journals each
 * member's rebalance into `agent_heartbeats` with
 * `notes.triggered_by = "manual"` so the UI can distinguish it from a
 * scheduled rebalance.
 *
 * Auth + ownership: mirrors `portfolios-mutations.ts` — `requireUser()`,
 * then a service-role read of the user's portfolio, then a service-role
 * membership / cooldown check before dispatching.
 */

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";
import { getPortfolioForUser, type Portfolio } from "@/lib/portfolios-query";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Per-(portfolio, agent) cooldown window. A click while we're still
// within this window returns a friendly "cool down" error rather than
// dispatching a duplicate workflow. Sized to span a typical heartbeat run
// (~5 mins for an LLM curator) so the button stays locked while the
// previous workflow is likely still running.
const COOLDOWN_SECONDS = 300;

interface ResolvedAgent {
  id: string;
  handle: string;
}

async function getPortfolioMemberByHandle(
  portfolioId: string,
  handle: string,
): Promise<ResolvedAgent | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolio_agents")
    .select("agents!inner(id, handle)")
    .eq("portfolio_id", portfolioId)
    .eq("agents.handle", handle.trim().toLowerCase())
    .maybeSingle();
  if (error) {
    console.error("getPortfolioMemberByHandle failed:", error);
    return null;
  }
  type Row = { agents: ResolvedAgent | ResolvedAgent[] | null };
  const row = (data as unknown as Row | null) ?? null;
  if (!row) return null;
  const a = Array.isArray(row.agents) ? row.agents[0] : row.agents;
  return a ?? null;
}

/**
 * Throttle: read the latest `agent_heartbeats` row for a given filter
 * and return how many seconds ago it started. `null` means none in the
 * cooldown window (caller can proceed).
 */
async function secondsSinceLastRun(filter: {
  portfolioId: string;
  agentIds?: string[];
}): Promise<number | null> {
  const supabase = getSupabase();
  let query = supabase
    .from("agent_heartbeats")
    .select("started_at, agent_id, notes")
    .eq("notes->>portfolio_id", filter.portfolioId)
    .order("started_at", { ascending: false })
    .limit(1);
  if (filter.agentIds && filter.agentIds.length > 0) {
    query = query.in("agent_id", filter.agentIds);
  }
  const { data, error } = await query;
  if (error) {
    // Fail-open on read errors — don't block a legitimate run on a
    // transient Postgres blip. Logged so it's surfaced in observability.
    console.error("secondsSinceLastRun failed:", error);
    return null;
  }
  const row = (data as { started_at: string }[] | null)?.[0];
  if (!row) return null;
  const startedAt = new Date(row.started_at).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const ageSec = (Date.now() - startedAt) / 1000;
  return ageSec >= 0 ? ageSec : null;
}

interface DispatchInputs {
  handle: string;
  portfolio: string;
  force: string;
  dry_run: string;
}

/**
 * POST to GitHub's `workflow_dispatch` for `agent-heartbeat.yml`. Returns
 * an `ActionResult`. A 204 No Content is the success path.
 */
async function dispatchHeartbeatWorkflow(
  inputs: DispatchInputs,
): Promise<ActionResult> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    console.error("GITHUB_DISPATCH_TOKEN is not set");
    return {
      ok: false,
      error: "Run-now is not configured on this server.",
    };
  }
  const owner = process.env.GITHUB_DISPATCH_OWNER || "tobyrowland";
  const repo = process.env.GITHUB_DISPATCH_REPO || "update_ai_analysis";
  const ref = process.env.GITHUB_DISPATCH_REF || "main";

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/agent-heartbeat.yml/dispatches`;

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
      // Don't cache — dispatch is a side-effecting POST.
      cache: "no-store",
    });
  } catch (err) {
    console.error("workflow_dispatch fetch failed:", err);
    return { ok: false, error: "Could not reach GitHub. Try again." };
  }

  if (response.status === 204) return { ok: true };

  // 404 here usually means "workflow file is missing on this ref" or
  // "token lacks actions:write" — surface the body for diagnostics.
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  console.error(
    `workflow_dispatch returned ${response.status}: ${body || "(empty)"}`,
  );
  return {
    ok: false,
    error: `GitHub returned ${response.status}: ${body || "no body"}`,
  };
}

async function loadOwnedPortfolio(): Promise<
  { ok: true; portfolio: Portfolio } | { ok: false; error: string }
> {
  const { user } = await requireUser();
  const portfolio = await getPortfolioForUser(user.id);
  if (!portfolio) {
    return { ok: false, error: "You don't have a portfolio yet." };
  }
  return { ok: true, portfolio };
}

/**
 * Dispatch a single-member rebalance for the caller's portfolio.
 *
 * The eligibility ladder (in order):
 *   1. signed in,
 *   2. owns a portfolio,
 *   3. the named agent is a member of THIS portfolio,
 *   4. no run for this (portfolio, agent) in the last cooldown window.
 */
export async function runAgent(input: {
  agentHandle: string;
  agentId?: string;
}): Promise<ActionResult> {
  const loaded = await loadOwnedPortfolio();
  if (!loaded.ok) return loaded;
  const portfolio = loaded.portfolio;

  const member = await getPortfolioMemberByHandle(
    portfolio.id,
    input.agentHandle,
  );
  if (!member) {
    return { ok: false, error: "That agent isn't on this portfolio." };
  }

  const ageSec = await secondsSinceLastRun({
    portfolioId: portfolio.id,
    agentIds: [member.id],
  });
  if (ageSec != null && ageSec < COOLDOWN_SECONDS) {
    return {
      ok: false,
      error: `Cool down — last run was ${Math.floor(ageSec)} seconds ago.`,
    };
  }

  const result = await dispatchHeartbeatWorkflow({
    handle: member.handle,
    portfolio: portfolio.slug,
    force: "true",
    dry_run: "false",
  });
  if (!result.ok) return result;

  revalidatePath("/account");
  return { ok: true };
}

/**
 * Dispatch a full-portfolio rebalance (no handle filter). Throttled on
 * the portfolio as a whole — if *any* member ran in the last cooldown
 * window the button rejects.
 */
export async function runAllAgents(): Promise<ActionResult> {
  const loaded = await loadOwnedPortfolio();
  if (!loaded.ok) return loaded;
  const portfolio = loaded.portfolio;

  const ageSec = await secondsSinceLastRun({ portfolioId: portfolio.id });
  if (ageSec != null && ageSec < COOLDOWN_SECONDS) {
    return {
      ok: false,
      error: `Cool down — last run was ${Math.floor(ageSec)} seconds ago.`,
    };
  }

  const result = await dispatchHeartbeatWorkflow({
    handle: "",
    portfolio: portfolio.slug,
    force: "true",
    dry_run: "false",
  });
  if (!result.ok) return result;

  revalidatePath("/account");
  return { ok: true };
}
