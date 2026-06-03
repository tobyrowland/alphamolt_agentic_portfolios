/**
 * Server-side query for the WSB-variant /leaderboard (anonymous visitors).
 *
 * Builds on the existing getLeaderboard() — same agent/benchmark rows — and
 * enriches each agent with the extras the WSB design needs: max drawdown
 * per period, a tiny normalised sparkline per period, since-inception
 * return + age (so young portfolios show "+12.2% · 18d" instead of
 * "calculating"), and a few page-level extras (biggest mover / down bad
 * callout picks, the recent-trades ticker).
 *
 * Period sorting + drawdown comparison happens client-side from the
 * payload below.
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { getLeaderboard } from "@/lib/leaderboard-query";
import type {
  LeaderboardRow,
  Period,
} from "@/components/leaderboard-table";

const PERIODS: readonly Period[] = ["1d", "1w", "30d", "ytd", "1yr"];

const PERIOD_DAYS: Record<Period, number> = {
  "1d": 1,
  "1w": 7,
  "30d": 30,
  ytd: 0, // special-cased
  "1yr": 365,
};

// Sparkline target length. Small enough to render as a tight inline SVG;
// the source series gets resampled to this count via even-stride pick.
const SPARK_POINTS = 8;

// REKT threshold per the brief — any portfolio whose 30d (or selected
// period) return is below this gets the REKT tag. The threshold itself
// lives on the client; the query just emits the raw returns.
export const REKT_THRESHOLD_PCT = -15;

export interface WsbAgentExtras {
  handle: string;
  /** Max drawdown over the period (negative %). null if window too young. */
  drawdownByPeriod: Record<Period, number | null>;
  /** Normalised 0-1 sparkline per period (SPARK_POINTS entries). */
  sparklineByPeriod: Record<Period, number[] | null>;
  /** Whole-life trend direction for the sparkline colour cue. */
  trendByPeriod: Record<Period, "up" | "down" | "flat">;
  /** Days since the portfolio's inception. */
  age_days: number;
  /** Since-inception pnl% — fallback for periods younger than the window. */
  inception_pnl_pct: number | null;
}

export interface WsbRecentTrade {
  handle: string;
  display_name: string;
  side: "buy" | "sell";
  ticker: string;
  quantity: number;
  executed_at: string;
}

export interface LeaderboardWsbData {
  rows: LeaderboardRow[];
  extrasByHandle: Record<string, WsbAgentExtras>;
  recentTrades: WsbRecentTrade[];
  latestDate: string | null;
}

async function fetchLeaderboardWsb(): Promise<LeaderboardWsbData> {
  const { rows, latestDate } = await getLeaderboard();

  const agentHandles = rows
    .filter((r): r is Extract<LeaderboardRow, { kind: "agent" }> => r.kind === "agent")
    .map((r) => r.handle);

  if (agentHandles.length === 0) {
    return { rows, extrasByHandle: {}, recentTrades: [], latestDate };
  }

  const [snapshotsByHandle, recentTrades] = await Promise.all([
    fetchAgentSnapshots(agentHandles),
    fetchRecentTrades(),
  ]);

  const today = new Date();
  const extrasByHandle: Record<string, WsbAgentExtras> = {};

  for (const handle of agentHandles) {
    const snapshots = snapshotsByHandle.get(handle) ?? [];
    extrasByHandle[handle] = buildExtras(handle, snapshots, today);
  }

  return { rows, extrasByHandle, recentTrades, latestDate };
}

interface Snapshot {
  date: string;
  total_value_usd: number;
}

/**
 * Pull the last 365 days of mark-to-market snapshots for every agent on
 * the leaderboard in one bulk query, grouped by handle. The view only
 * exposes the latest row per agent, but the underlying history table is
 * cheap to slice on.
 */
async function fetchAgentSnapshots(
  handles: string[],
): Promise<Map<string, Snapshot[]>> {
  const out = new Map<string, Snapshot[]>();
  if (handles.length === 0) return out;

  const supabase = getSupabase();
  const { data: idRows, error: idErr } = await supabase
    .from("agents")
    .select("id, handle")
    .in("handle", handles);
  if (idErr || !idRows) {
    if (idErr) console.error("WSB leaderboard: agents id lookup failed:", idErr);
    return out;
  }
  const handleById = new Map<string, string>();
  const agentIds: string[] = [];
  for (const r of idRows as { id: string; handle: string }[]) {
    handleById.set(r.id, r.handle);
    agentIds.push(r.id);
  }
  if (agentIds.length === 0) return out;

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 365);
  const sinceIso = since.toISOString().slice(0, 10);

  const { data: histRows, error: histErr } = await supabase
    .from("agent_portfolio_history")
    .select("agent_id, snapshot_date, total_value_usd")
    .in("agent_id", agentIds)
    .gte("snapshot_date", sinceIso)
    .order("snapshot_date", { ascending: true });
  if (histErr || !histRows) {
    if (histErr) console.error("WSB leaderboard: history fetch failed:", histErr);
    return out;
  }

  for (const r of histRows as {
    agent_id: string;
    snapshot_date: string;
    total_value_usd: number | string;
  }[]) {
    const handle = handleById.get(r.agent_id);
    if (!handle) continue;
    let bucket = out.get(handle);
    if (!bucket) {
      bucket = [];
      out.set(handle, bucket);
    }
    bucket.push({
      date: r.snapshot_date,
      total_value_usd: Number(r.total_value_usd),
    });
  }
  return out;
}

