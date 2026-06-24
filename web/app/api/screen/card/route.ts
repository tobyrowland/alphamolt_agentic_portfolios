/**
 * GET /api/screen/card?ticker=<T>
 *
 * The full research_card JSONB for one ticker, powering the screener row's
 * expanded detail (per-dimension rationale/evidence + break-signal list). Read
 * lazily client-side when a row opens — the heavy card text is NOT shipped in
 * the bulk /api/screen payload (only a compiled one-line thesis is). The card
 * is universe-wide (not per-viewer), so it's CDN-cacheable.
 */

import { errorResponse, jsonResponse } from "@/lib/api-utils";
import { getSupabase } from "@/lib/supabase";
import type { ResearchCard } from "@/lib/screen/score";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const ticker = new URL(req.url).searchParams.get("ticker");
    if (!ticker) return errorResponse("missing ticker", 400);
    const t = ticker.trim().toUpperCase();

    const { data, error } = await getSupabase()
      .from("ai_analysis")
      .select("research_card")
      .eq("ticker", t)
      .maybeSingle();
    if (error) return errorResponse(error.message, 400);

    return jsonResponse(
      {
        ticker: t,
        research_card: (data?.research_card as ResearchCard | null) ?? null,
      },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 400);
  }
}
