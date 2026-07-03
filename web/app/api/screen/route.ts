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
import { bestRationale } from "@/lib/screen/score";
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
  "ps_median_12m",
  "ps_trend_pct",
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
  // Graded bull/bear conviction + their rank tilt (migration 066).
  "bull_score",
  "bear_score",
  // Single-score fields (migration 057) — the score column + AI-durability badge.
  "base_z",
  "adj_z",
  "moat_z",
  "earn_z",
  "break_z",
  "verdict_z",
  "bull_z",
  "bear_z",
  "base_pct",
  "final_pct",
  "capped",
  "floored",
  "quality_score",
  "moat_score",
  "earnings_score",
  "growth_score",
  "break_count",
  "firing_breaks",
  "has_card",
  // Peer median P/S (display only, brief §5).
  "industry_ps_median",
  "sector_ps_median",
  "peer_ps_median",
  "peer_basis",
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
    // the same names the SSR page did. Empty for logged-out callers. With
    // several paper portfolios (migration 070) this is the PRIMARY one's list;
    // portfolioName lets the client caption whose buyer passed.
    const { portfolioId, portfolioName, rejections } =
      await activeRejectionsForViewer();
    const rejectedSet = new Set(rejections.map((r) => r.ticker.toUpperCase()));
    const result = await runScreen(config, rejectedSet);
    const rows = result.rows.map((r) => {
      const row = Object.fromEntries(
        DISPLAY.map((k) => [k, (r as unknown as Record<string, unknown>)[k]]),
      );
      // Ship only the compiled one-line thesis, not the heavy research_card
      // text — the full card is lazy-loaded on row-expand (/api/screen/card).
      row.thesis_line = bestRationale(r.research_card);
      return row;
    });

    return jsonResponse(
      {
        rows,
        match_count: result.match_count,
        total_universe: result.total_universe,
        data_asof: result.data_asof,
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
          // never be cached across users.
          "Cache-Control":
            portfolioId === null
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
