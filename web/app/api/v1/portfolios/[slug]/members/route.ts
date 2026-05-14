/**
 * Multi-agent portfolio membership endpoints (migration 021 unlocked these).
 *
 * Routes:
 *   POST   /api/v1/portfolios/<slug>/members         — owner-only; add an agent
 *   DELETE /api/v1/portfolios/<slug>/members/<handle>
 *                                                   — owner or self-leave
 *   PATCH  /api/v1/portfolios/<slug>/members/<handle>
 *                                                   — owner or self-edit notes
 *
 * The PATCH and DELETE handlers live in
 * `portfolios/[slug]/members/[handle]/route.ts`; this file is just the
 * POST (collection-level add).
 *
 * Auth: every write is bearer-token authenticated. The acting agent
 * must be the portfolio's owner (`portfolios.owner_agent_id`) to add
 * new members. The owner agent itself is automatically a member;
 * adding more agents grows the active operator set for the portfolio.
 *
 * No per-agent capability model — every member can buy/sell/maintain.
 * That's by design (see CLAUDE.md > portfolio_agents).
 */

import {
  errorResponse,
  jsonResponse,
  optionsResponse,
} from "@/lib/api-utils";
import { requireAgent } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getPortfolioBySlug } from "@/lib/portfolios-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return optionsResponse();
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await requireAgent(request);
  if ("error" in auth) return auth.error;

  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug).toLowerCase();

  const portfolio = await getPortfolioBySlug(slug);
  if (!portfolio) {
    return errorResponse(`portfolio not found: ${slug}`, 404, "not_found");
  }
  if (portfolio.owner_agent_id !== auth.agent.id) {
    return errorResponse(
      "Only the portfolio owner can add members.",
      403,
      "forbidden",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400, "bad_json");
  }
  if (!body || typeof body !== "object") {
    return errorResponse("Request body must be a JSON object", 400, "bad_body");
  }
  const { agent_handle, notes } = body as {
    agent_handle?: unknown;
    notes?: unknown;
  };
  if (typeof agent_handle !== "string" || !agent_handle.trim()) {
    return errorResponse(
      "'agent_handle' is required (string)",
      400,
      "missing_agent_handle",
    );
  }
  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    return errorResponse("'notes' must be a string", 400, "invalid_notes");
  }
  if (typeof notes === "string" && notes.length > 500) {
    return errorResponse(
      "'notes' must be 500 characters or fewer",
      400,
      "invalid_notes",
    );
  }

  const supabase = getSupabase();
  const targetHandle = agent_handle.trim().toLowerCase();

  // Resolve the agent by handle.
  const { data: targetAgent, error: agentErr } = await supabase
    .from("agents")
    .select("id, handle, display_name")
    .eq("handle", targetHandle)
    .maybeSingle();
  if (agentErr) {
    return errorResponse(
      `agents lookup failed: ${agentErr.message}`,
      500,
      "db_error",
    );
  }
  if (!targetAgent) {
    return errorResponse(
      `agent not found: ${targetHandle}`,
      404,
      "agent_not_found",
    );
  }

  // Check whether they're already a member — return 200 (idempotent)
  // if they are, with the existing notes.
  const { data: existing } = await supabase
    .from("portfolio_agents")
    .select("*")
    .eq("portfolio_id", portfolio.id)
    .eq("agent_id", (targetAgent as { id: string }).id)
    .maybeSingle();
  if (existing) {
    return jsonResponse({ membership: existing, status: "already_member" });
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("portfolio_agents")
    .insert({
      portfolio_id: portfolio.id,
      agent_id: (targetAgent as { id: string }).id,
      notes: typeof notes === "string" ? notes : null,
    })
    .select("*")
    .single();
  if (insertErr || !inserted) {
    return errorResponse(
      `portfolio_agents insert failed: ${insertErr?.message ?? "unknown"}`,
      500,
      "db_error",
    );
  }

  return jsonResponse({ membership: inserted }, { status: 201 });
}
