// Server-side fetch for the homepage leaderboard preview. Returns every
// non-house agent enriched with all four rolling returns and each agent's
// most recent trade, plus the two benchmark rows (SPY, URTH). The client
// component re-sorts and slices by the active period so the SSR HTML
// includes every agent/benchmark already populated — crawlers see the full
// link graph with JS off.

import { getSupabase } from "@/lib/supabase";

export type Period = "1d" | "1w" | "30d" | "ytd" | "1yr";
export const PERIODS: readonly Period[] = ["1d", "1w", "30d", "ytd", "1yr"];
export const DEFAULT_PERIOD: Period = "30d";

export interface Returns {
  "1d": number | null;
  "1w": number | null;
  "30d": number | null;
  ytd: number | null;
  "1yr": number | null;
}

export interface HomeAgentRow {
  kind: "agent";
  handle: string;
  display_name: string;
  returns: Returns;
  last_trade: LastTrade | null;
  // 30-day equity-curve points used by the inline row sparkline. May be
  // empty if the agent has fewer than 2 history snapshots.
  sparkline: { x: number; y: number }[];
}

export interface LastTrade {
  side: "buy" | "sell";
  ticker: string;
  executed_at: string;
}

export interface HomeLeaderboardResult {
  agents: HomeAgentRow[];
}

export async function getHomeLeaderboard(): Promise<HomeLeaderboardResult> {
  const supabase = getSupabase();

  // Agents: every non-house row on the leaderboard view. All four returns
  // are columns on the view already; pulling them all lets the client
  // re-rank by period without another fetch.
  interface ViewRow {
    handle: string;
    display_name: string;
    is_house_agent: boolean;
    pnl_pct_1d: number | string | null;
    pnl_pct_1w: number | string | null;
    pnl_pct_30d: number | string | null;
    pnl_pct_ytd: number | string | null;
    pnl_pct_1yr: number | string | null;
  }
  const { data: viewRows, error: viewErr } = await supabase
    .from("agent_leaderboard")
    .select(
      "handle, display_name, is_house_agent, pnl_pct_1d, pnl_pct_1w, pnl_pct_30d, pnl_pct_ytd, pnl_pct_1yr",
    )
    .eq("is_house_agent", false);
  if (viewErr) {
    console.error("home leaderboard: agents view fetch failed:", viewErr);
  }
  const rawAgents = (viewRows ?? []) as ViewRow[];

  const handles = rawAgents.map((r) => r.handle);
  const lastTradeByHandle = await fetchLastTrades(handles);
  const sparklinesByHandle = await fetchSparklines(handles);

  const agents: HomeAgentRow[] = rawAgents.map((r) => ({
    kind: "agent",
    handle: r.handle,
    display_name: r.display_name,
    returns: {
      "1d": toNum(r.pnl_pct_1d),
      "1w": toNum(r.pnl_pct_1w),
      "30d": toNum(r.pnl_pct_30d),
      ytd: toNum(r.pnl_pct_ytd),
      "1yr": toNum(r.pnl_pct_1yr),
    },
    last_trade: lastTradeByHandle.get(r.handle) ?? null,
    sparkline: sparklinesByHandle.get(r.handle) ?? [],
  }));

  return { agents };
}

async function fetchLastTrades(
  handles: string[],
): Promise<Map<string, LastTrade>> {
  const out = new Map<string, LastTrade>();
  if (handles.length === 0) return out;

  const supabase = getSupabase();
  const { data: idRows } = await supabase
    .from("agents")
    .select("id, handle")
    .in("handle", handles);
  const handleById = new Map<string, string>();
  const agentIds: string[] = [];
  for (const r of (idRows ?? []) as { id: string; handle: string }[]) {
    handleById.set(r.id, r.handle);
    agentIds.push(r.id);
  }
  if (agentIds.length === 0) return out;

  // One range query: agents are few (tens), and we only keep the first
  // (most recent) trade per agent. The LIMIT is a safety cap — the loop
  // short-circuits as soon as every agent has a trade recorded.
  const { data: tradeRows } = await supabase
    .from("agent_trades")
    .select("agent_id, side, ticker, executed_at")
    .in("agent_id", agentIds)
    .order("executed_at", { ascending: false })
    .limit(Math.max(agentIds.length * 30, 500));
  for (const t of (tradeRows ?? []) as {
    agent_id: string;
    side: "buy" | "sell";
    ticker: string;
    executed_at: string;
  }[]) {
    const handle = handleById.get(t.agent_id);
    if (!handle || out.has(handle)) continue;
    out.set(handle, {
      side: t.side,
      ticker: t.ticker,
      executed_at: t.executed_at,
    });
    if (out.size === handleById.size) break;
  }
  return out;
}

// Pulls the last ~30 days of total_value_usd snapshots for every agent the
// homepage might show, in a single bulk query, then groups by handle. The
// number of snapshots per agent is bounded by date range (≤ 30) so the
// per-call result size stays small even with many agents.
async function fetchSparklines(
  handles: string[],
): Promise<Map<string, { x: number; y: number }[]>> {
  const out = new Map<string, { x: number; y: number }[]>();
  if (handles.length === 0) return out;

  const supabase = getSupabase();
  const { data: idRows } = await supabase
    .from("agents")
    .select("id, handle")
    .in("handle", handles);
  const handleById = new Map<string, string>();
  const agentIds: string[] = [];
  for (const r of (idRows ?? []) as { id: string; handle: string }[]) {
    handleById.set(r.id, r.handle);
    agentIds.push(r.id);
  }
  if (agentIds.length === 0) return out;

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);
  const sinceIso = since.toISOString().slice(0, 10);

  const { data: rows } = await supabase
    .from("agent_portfolio_history")
    .select("agent_id, snapshot_date, total_value_usd")
    .in("agent_id", agentIds)
    .gte("snapshot_date", sinceIso)
    .order("snapshot_date", { ascending: true });

  // Group by handle; emit `{x: dayIndex, y: total_value_usd}` in date order.
  const grouped = new Map<string, { date: string; y: number }[]>();
  for (const r of (rows ?? []) as {
    agent_id: string;
    snapshot_date: string;
    total_value_usd: number | string;
  }[]) {
    const handle = handleById.get(r.agent_id);
    if (!handle) continue;
    let bucket = grouped.get(handle);
    if (!bucket) {
      bucket = [];
      grouped.set(handle, bucket);
    }
    bucket.push({ date: r.snapshot_date, y: Number(r.total_value_usd) });
  }
  for (const [handle, bucket] of grouped) {
    out.set(
      handle,
      bucket.map((p, i) => ({ x: i, y: p.y })),
    );
  }
  return out;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Short relative-time formatter matching the brief's "buy NVDA · 2h" format.
// Returns e.g. "3m", "2h", "5d", "3w", "jan 14". Exported so the client-side
// row component can re-render it if needed.
export function formatRelativeTrade(iso: string, now: Date = new Date()): string {
  try {
    const then = new Date(iso);
    const diffMs = now.getTime() - then.getTime();
    if (diffMs < 60_000) return "now";
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMs / 3_600_000);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffMs / 86_400_000);
    if (diffDay < 7) return `${diffDay}d`;
    if (diffDay < 30) return `${Math.floor(diffDay / 7)}w`;
    return then
      .toLocaleDateString("en-US", { month: "short", day: "numeric" })
      .toLowerCase();
  } catch {
    return "";
  }
}
