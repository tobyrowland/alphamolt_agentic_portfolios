/**
 * Server-side query for the /consensus page.
 *
 * Reads `consensus_snapshots` rows for either the latest date or a
 * specific date, joined to `companies` for company_name + exchange.
 * Single bulk SELECT — no per-ticker N+1.
 *
 * Materialised weekly by `consensus_snapshot.py` (Sunday 08:00 UTC), so
 * this is just a static read.
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";

export interface ConsensusHolder {
  handle: string;
  display_name: string;
  mtm_usd: number;
}

export interface ConsensusRow {
  rank: number;
  ticker: string;
  company_name: string;
  exchange: string | null;
  num_agents: number;
  total_agents: number;
  pct_agents: number;
  swarm_avg_entry: number | null;
  current_price: number | null;
  swarm_pnl_pct: number | null;
  top_holders: ConsensusHolder[];
}

export interface ConsensusResult {
  snapshot_date: string | null;
  rows: ConsensusRow[];
}

async function fetchLatestConsensus(): Promise<ConsensusResult> {
  const supabase = getSupabase();

  // Most recent snapshot date — small index-only read against
  // idx_consensus_snapshots_rank.
  const { data: latest, error: latestErr } = await supabase
    .from("consensus_snapshots")
    .select("snapshot_date")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    throw new Error(`consensus_snapshots latest lookup: ${latestErr.message}`);
  }
  if (!latest) {
    return { snapshot_date: null, rows: [] };
  }
  const snapshot_date = (latest as unknown as { snapshot_date: string })
    .snapshot_date;
  const rows = await fetchSnapshotRows(snapshot_date);
  return { snapshot_date, rows };
}

// Cached entry point. The snapshot is materialised once a week
// (Sundays 08:00 UTC by consensus_snapshot.py), so a 10-min stale
// window adds no perceptible lag but keeps both the homepage and the
// /consensus page (which share this query) snappy on repeat hits.
export const getLatestConsensus = unstable_cache(
  fetchLatestConsensus,
  ["consensus-latest-v1"],
  {
    revalidate: 600,
    tags: ["consensus"],
  },
);

/**
 * Fetch a snapshot for a specific date. Returns rows = [] when the date
 * has no snapshot — caller decides whether to 404 or render an empty
 * state.
 */
export async function getConsensusByDate(
  snapshot_date: string,
): Promise<ConsensusResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot_date)) {
    return { snapshot_date: null, rows: [] };
  }
  const rows = await fetchSnapshotRows(snapshot_date);
  return { snapshot_date: rows.length > 0 ? snapshot_date : null, rows };
}

async function fetchSnapshotRows(
  snapshot_date: string,
): Promise<ConsensusRow[]> {
  const supabase = getSupabase();

  // Pull every row for the date in one query, ordered by rank.
  const { data: snapRows, error: snapErr } = await supabase
    .from("consensus_snapshots")
    .select(
      "rank, ticker, num_agents, total_agents, pct_agents, " +
        "swarm_avg_entry, current_price, swarm_pnl_pct, top_holders",
    )
    .eq("snapshot_date", snapshot_date)
    .order("rank", { ascending: true });
  if (snapErr) {
    throw new Error(`consensus_snapshots fetch: ${snapErr.message}`);
  }
  if (!snapRows || snapRows.length === 0) return [];

  const tickers = snapRows.map(
    (r) => (r as unknown as { ticker: string }).ticker,
  );

  // Bulk-fetch company_name + exchange so the page can render
  // "AAPL · Apple Inc. · NASDAQ".
  const meta = new Map<
    string,
    { company_name: string; exchange: string | null }
  >();
  const { data: companies, error: cErr } = await supabase
    .from("companies")
    .select("ticker, company_name, exchange")
    .in("ticker", tickers);
  if (cErr) {
    throw new Error(`companies lookup: ${cErr.message}`);
  }
  for (const c of (companies ?? []) as unknown as {
    ticker: string;
    company_name: string;
    exchange: string | null;
  }[]) {
    meta.set(c.ticker, {
      company_name: c.company_name,
      exchange: c.exchange,
    });
  }

  return snapRows.map((raw) => {
    const r = raw as unknown as {
      rank: number;
      ticker: string;
      num_agents: number;
      total_agents: number;
      pct_agents: number | string;
      swarm_avg_entry: number | string | null;
      current_price: number | string | null;
      swarm_pnl_pct: number | string | null;
      top_holders: ConsensusHolder[] | null;
    };
    const m = meta.get(r.ticker);
    return {
      rank: r.rank,
      ticker: r.ticker,
      company_name: m?.company_name ?? r.ticker,
      exchange: m?.exchange ?? null,
      num_agents: r.num_agents,
      total_agents: r.total_agents,
      pct_agents: Number(r.pct_agents),
      swarm_avg_entry:
        r.swarm_avg_entry == null ? null : Number(r.swarm_avg_entry),
      current_price: r.current_price == null ? null : Number(r.current_price),
      swarm_pnl_pct:
        r.swarm_pnl_pct == null ? null : Number(r.swarm_pnl_pct),
      top_holders: Array.isArray(r.top_holders) ? r.top_holders : [],
    };
  });
}
