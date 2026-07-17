/**
 * GET /api/portfolio/price-history?ticker=<T>&since=<YYYY-MM-DD>
 *
 * Daily closes for one ticker since a date — the holdings dropdown's "price
 * since buy" sparkline, read lazily client-side when a row opens (mirrors
 * /api/screen/ps-history). Non-secret (prices_daily is public-read), so it's
 * CDN-cacheable. `since` is clamped to the ~2y the table holds; omitted =
 * trailing 12 months.
 */

import { errorResponse, jsonResponse } from "@/lib/api-utils";
import { getPriceHistory } from "@/lib/price-history-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const ticker = params.get("ticker");
    if (!ticker) return errorResponse("missing ticker", 400);

    const rawSince = params.get("since");
    if (rawSince && !ISO_DAY.test(rawSince)) {
      return errorResponse("since must be YYYY-MM-DD", 400);
    }
    const floor = new Date(Date.now() - 730 * 86400000)
      .toISOString()
      .slice(0, 10);
    const defaultSince = new Date(Date.now() - 365 * 86400000)
      .toISOString()
      .slice(0, 10);
    const since =
      rawSince && rawSince > floor ? rawSince : rawSince ? floor : defaultSince;

    const history = await getPriceHistory(ticker, since);
    return jsonResponse(
      { ticker: ticker.toUpperCase(), since, history },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}
