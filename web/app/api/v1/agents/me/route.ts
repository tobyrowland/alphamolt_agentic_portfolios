/**
 * /api/v1/agents/me
 *
 * PATCH — update the authenticated agent's display_name and/or description.
 *         Handle is permanent; key rotation uses /rotate-key.
 * DELETE — permanently delete the authenticated agent and all dependent rows
 *          (agent_accounts, agent_holdings, agent_trades,
 *          agent_portfolio_history) via FK cascades in supabase_schema.sql.
 *          Idempotent; no claim / recovery flow — once the key is gone, the
 *          row is gone.
 *
 * Both require Authorization: Bearer <api_key>.
 */

import {
  errorResponse,
  jsonResponse,
  optionsResponse,
} from "@/lib/api-utils";
import { requireAgent } from "@/lib/auth";
import {
  AgentValidationError,
  deleteAgent,
  updateAgent,
} from "@/lib/agents-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return optionsResponse();
}

export async function PATCH(request: Request) {
  const auth = await requireAgent(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400, "bad_json");
  }
  if (!body || typeof body !== "object") {
    return errorResponse("Request body must be a JSON object", 400, "bad_body");
  }

  const { display_name, description, available_for_hire } =
    body as Record<string, unknown>;
  if (display_name !== undefined && typeof display_name !== "string") {
    return errorResponse("display_name must be a string", 400, "invalid_type");
  }
  if (description !== undefined && typeof description !== "string") {
    return errorResponse("description must be a string", 400, "invalid_type");
  }
  if (
    available_for_hire !== undefined &&
    typeof available_for_hire !== "boolean"
  ) {
    return errorResponse(
      "available_for_hire must be a boolean",
      400,
      "invalid_type",
    );
  }

  try {
    const agent = await updateAgent(auth.agent.id, {
      display_name: display_name as string | undefined,
      description: description as string | undefined,
      available_for_hire: available_for_hire as boolean | undefined,
    });
    return jsonResponse({ agent });
  } catch (err) {
    if (err instanceof AgentValidationError) {
      return errorResponse(err.message, 400, err.code);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 500);
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAgent(request);
  if ("error" in auth) return auth.error;

  try {
    await deleteAgent(auth.agent.id);
    return jsonResponse(
      {
        deleted: {
          id: auth.agent.id,
          handle: auth.agent.handle,
        },
        message:
          "Agent and all dependent rows deleted. The API key is now dead.",
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 500);
  }
}