function buildExtras(
  handle: string,
  snapshots: Snapshot[],
  today: Date,
): WsbAgentExtras {
  const inception_pnl_pct = computeInceptionPnlPct(snapshots);
  const age_days =
    snapshots.length > 0
      ? Math.max(
          0,
          Math.floor(
            (today.getTime() -
              new Date(`${snapshots[0].date}T00:00:00Z`).getTime()) /
              86_400_000,
          ),
        )
      : 0;

  const drawdownByPeriod: Record<Period, number | null> = {
    "1d": null,
    "1w": null,
    "30d": null,
    ytd: null,
    "1yr": null,
  };
  const sparklineByPeriod: Record<Period, number[] | null> = {
    "1d": null,
    "1w": null,
    "30d": null,
    ytd: null,
    "1yr": null,
  };
  const trendByPeriod: Record<Period, "up" | "down" | "flat"> = {
    "1d": "flat",
    "1w": "flat",
    "30d": "flat",
    ytd: "flat",
    "1yr": "flat",
  };

  for (const p of PERIODS) {
    const slice = sliceForPeriod(snapshots, p, today);
    if (slice.length === 0) continue;
    drawdownByPeriod[p] = maxDrawdownPct(slice);
    sparklineByPeriod[p] = resample(slice.map((s) => s.total_value_usd));
    const first = slice[0].total_value_usd;
    const last = slice[slice.length - 1].total_value_usd;
    trendByPeriod[p] = last > first ? "up" : last < first ? "down" : "flat";
  }

  return {
    handle,
    drawdownByPeriod,
    sparklineByPeriod,
    trendByPeriod,
    age_days,
    inception_pnl_pct,
  };
}

function sliceForPeriod(
  snapshots: Snapshot[],
  period: Period,
  today: Date,
): Snapshot[] {
  if (snapshots.length === 0) return [];
  if (period === "ytd") {
    const yearStart = `${today.getUTCFullYear()}-01-01`;
    return snapshots.filter((s) => s.date >= yearStart);
  }
  const days = PERIOD_DAYS[period];
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return snapshots.filter((s) => s.date >= cutoffIso);
}

/** Max peak-to-trough drawdown over the slice as a negative percent. */
function maxDrawdownPct(slice: Snapshot[]): number {
  if (slice.length < 2) return 0;
  let peak = slice[0].total_value_usd;
  let worst = 0;
  for (const s of slice) {
    if (s.total_value_usd > peak) peak = s.total_value_usd;
    if (peak > 0) {
      const dd = ((s.total_value_usd - peak) / peak) * 100;
      if (dd < worst) worst = dd;
    }
  }
  return Number(worst.toFixed(2));
}

/** Resample to SPARK_POINTS via even-stride sampling, then normalise 0-1. */
function resample(values: number[]): number[] | null {
  if (values.length === 0) return null;
  if (values.length === 1) return Array(SPARK_POINTS).fill(0.5);

  const picked: number[] = [];
  for (let i = 0; i < SPARK_POINTS; i++) {
    const t = i / (SPARK_POINTS - 1);
    const idx = Math.min(values.length - 1, Math.round(t * (values.length - 1)));
    picked.push(values[idx]);
  }
  const min = Math.min(...picked);
  const max = Math.max(...picked);
  const span = max - min;
  if (span <= 0) return picked.map(() => 0.5);
  return picked.map((v) => (v - min) / span);
}

function computeInceptionPnlPct(snapshots: Snapshot[]): number | null {
  if (snapshots.length < 2) return null;
  const first = snapshots[0].total_value_usd;
  const last = snapshots[snapshots.length - 1].total_value_usd;
  if (first <= 0) return null;
  return Number((((last - first) / first) * 100).toFixed(2));
}

/**
 * Pull the N most recent trades across every public portfolio for the
 * live ticker. Joined to agents for the display name. Bounded query —
 * we sort desc and take the top slice in memory after a single LIMIT.
 */
async function fetchRecentTrades(limit = 6): Promise<WsbRecentTrade[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agent_trades")
    .select(
      "side, ticker, quantity, executed_at, agents:agent_id(handle, display_name)",
    )
    .order("executed_at", { ascending: false })
    .limit(limit);
  if (error || !data) {
    if (error) console.error("WSB leaderboard: recent trades fetch failed:", error);
    return [];
  }

  return (data as unknown as RawTradeRow[])
    .filter((t) => t.agents)
    .map((t) => ({
      handle: t.agents!.handle,
      display_name: t.agents!.display_name,
      side: t.side,
      ticker: t.ticker,
      quantity: Number(t.quantity),
      executed_at: t.executed_at,
    }));
}

interface RawTradeRow {
  side: "buy" | "sell";
  ticker: string;
  quantity: number | string;
  executed_at: string;
  agents: { handle: string; display_name: string } | null;
}

export const getLeaderboardWsb = unstable_cache(
  fetchLeaderboardWsb,
  ["leaderboard-wsb-v1"],
  {
    revalidate: 300,
    tags: ["leaderboard"],
  },
);
