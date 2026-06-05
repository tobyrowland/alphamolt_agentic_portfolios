/**
 * Server-side data load for the screener (brief v2 §6 contract).
 *
 * Pulls the Level 0 facts (screen_facts(), which folds in the AI bull/bear
 * overlay — migration 042) and hands them to the pure scoring function. No
 * scoring lives here — this module only fetches; scoreScreen() ranks.
 *
 * PERF: the facts are identical for every config (only filtering/scoring
 * differs), so they're held in a small process-level cache with a 5-minute TTL
 * (the data refreshes on the daily/intraday cadence). A page load / re-rank is
 * then a cache read + in-memory scoring instead of hitting Postgres each time.
 *
 * NOTE: we deliberately do NOT use Next's `unstable_cache` here — it throws in
 * Next 16 when the wrapped function performs a dynamic fetch, and supabase-js
 * issues exactly such a fetch internally ("a server error occurred" with an
 * error digest). A plain module-level cache gives the same per-instance benefit
 * with none of that fragility. screen_facts returns the rankable set (~900
 * rows, one PostgREST page), so there's no pagination cost either.
 */

import { getSupabase } from "@/lib/supabase";
import { scoreScreen, type ScreenFacts, type ScreenResult } from "@/lib/screen/score";
import type { ScreenConfig } from "@/lib/screen/config";

const PAGE = 1000;
const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; data: ScreenFacts[] } | null = null;
let inflight: Promise<ScreenFacts[]> | null = null;

async function fetchFacts(): Promise<ScreenFacts[]> {
  const supabase = getSupabase();
  const rows: Record<string, unknown>[] = [];
  // One page in practice (screen_facts returns the rankable set, < PAGE). The
  // loop is just a safety net should the universe ever exceed a page.
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .rpc("screen_facts")
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) {
      console.error("screen_facts failed:", error.message);
      break;
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  return rows.map((r) => ({
    ticker: r.ticker as string,
    name: (r.name as string) ?? null,
    sector: (r.sector as string) ?? null,
    industry: (r.industry as string) ?? null,
    country: (r.country as string) ?? null,
    price: num(r.price),
    price_asof: (r.price_asof as string) ?? null,
    rev_growth_ttm: num(r.rev_growth_ttm),
    gross_margin: num(r.gross_margin),
    fcf_margin: num(r.fcf_margin),
    net_margin: num(r.net_margin),
    operating_margin: num(r.operating_margin),
    rule_of_40: num(r.rule_of_40),
    ps: num(r.ps),
    ps_median_12m: num(r.ps_median_12m),
    ret_52w: num(r.ret_52w),
    bull: (r.bull as boolean | null) ?? null,
    bear: (r.bear as boolean | null) ?? null,
  }) satisfies ScreenFacts);
}

/** Cached facts load — fresh within TTL, otherwise refetched. Concurrent calls
 *  share one in-flight fetch. */
export async function loadFacts(): Promise<ScreenFacts[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await fetchFacts();
      cache = { at: Date.now(), data };
      return data;
    } catch (err) {
      // Never let a transient fetch failure throw the whole page; serve the
      // last good snapshot if we have one, else an empty set.
      console.error("loadFacts failed:", err);
      return cache?.data ?? [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface ScreenResponse extends ScreenResult {
  data_asof: string | null;
}

/** Full contract response for a config: scored rows + counts + as-of. */
export async function runScreen(config: ScreenConfig): Promise<ScreenResponse> {
  const facts = await loadFacts();
  const result = scoreScreen(facts, config, facts.length);
  const data_asof = facts.reduce<string | null>((acc, f) => {
    if (f.price_asof && (!acc || f.price_asof > acc)) return f.price_asof;
    return acc;
  }, null);
  return { ...result, data_asof };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
