/**
 * GET /api/screen?config={base64url}  (brief v2 §6)
 *
 * The deterministic scoring-as-a-function contract. Decodes a screen config
 * from the URL, ranks the full Tier 1 universe for THAT config (lens-relative
 * score), and returns the ranked rows + counts + as-of. No LLM, no per-user
 * pipeline — a parameterised read. Also accepts ?preset= / ?sector= shortcuts.
 *
 * The client calls this on every filter/weight change to re-rank; SSR uses the
 * same `runScreen()` directly for the initial paint.
 */

import { errorResponse, jsonResponse } from "@/lib/api-utils";
import { configFromParams, screenConfigSchema } from "@/lib/screen/config";
import { runScreen } from "@/lib/screen/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Display projection — the client never needs the full fact row.
const DISPLAY = [
  "rank",
  "ticker",
  "name",
  "sector",
  "country",
  "price",
  "price_asof",
  "score",
  "ps",
  "rev_growth_ttm",
  "gross_margin",
  "fcf_margin",
  "rule_of_40",
  "ret_52w",
  "bull",
  "bear",
] as const;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const config = configFromParams({
      config: url.searchParams.get("config") ?? undefined,
      preset: url.searchParams.get("preset") ?? undefined,
      sector: url.searchParams.get("sector") ?? undefined,
    });
    // Validate (defends against a hand-edited config param).
    screenConfigSchema.parse(config);

    const result = await runScreen(config);
    const rows = result.rows.map((r) =>
      Object.fromEntries(DISPLAY.map((k) => [k, (r as unknown as Record<string, unknown>)[k]])),
    );

    return jsonResponse(
      {
        rows,
        match_count: result.match_count,
        total_universe: result.total_universe,
        cut_index: result.cut_index,
        data_asof: result.data_asof,
        config,
      },
      {
        headers: {
          // Re-rank feels live but still gets CDN relief; invalidated by the
          // daily data refresh well inside this window.
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}
