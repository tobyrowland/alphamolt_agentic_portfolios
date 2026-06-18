/**
 * GET /api/screen/ps-history?ticker=<T>  (redesign brief §5)
 *
 * The 12-month P/S series for one ticker, powering the screener row's expand
 * sparkline. Read lazily client-side when a row opens (the series isn't in the
 * matview — see ps-history-query). Non-secret, so it's CDN-cacheable.
 */

import { errorResponse, jsonResponse } from "@/lib/api-utils";
import { getPsHistory } from "@/lib/screen/ps-history-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const ticker = new URL(req.url).searchParams.get("ticker");
    if (!ticker) return errorResponse("missing ticker", 400);
    const history = await getPsHistory(ticker);
    return jsonResponse(
      { ticker: ticker.toUpperCase(), history },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}
