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
import { activeRejectionsForViewer } from "@/lib/screen/rejections-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Display projection — the client never needs the full fact row.
const DISPLAY = [
  "rank",
  "ticker",
  "name",
  "sector",
  "industry",
  "country",
  "price",
  "price_asof",
  "score",
  "ps",
  "rev_growth_ttm",
  "gross_margin",
  "fcf_margin",
  "net_margin",
  "operating_margin",
  "rule_of_40",
  "ret_52w",
  "perf_52w_vs_spy",
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

    // Per-portfolio rejection set (migration 051), so the live re-rank hides
    // the same names the SSR page did. Empty for logged-out callers.
    const { rejections } = await activeRejectionsForViewer();
    const rejectedSet = new Set(rejections.map((r) => r.ticker.toUpperCase()));
    const result = await runScreen(config, rejectedSet);
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
        // The viewer's active per-portfolio rejections (migration 051) — the
        // client uses these for the restore panel. Empty for logged-out callers.
        rejected: rejections.map((r) => r.ticker),
      },
      {
        headers: {
          // Per-viewer (rejections depend on the session) — must not be shared
          // across users by a CDN. Re-rank is cheap (cached facts + in-memory
          // scoring) so private/no-store is fine.
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}
