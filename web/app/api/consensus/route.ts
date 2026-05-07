/**
 * GET /api/consensus
 *
 * Public, no auth. Feeds the AlphaMolt reply-writer Chrome extension
 * (repo: tobyrowland/x_replies) so it can highlight consensus tickers
 * in social posts and ground draft replies in our stated thesis.
 *
 * The extension fetches once per day per user and caches client-side,
 * so the load is trivial. Permissive CORS is required because the
 * caller is a chrome-extension://... service worker — a foreign origin.
 *
 * Response shape (versioned client-side via the optional `version`
 * field; not gated yet):
 *
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-05-07T00:00:00Z",
 *     "entries": [
 *       { "ticker": "SEZL", "name": "Sezzle Inc.",
 *         "thesis": "...", "updatedAt": "..." }
 *     ]
 *   }
 *
 * `url` is intentionally omitted — the extension derives
 * https://www.alphamolt.ai/company/{TICKER} which always resolves.
 * `thesis` is the agent-narrative `short_outlook` for the ticker
 * (1–2 sentences). Entries with no short_outlook are still emitted —
 * the extension drops the field gracefully.
 */

import { errorResponse, jsonResponse, optionsResponse } from "@/lib/api-utils";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SnapshotRow = { snapshot_date: string; ticker: string; rank: number };
type CompanyRow = {
  ticker: string;
  company_name: string | null;
  short_outlook: string | null;
  ai_analyzed_at: string | null;
};

export async function OPTIONS() {
  return optionsResponse();
}

export async function GET() {
  try {
    const supabase = getSupabase();

    // 1. Latest snapshot date.
    const { data: latest, error: latestErr } = await supabase
      .from("consensus_snapshots")
      .select("snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) {
      return errorResponse(latestErr.message, 500);
    }
    if (!latest) {
      return jsonResponse(
        { version: 1, updatedAt: null, entries: [] },
        { headers: cacheHeaders() },
      );
    }
    const snapshot_date = (latest as unknown as { snapshot_date: string })
      .snapshot_date;

    // 2. Tickers in the snapshot, ordered by rank.
    const { data: snapRows, error: snapErr } = await supabase
      .from("consensus_snapshots")
      .select("snapshot_date, ticker, rank")
      .eq("snapshot_date", snapshot_date)
      .order("rank", { ascending: true });
    if (snapErr) {
      return errorResponse(snapErr.message, 500);
    }
    const rows = (snapRows ?? []) as unknown as SnapshotRow[];
    if (rows.length === 0) {
      return jsonResponse(
        { version: 1, updatedAt: toIso(snapshot_date), entries: [] },
        { headers: cacheHeaders() },
      );
    }

    // 3. Bulk-fetch name + short_outlook for those tickers.
    const tickers = rows.map((r) => r.ticker);
    const { data: companies, error: cErr } = await supabase
      .from("companies")
      .select("ticker, company_name, short_outlook, ai_analyzed_at")
      .in("ticker", tickers);
    if (cErr) {
      return errorResponse(cErr.message, 500);
    }
    const meta = new Map<string, CompanyRow>();
    for (const c of (companies ?? []) as unknown as CompanyRow[]) {
      meta.set(c.ticker, c);
    }

    // 4. Shape entries. Drop any ticker we can't resolve a name for —
    // the extension already silently drops such entries, but filtering
    // here keeps the wire shape clean.
    const entries = rows.flatMap((r) => {
      const m = meta.get(r.ticker);
      const name = m?.company_name?.trim();
      if (!name) return [];
      return [
        {
          ticker: r.ticker,
          name,
          ...(m?.short_outlook ? { thesis: m.short_outlook.trim() } : {}),
          ...(m?.ai_analyzed_at
            ? { updatedAt: new Date(m.ai_analyzed_at).toISOString() }
            : {}),
        },
      ];
    });

    return jsonResponse(
      {
        version: 1,
        updatedAt: toIso(snapshot_date),
        entries,
      },
      { headers: cacheHeaders() },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message, 500);
  }
}

function toIso(snapshot_date: string): string {
  // snapshot_date is a DATE ("YYYY-MM-DD"). Anchor to midnight UTC so the
  // extension's options page always reads a real ISO 8601 timestamp.
  return new Date(`${snapshot_date}T00:00:00Z`).toISOString();
}

function cacheHeaders(): Record<string, string> {
  // The extension caches client-side daily; this CDN cache only
  // protects the origin from extension installs / cache misses.
  return {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
  };
}
