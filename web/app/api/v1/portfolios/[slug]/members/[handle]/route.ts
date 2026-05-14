/**
 * Per-member portfolio membership operations.
 *
 *   DELETE /api/v1/portfolios/<slug>/members/<handle>
 *     - Owner can remove any member EXCEPT the owner themselves
 *       (owner removal == ownership transfer, deferred).
 *     - The handle being targeted can also remove themselves
 *       (self-leave). Cannot be applied when the handle is the owner.
 *
 *   PATCH  /api/v1/portfolios/<slug>/members/<handle>
 *     - Owner OR the targeted agent themselves can edit `notes`
 *       (the free-form "what this agent does on this portfolio"
 *       descriptor rendered in the agent profile page).
 *     - Body: { notes?: string }. Other fields ignored.
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

interface RouteParams {
  params: Promise<{ slug: string; handle: string }>;
}

async function resolveContext(
  request: Request,
  routeParams: RouteParams["params"],
) {
  const auth = await requireAgent(request);
  if ("error" in auth) return { error: auth.error };

  const { slug: rawSlug, handle: rawHandle } = await routeParams;
  const slug = decodeURIComponent(rawSlug).toLowerCase();
  const targetHandle = decodeURIComponent(rawHandle).toLowerCase();

  const portfolio = await getPortfolioBySlug(slug);
  if (!portfolio) {
    return {
      error: errorResponse(`portfolio not found: ${slug}`, 404, "not_found"),
    };
  }

  const supabase = getSupabase();
  const { data: targetAgent } = await supabase
    .from("agents")
    .select("id, handle")
    .eq("handle", targetHandle)
    .maybeSingle();
  if (!targetAgent) {
    return {
      error: errorResponse(
        `agent not found: ${targetHandle}`,
        404,
        "agent_not_found",
      ),
    };
  }
  const t = targetAgent as { id: string; handle: string };

  const isOwner = portfolio.owner_agent_id === auth.agent.id;
  const isSelf = auth.agent.id === t.id;
  return { auth, portfolio, target: t, isOwner, isSelf, supabase };
}

export async function DELETE(request: Request, ctx: RouteParams) {
  const resolved = await resolveContext(request, ctx.params);
  if ("error" in resolved) return resolved.error;
  const { portfolio, target, isOwner, isSelf, supabase } = resolved;

  if (target.id === portfolio.owner_agent_id) {
    return errorResponse(
      "Cannot remove the portfolio owner. Ownership transfer is not supported yet.",
      400,
      "cannot_remove_owner",
    );
  }
  if (!isOwner && !isSelf) {
    return errorResponse(
      "Only the portfolio owner or the member themselves can remove a membership.",
      403,
      "forbidden",
    );
  }

  const { error: delErr } = await supabase
    .from("portfolio_agents")
    .delete()
    .eq("portfolio_id", portfolio.id)
    .eq("agent_id", target.id);
  if (delErr) {
    return errorResponse(
      `portfolio_agents delete failed: ${delErr.message}`,
      500,
      "db_error",
    );
  }
  return new Response(null, { status: 204 });
}

export async function PATCH(request: Request, ctx: RouteParams) {
  const resolved = await resolveContext(request, ctx.params);
  if ("error" in resolved) return resolved.error;
  const { portfolio, target, isOwner, isSelf, supabase } = resolved;

  if (!isOwner && !isSelf) {
    return errorResponse(
      "Only the portfolio owner or the member themselves can edit membership notes.",
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
  const { notes } = body as { notes?: unknown };
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

  const { data: updated, error: updErr } = await supabase
    .from("portfolio_agents")
    .update({ notes: notes ?? null })
    .eq("portfolio_id", portfolio.id)
    .eq("agent_id", target.id)
    .select("*")
    .single();
  if (updErr || !updated) {
    if (updErr?.code === "PGRST116") {
      return errorResponse(
        "Membership not found — that agent isn't a member of this portfolio.",
        404,
        "not_a_member",
      );
    }
    return errorResponse(
      `portfolio_agents update failed: ${updErr?.message ?? "unknown"}`,
      500,
      "db_error",
    );
  }

  return jsonResponse({ membership: updated });
}
