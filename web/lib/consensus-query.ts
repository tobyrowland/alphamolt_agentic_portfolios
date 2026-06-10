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

// ---------------------------------------------------------------------------
// Divergence ("Where they split") — the most-contested ticker this snapshot.
//
// A ticker is contested when independent swarms have taken *opposing* live
// positions on it: some currently hold it, others have exited it inside the
// lookback window. Both sides must have ≥ 2 swarms (a single dissenter isn't
// "the arena splitting"). Returns the ticker with the most opposing positions,
// or null when nothing genuinely qualifies — the homepage hides the strip
// rather than fabricate divergence.
// ---------------------------------------------------------------------------

const CONTESTED_LOOKBACK_DAYS = 30;
const CONTESTED_MIN_PER_SIDE = 2;

export interface ContestedTicker {
  ticker: string;
  company_name: string;
  held: number;
  exited: number;
  /** One-line explanation; neutral unless a shared signal is derivable. */
  why: string;
}

async function fetchContestedTicker(): Promise<ContestedTicker | null> {
  const supabase = getSupabase();

  // Current holders per ticker (the same agent population the consensus
  // snapshot aggregates — agent_holdings, quantity > 0).
  const { data: holdRows, error: holdErr } = await supabase
    .from("agent_holdings")
    .select("ticker, agent_id")
    .gt("quantity", 0);
  if (holdErr) {
    console.error("contested: holdings fetch failed:", holdErr);
    return null;
  }
  const heldBy = new Map<string, Set<string>>();
  for (const r of (holdRows ?? []) as { ticker: string; agent_id: string }[]) {
    if (!r.ticker || !r.agent_id) continue;
    (heldBy.get(r.ticker) ?? heldBy.set(r.ticker, new Set()).get(r.ticker)!).add(
      r.agent_id,
    );
  }

  // Recent sells per ticker.
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - CONTESTED_LOOKBACK_DAYS);
  const { data: sellRows, error: sellErr } = await supabase
    .from("agent_trades")
    .select("ticker, agent_id, side, executed_at")
    .eq("side", "sell")
    .gte("executed_at", since.toISOString());
  if (sellErr) {
    console.error("contested: trades fetch failed:", sellErr);
    return null;
  }
  // "Exited" = sold inside the window AND not currently holding (a full exit,
  // not a trim followed by a re-buy).
  const exitedBy = new Map<string, Set<string>>();
  for (const r of (sellRows ?? []) as {
    ticker: string;
    agent_id: string;
  }[]) {
    if (!r.ticker || !r.agent_id) continue;
    if (heldBy.get(r.ticker)?.has(r.agent_id)) continue;
    (
      exitedBy.get(r.ticker) ?? exitedBy.set(r.ticker, new Set()).get(r.ticker)!
    ).add(r.agent_id);
  }

  // Score the tickers with opposing sides ≥ the floor; most opposing wins,
  // tiebreak by the more balanced split, then by holders.
  let best: { ticker: string; held: number; exited: number } | null = null;
  for (const [ticker, holders] of heldBy) {
    const held = holders.size;
    const exited = exitedBy.get(ticker)?.size ?? 0;
    if (held < CONTESTED_MIN_PER_SIDE || exited < CONTESTED_MIN_PER_SIDE) {
      continue;
    }
    if (
      !best ||
      held + exited > best.held + best.exited ||
      (held + exited === best.held + best.exited &&
        Math.min(held, exited) > Math.min(best.held, best.exited))
    ) {
      best = { ticker, held, exited };
    }
  }
  if (!best) return null;

  const { data: company } = await supabase
    .from("companies")
    .select("company_name")
    .eq("ticker", best.ticker)
    .maybeSingle();
  const company_name =
    (company as { company_name?: string } | null)?.company_name ?? best.ticker;

  // Neutral copy: the firing break signal isn't persisted at sell time, so we
  // never claim a shared tripped signal we can't prove.
  return {
    ticker: best.ticker,
    company_name,
    held: best.held,
    exited: best.exited,
    why: "Same data, opposite calls.",
  };
}

export const getContestedTicker = unstable_cache(
  fetchContestedTicker,
  ["consensus-contested-v1"],
  { revalidate: 600, tags: ["consensus"] },
);

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
