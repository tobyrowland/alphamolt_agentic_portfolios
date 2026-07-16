/**
 * Server-side fetch for the homepage hero stat strip ("swarm manager" hero).
 *
 * Two live numbers, both compiled from the same tables the leaderboard reads
 * (agent_portfolio_history snapshots + benchmark_prices for SPY) — never
 * re-derived from a separate source, never hardcoded:
 *
 *   Stat A — distinct users with ≥1 deployed swarm (a public human-owned
 *            portfolio with at least one hired agent) that has been live on
 *            the leaderboard ≥ 7 days (portfolio_accounts.inception_date).
 *   Stat B — the top swarm's alpha vs the S&P 500 (SPY) over the current
 *            quarter, in integer bps; falls back to trailing 90d with a
 *            relabel when the quarter is under 14 days old
 *            (hero-stats.resolveAlphaWindow).
 *
 * Failure contract: any error, or not enough data to compute Stat B, returns
 * null — the hero renders with the stat strip hidden entirely, never with
 * placeholder numbers (hero brief, acceptance #4).
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import {
  bestAlphaBps,
  formatBps,
  formatSnapshotDate,
  resolveAlphaWindow,
  statAVariant,
  type HeroStat,
  type SeriesPoint,
} from "@/lib/hero-stats";

export interface HeroStats {
  statA: HeroStat;
  statB: HeroStat;
  // "DD Mon YYYY", stamped when the stats were computed (the data-compile
  // date under unstable_cache, not the request date).
  snapshotDate: string;
}

const LIVE_ON_BOARD_MIN_DAYS = 7;

async function fetchHeroStats(): Promise<HeroStats | null> {
  try {
    const supabase = getSupabase();
    const todayIso = new Date().toISOString().slice(0, 10);

    // Swarms = public human-owned portfolios — the same rows the public
    // leaderboard shows (legacy 1:1 agent portfolios are not swarms and
    // don't hold the title).
    const { data: pRows, error: pErr } = await supabase
      .from("portfolios")
      .select("id, owner_user_id")
      .eq("is_public", true)
      .not("owner_user_id", "is", null);
    if (pErr) throw pErr;
    const portfolios = (pRows ?? []) as { id: string; owner_user_id: string }[];
    if (portfolios.length === 0) return null;
    const ids = portfolios.map((p) => p.id);

    const window = resolveAlphaWindow(todayIso);

    const [acctRes, memberRes, spyRes] = await Promise.all([
      supabase
        .from("portfolio_accounts")
        .select("portfolio_id, inception_date")
        .in("portfolio_id", ids),
      supabase
        .from("portfolio_agents")
        .select("portfolio_id")
        .in("portfolio_id", ids),
      supabase
        .from("benchmark_prices")
        .select("price_date, close")
        .eq("ticker", "SPY.US")
        .gte("price_date", window.startIso)
        .order("price_date", { ascending: true }),
    ]);
    if (acctRes.error) throw acctRes.error;
    if (memberRes.error) throw memberRes.error;
    if (spyRes.error) throw spyRes.error;

    // --- Stat A --------------------------------------------------------
    const cutoff = new Date(Date.now() - LIVE_ON_BOARD_MIN_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const oldEnough = new Set(
      (
        (acctRes.data ?? []) as {
          portfolio_id: string;
          inception_date: string | null;
        }[]
      )
        .filter((a) => a.inception_date != null && a.inception_date <= cutoff)
        .map((a) => a.portfolio_id),
    );
    const hasTeam = new Set(
      ((memberRes.data ?? []) as { portfolio_id: string }[]).map(
        (m) => m.portfolio_id,
      ),
    );
    const holders = new Set(
      portfolios
        .filter((p) => oldEnough.has(p.id) && hasTeam.has(p.id))
        .map((p) => p.owner_user_id),
    );

    // --- Stat B --------------------------------------------------------
    const spy: SeriesPoint[] = (
      (spyRes.data ?? []) as { price_date: string; close: number | string }[]
    ).map((r) => ({ date: r.price_date, value: Number(r.close) }));

    const histories = await fetchHistories(supabase, ids, window.startIso);
    const alpha = bestAlphaBps(
      Array.from(histories.values()),
      spy,
      window.startIso,
    );
    // Not enough history to state an alpha honestly → no strip at all.
    if (alpha == null) return null;

    return {
      statA: statAVariant(holders.size),
      statB: { value: formatBps(alpha), label: window.label },
      snapshotDate: formatSnapshotDate(todayIso),
    };
  } catch (err) {
    console.error("hero stats fetch failed:", err);
    return null;
  }
}

// Daily MTM snapshots per portfolio inside the window — the exact series the
// agent_leaderboard view measures returns from. Paged: N portfolios × ~90
// weekdays can exceed PostgREST's 1000-row page.
async function fetchHistories(
  supabase: ReturnType<typeof getSupabase>,
  portfolioIds: string[],
  startIso: string,
): Promise<Map<string, SeriesPoint[]>> {
  type HistRow = {
    portfolio_id: string;
    snapshot_date: string;
    total_value_usd: number | string;
  };
  const pageSize = 1000;
  let from = 0;
  const all: HistRow[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("agent_portfolio_history")
      .select("portfolio_id, snapshot_date, total_value_usd")
      .in("portfolio_id", portfolioIds)
      .gte("snapshot_date", startIso)
      .order("snapshot_date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = (data ?? []) as HistRow[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  const out = new Map<string, SeriesPoint[]>();
  for (const r of all) {
    let bucket = out.get(r.portfolio_id);
    if (!bucket) {
      bucket = [];
      out.set(r.portfolio_id, bucket);
    }
    bucket.push({ date: r.snapshot_date, value: Number(r.total_value_usd) });
  }
  return out;
}

// Revalidate hourly (brief allows up to 6h) so Stat A/B track leaderboard
// data without a deploy. Shares the "leaderboard" tag with the leaderboard
// queries so a future revalidateTag refreshes all of them together.
export const getHeroStats = unstable_cache(fetchHeroStats, ["hero-stats-v1"], {
  revalidate: 3600,
  tags: ["leaderboard"],
});
