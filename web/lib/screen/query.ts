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
 * with none of that fragility.
 *
 * PERF: screen_facts() reads the precomputed materialized view screen_facts_mv
 * (migration 044), not live LATERAL joins. Once the Tier 1 universe tripled the
 * live query hit ~7s; the matview makes it ~5ms. The set is now ~3.1k rows, so
 * the paginated fetch below spans a few PostgREST pages — each a cheap indexed
 * read of the matview.
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
  // ~3.1k rows across a few PostgREST pages; each page is a cheap indexed read
  // of screen_facts_mv (the function reads the matview — migration 044).
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

  // SPY's own 52-week return, so each row's "vs SPY" is ret_52w − spyRet.
  // Computed once here (cached with the facts) and subtracted per row.
  const spyRet = await fetchSpyRet52w();

  return rows.map((r) => {
    const ret52w = num(r.ret_52w);
    return {
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
      ret_52w: ret52w,
      perf_52w_vs_spy:
        ret52w != null && spyRet != null
          ? Math.round((ret52w - spyRet) * 10) / 10
          : null,
      bull: (r.bull as boolean | null) ?? null,
      bear: (r.bear as boolean | null) ?? null,
      quality_score: num(r.quality_score),
    } satisfies ScreenFacts;
  });
}

/**
 * SPY's trailing 52-week return (%), from `benchmark_prices`. Uses the same
 * 52-weeks-ago anchor as the per-ticker `ret_52w` in screen_facts_mv, so
 * subtracting gives a consistent "movement vs SPY". Null if SPY history is
 * missing (the derived field then stays null and won't filter).
 */
async function fetchSpyRet52w(): Promise<number | null> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - 364 * 86400000).toISOString().slice(0, 10);
  const [latestRes, agoRes] = await Promise.all([
    supabase
      .from("benchmark_prices")
      .select("close")
      .eq("ticker", "SPY.US")
      .order("price_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("benchmark_prices")
      .select("close")
      .eq("ticker", "SPY.US")
      .lte("price_date", cutoff)
      .order("price_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const latest = num((latestRes.data as { close?: unknown } | null)?.close);
  const ago = num((agoRes.data as { close?: unknown } | null)?.close);
  if (latest == null || ago == null || ago <= 0) return null;
  return (latest / ago - 1) * 100;
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
  /** Distinct sectors across the universe — populates the sector dropdown. */
  sectors: string[];
}

/**
 * Tickers on the manual 1-year blocklist (migration 048). Dropped from the
 * screener results; mirrored in screen.py so the buyer never considers them.
 * Fetched fresh (not in the facts cache) so an exclusion takes effect on the
 * next request. Fail-open on error.
 */
async function activeExclusions(): Promise<Set<string>> {
  try {
    const { data, error } = await getSupabase()
      .from("screener_exclusions")
      .select("ticker")
      .gt("expires_at", new Date().toISOString());
    if (error) {
      console.error("activeExclusions failed:", error.message);
      return new Set();
    }
    return new Set(
      ((data ?? []) as { ticker: string }[]).map((r) => r.ticker.toUpperCase()),
    );
  } catch {
    return new Set();
  }
}

/**
 * Full contract response for a config: scored rows + counts + as-of.
 *
 * `rejected` is the viewer's per-portfolio 90-day rejection set (migration
 * 051) — names this portfolio's buyer evaluated and passed on. Dropped only
 * when the config's `hideRejected` toggle is on (the default). Empty / omitted
 * for the logged-out public screener, which has no portfolio context.
 */
export async function runScreen(
  config: ScreenConfig,
  rejected?: Set<string>,
): Promise<ScreenResponse> {
  const [allFacts, excluded] = await Promise.all([
    loadFacts(),
    activeExclusions(),
  ]);
  let facts = excluded.size
    ? allFacts.filter((f) => !excluded.has(f.ticker.toUpperCase()))
    : allFacts;
  if (config.hideRejected !== false && rejected && rejected.size) {
    facts = facts.filter((f) => !rejected.has(f.ticker.toUpperCase()));
  }
  const result = scoreScreen(facts, config, facts.length);
  const data_asof = facts.reduce<string | null>((acc, f) => {
    if (f.price_asof && (!acc || f.price_asof > acc)) return f.price_asof;
    return acc;
  }, null);
  const sectors = Array.from(
    new Set(facts.map((f) => f.sector).filter((s): s is string => !!s)),
  ).sort();
  return { ...result, data_asof, sectors };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
