/**
 * Landing-page data fetches for the Arena surface.
 *
 * Everything here is derived from existing tables — there's no new arena
 * data store in Phase 2a.5. The Molt Feed reads the bear/bull eval columns
 * from the Level 0 `ai_analysis` home (migration 053); the equity count is
 * the Tier 1 universe (`securities.is_tier1`).
 */

import { getSupabase } from "@/lib/supabase";
import { extractEvalRationale } from "@/lib/constants";

export interface ArenaStats {
  equities: number;
  agents: number;
  evals_7d: number;
}

export interface MoltFeedItem {
  agent_handle: string;
  agent_display_name: string;
  ticker: string;
  company_name: string;
  verdict: "pass" | "fail" | "unknown";
  rationale: string | null;
  at: string; // ISO date
  side: "bull" | "bear";
}

function parseVerdict(
  raw: string | null,
): "pass" | "fail" | "unknown" {
  if (!raw) return "unknown";
  if (raw.includes("\u2705")) return "pass";
  if (raw.includes("\u274C")) return "fail";
  return "unknown";
}

export async function getArenaStats(): Promise<ArenaStats> {
  const supabase = getSupabase();

  const weekAgo = new Date();
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const weekAgoIso = weekAgo.toISOString().slice(0, 10); // DATE column

  const [equitiesRes, agentsRes, bearRes, bullRes] = await Promise.all([
    supabase
      .from("securities")
      .select("ticker", { count: "exact", head: true })
      .eq("is_tier1", true)
      .eq("status", "active"),
    supabase.from("agents").select("id", { count: "exact", head: true }),
    supabase
      .from("ai_analysis")
      .select("ticker", { count: "exact", head: true })
      .gte("bear_at", weekAgoIso),
    supabase
      .from("ai_analysis")
      .select("ticker", { count: "exact", head: true })
      .gte("bull_at", weekAgoIso),
  ]);

  return {
    equities: equitiesRes.count ?? 0,
    agents: agentsRes.count ?? 0,
    evals_7d: (bearRes.count ?? 0) + (bullRes.count ?? 0),
  };
}

export async function getMoltFeed(limit = 20): Promise<MoltFeedItem[]> {
  const supabase = getSupabase();

  // Pull the latest bear and bull evals separately from the Level 0
  // `ai_analysis` home, then merge client-side. We over-fetch each side by
  // `limit` so the combined top-N is always correct.
  const [bearRes, bullRes] = await Promise.all([
    supabase
      .from("ai_analysis")
      .select("ticker, bear_eval, bear_at")
      .not("bear_at", "is", null)
      .order("bear_at", { ascending: false })
      .limit(limit),
    supabase
      .from("ai_analysis")
      .select("ticker, bull_eval, bull_at")
      .not("bull_at", "is", null)
      .order("bull_at", { ascending: false })
      .limit(limit),
  ]);

  if (bearRes.error || bullRes.error) {
    return [];
  }

  // `ai_analysis` carries no name — resolve company names from `securities`.
  const tickers = Array.from(
    new Set([
      ...((bearRes.data ?? []) as { ticker: string }[]).map((r) => r.ticker),
      ...((bullRes.data ?? []) as { ticker: string }[]).map((r) => r.ticker),
    ]),
  );
  const names = new Map<string, string>();
  if (tickers.length > 0) {
    const { data: secRows } = await supabase
      .from("securities")
      .select("ticker, name")
      .in("ticker", tickers);
    for (const s of (secRows ?? []) as { ticker: string; name: string | null }[]) {
      if (s.name) names.set(s.ticker, s.name);
    }
  }

  const items: MoltFeedItem[] = [];

  for (const row of bearRes.data ?? []) {
    items.push({
      agent_handle: "fundamental-sentinel",
      agent_display_name: "Fundamental Sentinel",
      ticker: row.ticker as string,
      company_name: names.get(row.ticker as string) || "",
      verdict: parseVerdict(row.bear_eval as string | null),
      rationale: extractEvalRationale(row.bear_eval as string | null),
      at: row.bear_at as string,
      side: "bear",
    });
  }
  for (const row of bullRes.data ?? []) {
    items.push({
      agent_handle: "smash-hit-scout",
      agent_display_name: "Smash-Hit Scout",
      ticker: row.ticker as string,
      company_name: names.get(row.ticker as string) || "",
      verdict: parseVerdict(row.bull_eval as string | null),
      rationale: extractEvalRationale(row.bull_eval as string | null),
      at: row.bull_at as string,
      side: "bull",
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, limit);
}
