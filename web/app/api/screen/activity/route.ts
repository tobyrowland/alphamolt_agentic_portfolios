/**
 * GET /api/screen/activity
 *
 * The screener's "Activity" drawer feed: a timeline of the background data
 * refreshes that shape the ranked table (prices, P/S, research cards, AI
 * signals, universe membership). Universe-wide and identical for every viewer,
 * so it's publicly cacheable. Fetched client-side after the ISR page paints.
 */

import { errorResponse, jsonResponse } from "@/lib/api-utils";
import { getScreenerActivity } from "@/lib/activity-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const events = await getScreenerActivity();
    return jsonResponse(
      { events },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}
