/**
 * POST /api/v1/portfolio/buy
 *
 * Body: {
 *   ticker:   string,
 *   quantity: number,
 *   note?:    string,
 *   thesis?: {
 *     thesis_text?:    string,
 *     extend_signals?: ThesisSignal[],
 *     break_signals?:  ThesisSignal[],
 *   }
 * }
 *
 * Requires Authorization: Bearer <api_key>.
 *
 * Fills at the latest companies.price, cash-settled, weighted-average cost
 * basis. Rejects on unknown ticker, null price, or insufficient cash.
 *
 * Every successful BUY also records an `investment_theses` row with a
 * frozen snapshot of the equity's state at purchase. If `thesis` is
 * provided, the row also stores the agent's narrative + structured
 * extend/break signals (source='agent'); otherwise the row is
 * snapshot-only (source='auto').
 *
 * A ThesisSignal is `{ field: string, op: string, value: number|string,
 * description?: string }`. Supported operators: `>`, `>=`, `<`, `<=`,
 * `==`, `!=`, `change_pct_lt`, `change_pct_gt`. See migration 020 +
 * theses.py for the full check semantics.
 */

import {
  errorResponse,
  jsonResponse,
  optionsResponse,
} from "@/lib/api-utils";
import { requireAgent } from "@/lib/auth";
import { buy, PortfolioError } from "@/lib/portfolio";
import type { ThesisInput, ThesisSignal } from "@/lib/theses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return optionsResponse();
}

/**
 * Lightly validate a thesis payload. We accept the shape that matches
 * the table contract; anything malformed gets a 400 so the caller knows
 * the thesis didn't land (rather than silently dropping it server-side).
 */
function parseThesis(raw: unknown): ThesisInput | null | { error: string } {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "'thesis' must be an object" };
  }
  const t = raw as Record<string, unknown>;
  const thesis: ThesisInput = {};

  if (t.thesis_text != null) {
    if (typeof t.thesis_text !== "string") {
      return { error: "'thesis.thesis_text' must be a string" };
    }
    thesis.thesis_text = t.thesis_text;
  }

  for (const key of ["extend_signals", "break_signals"] as const) {
    const v = t[key];
    if (v == null) continue;
    if (!Array.isArray(v)) {
      return { error: `'thesis.${key}' must be an array of signal objects` };
    }
    const parsed: ThesisSignal[] = [];
    for (const item of v) {
      if (!item || typeof item !== "object") {
        return { error: `'thesis.${key}[]' entries must be objects` };
      }
      const sig = item as Record<string, unknown>;
      if (typeof sig.field !== "string" || typeof sig.op !== "string") {
        return {
          error: `'thesis.${key}[]' entries need {field, op} strings`,
        };
      }
      if (
        typeof sig.value !== "number" &&
        typeof sig.value !== "string"
      ) {
        return {
          error: `'thesis.${key}[]' entries need a 'value' (number or string)`,
        };
      }
      parsed.push({
        field: sig.field,
        op: sig.op,
        value: sig.value,
        description:
          typeof sig.description === "string" ? sig.description : undefined,
      });
    }
    thesis[key] = parsed;
  }

  // If the payload was an empty `{}`, treat as null so we don't store
  // source='agent' on an effectively-empty thesis.
  if (
    !thesis.thesis_text &&
    !thesis.extend_signals?.length &&
    !thesis.break_signals?.length
  ) {
    return null;
  }
  return thesis;
}

export async function POST(request: Request) {
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
  const { ticker, quantity, note, thesis } = body as {
    ticker?: unknown;
    quantity?: unknown;
    note?: unknown;
    thesis?: unknown;
  };
  if (typeof ticker !== "string" || ticker.trim().length === 0) {
    return errorResponse("'ticker' is required", 400, "missing_ticker");
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    return errorResponse(
      "'quantity' must be a positive number",
      400,
      "invalid_quantity",
    );
  }
  const noteStr = typeof note === "string" ? note : "";

  const parsedThesis = parseThesis(thesis);
  if (parsedThesis && "error" in parsedThesis) {
    return errorResponse(parsedThesis.error, 400, "invalid_thesis");
  }

  try {
    const trade = await buy(
      auth.agent.id,
      ticker.trim().toUpperCase(),
      quantity,
      noteStr,
      parsedThesis,
    );
    return jsonResponse({ trade }, { status: 201 });
  } catch (err) {
    if (err instanceof PortfolioError) {
      const status = err.code === "insufficient_cash" || err.code === "no_price"
        ? 400
        : err.code === "unknown_ticker"
          ? 404
          : 400;
      return errorResponse(err.message, status, err.code);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 500);
  }
}
