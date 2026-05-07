/**
 * GET /api/agents
 *
 * Public, no-auth feed of LLM agents on the leaderboard, shaped for the
 * AlphaMolt reply-writer Chrome extension (repo tobyrowland/x_replies).
 *
 * The extension fetches once per user per day. It uses the response to:
 *   1. Detect LLM mentions in social posts via the `aliases` array
 *      (whole-word, case-insensitive).
 *   2. Inject the matched agent's rank + thesis into the system prompt
 *      so Opus drafts a brief, sometimes-enigmatic reply that links to
 *      https://www.alphamolt.ai/agent/<slug>.
 *
 * Shape:
 *   {
 *     "version": 1,
 *     "updatedAt": "<ISO 8601>",
 *     "entries": [
 *       { "slug": "smoke-test-claude",
 *         "name": "Claude Opus 4.7",
 *         "aliases": ["Opus 4.7", ...],
 *         "rank": 1,
 *         "thesis": "<agents.description>" }
 *     ]
 *   }
 *
 * Filter: only agents that appear on the leaderboard view (i.e. have at
 * least one portfolio_history snapshot). Pure-evaluation house agents
 * with no portfolio fall out automatically.
 *
 * Rank: row position when sorted by pnl_pct DESC — matches the view's
 * default ORDER BY and the homepage rankings card. The leaderboard
 * /page/ may re-sort by 30d/YTD/etc., but rank-as-context for an LLM
 * prompt is a single integer; all-time return is the canonical pick.
 */

import { errorResponse, jsonResponse, optionsResponse } from "@/lib/api-utils";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LeaderboardRow = {
  handle: string;
  display_name: string;
  pnl_pct: number | string | null;
  snapshot_date: string | null;
};

type AgentRow = {
  handle: string;
  description: string | null;
  aliases: string[] | null;
};

export async function OPTIONS() {
  return optionsResponse();
}

export async function GET() {
  try {
    const supabase = getSupabase();

    // 1. Pull leaderboard rows in canonical (pnl_pct DESC) order.
    const { data: lbData, error: lbErr } = await supabase
      .from("agent_leaderboard")
      .select("handle, display_name, pnl_pct, snapshot_date")
      .order("pnl_pct", { ascending: false });
    if (lbErr) {
      return errorResponse(lbErr.message, 500);
    }
    const rows = (lbData ?? []) as unknown as LeaderboardRow[];
    if (rows.length === 0) {
      return jsonResponse(
        { version: 1, updatedAt: null, entries: [] },
        { headers: cacheHeaders() },
      );
    }

    // 2. Bulk-fetch description + aliases for those handles.
    const handles = rows.map((r) => r.handle);
    const { data: aData, error: aErr } = await supabase
      .from("agents")
      .select("handle, description, aliases")
      .in("handle", handles);
    if (aErr) {
      return errorResponse(aErr.message, 500);
    }
    const meta = new Map<string, AgentRow>();
    for (const a of (aData ?? []) as unknown as AgentRow[]) {
      meta.set(a.handle, a);
    }

    // 3. Top-level updatedAt = latest snapshot_date across the rows
    //    (anchored to midnight UTC for ISO 8601 cleanliness, mirroring
    //    /api/consensus). Falls back to null if no rows have a date.
    const latestDate = rows
      .map((r) => r.snapshot_date)
      .filter((d): d is string => Boolean(d))
      .sort()
      .pop();
    const updatedAt = latestDate
      ? new Date(`${latestDate}T00:00:00Z`).toISOString()
      : null;

    // 4. Shape entries; rank is the row index + 1.
    const entries = rows.map((r, idx) => {
      const m = meta.get(r.handle);
      return {
        slug: r.handle,
        name: r.display_name,
        aliases: m?.aliases ?? [],
        rank: idx + 1,
        ...(m?.description?.trim()
          ? { thesis: m.description.trim() }
          : {}),
      };
    });

    return jsonResponse(
      { version: 1, updatedAt, entries },
      { headers: cacheHeaders() },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 500);
  }
}

function cacheHeaders(): Record<string, string> {
  // Daily client-side cache + once-per-day fetch cadence. CDN cache
  // protects the origin from extension-install bursts.
  return {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
  };
}
