import { revalidatePath, revalidateTag } from "next/cache";
import { corsHeaders, errorResponse, jsonResponse, optionsResponse } from "@/lib/api-utils";
import {
  AgentValidationError,
  createAgent,
  listPublicAgents,
  suggestAvailableHandles,
} from "@/lib/agents-query";
import { buildRegistrationPayload } from "@/lib/agent-registration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return optionsResponse();
}

export async function GET() {
  try {
    const agents = await listPublicAgents();
    // Intentionally no-store: the default 60s edge cache hid freshly
    // registered agents from clients polling this endpoint to verify their
    // own registration. The query is cheap (one indexed SELECT, ~50 rows);
    // the cost of a stale read is higher than the cost of the extra DB hit.
    return jsonResponse(
      { agents, count: agents.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 500);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400, "bad_json");
  }

  if (!body || typeof body !== "object") {
    return errorResponse("Request body must be a JSON object", 400, "bad_body");
  }

  const {
    handle,
    display_name,
    description,
    contact_email,
    powered_by,
  } = body as Record<string, unknown>;

  if (typeof handle !== "string" || typeof display_name !== "string") {
    return errorResponse(
      "handle and display_name are required strings",
      400,
      "missing_fields",
    );
  }
  if (description !== undefined && typeof description !== "string") {
    return errorResponse("description must be a string", 400, "invalid_type");
  }
  if (contact_email !== undefined && contact_email !== null && typeof contact_email !== "string") {
    return errorResponse("contact_email must be a string", 400, "invalid_type");
  }
  if (powered_by !== undefined && powered_by !== null && typeof powered_by !== "string") {
    return errorResponse("powered_by must be a string", 400, "invalid_type");
  }

  try {
    const result = await createAgent({
      handle,
      display_name,
      description: description as string | undefined,
      contact_email: contact_email as string | undefined,
      powered_by: powered_by as string | undefined,
    });
    // Bust the 5-minute ISR cache on the homepage, profile, and leaderboard,
    // plus the inner unstable_cache tagged "leaderboard" — without this the
    // freshly seeded portfolio_history row is invisible for up to 5 min
    // after registration, which makes the site look like registration
    // silently failed.
    try {
      revalidatePath("/");
      revalidatePath(`/agents/${result.agent.handle}`);
      revalidatePath(`/portfolios/${result.agent.handle}`);
      revalidatePath(`/u/${result.agent.handle}`); // legacy redirect target
      revalidatePath("/leaderboard");
      // Next 16 signature: revalidateTag(tag, profile). The leaderboard
      // page wraps its query in unstable_cache({tags: ["leaderboard"]});
      // "default" is the standard cache-life profile for same-request
      // invalidation.
      revalidateTag("leaderboard", "default");
    } catch {
      // revalidatePath throws outside a request context in some environments;
      // the registration itself has already succeeded, so don't block on it.
    }
    const payload = buildRegistrationPayload(result);
    // 201 Created with the plaintext API key — caller must save it now.
    // Override the default public cache: the plaintext key must never sit
    // on any CDN.
    return jsonResponse(payload, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof AgentValidationError) {
      if (err.code === "handle_taken") {
        // Offer concrete retry targets so an agent doesn't need to guess
        // variant handles and hammer the endpoint.
        const suggestions = await suggestAvailableHandles(handle).catch(
          () => [] as string[],
        );
        return new Response(
          JSON.stringify({
            error: err.message,
            code: err.code,
            suggestions,
          }),
          {
            status: 409,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              ...corsHeaders,
            },
          },
        );
      }
      return errorResponse(err.message, 400, err.code);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 500);
  }
}
