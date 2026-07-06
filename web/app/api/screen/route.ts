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
import { projectDisplayRows } from "@/lib/screen/display-rows";
import { activeRejectionsForViewer } from "@/lib/screen/rejections-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    // the same names the SSR page did. Empty for logged-out callers. With
    // several paper portfolios (migration 070) this is the PRIMARY one's list
    // unless `pf` names a specific owned book (the embedded per-portfolio
    // screener); portfolioName lets the client caption whose buyer passed.
    const pf = url.searchParams.get("pf");
    const { portfolioId, portfolioName, rejections } =
      await activeRejectionsForViewer(pf ?? undefined);
    const rejectedSet = new Set(rejections.map((r) => r.ticker.toUpperCase()));
    const result = await runScreen(config, rejectedSet);
    // Same display projection the SSR paints ship (rounded floats, compiled
    // one-line thesis instead of the heavy research_card text — the full card
    // is lazy-loaded on row-expand via /api/screen/card).
    const projected = projectDisplayRows(result);

    return jsonResponse(
      {
        ...projected,
        config,
        // The viewer's active per-portfolio rejections (migration 051) — the
        // client folds these into the "Hidden" panel, tagged with the rejection
        // date. Empty for logged-out callers.
        rejected: rejections.map((r) => ({
          ticker: r.ticker,
          rejected_at: r.rejected_at,
        })),
        // Which portfolio the rejection list belongs to (the viewer's primary
        // paper book) — lets the hidden panel caption whose buyer passed.
        rejected_portfolio: portfolioName,
      },
      {
        headers: {
          // When there's no viewer portfolio (logged-out, or signed-in with no
          // portfolio) the response carries NO per-viewer data — identical for
          // everyone on a given config, so let the CDN share it. A viewer WITH a
          // portfolio gets a personalised (rejection-filtered) response that must
          // never be cached across users; likewise ANY pf-scoped request
          // (defense in depth — a per-portfolio URL has no CDN-sharing value).
          "Cache-Control":
            pf === null && portfolioId === null
              ? "public, s-maxage=300, stale-while-revalidate=600"
              : "private, no-store",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}
