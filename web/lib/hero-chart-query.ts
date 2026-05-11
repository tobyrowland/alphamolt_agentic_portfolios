/**
 * Server-side fetch for the homepage hero chart ("Alpha-Pulse").
 *
 * Pulls the top 4 agents by 30d return from `agent_leaderboard`, their
 * last 30 days of `agent_portfolio_history`, and the matching window of
 * SPY/URTH `benchmark_prices`. Benchmarks are normalised so day-1 sits
 * at $1M — matches the agents' starting cash so all five lines share a
 * common origin and the chart reads as "outperformance vs the index".
 *
 * One row per snapshot date with every series flattened into top-level
 * keys (Recharts expects `{ day: 1, "smash-hit-scout": 1015000, "SPY.US":
 * 1008000, ... }`). Missing values forward-fill so weekends/holidays
 * don't tear the lines.
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";

export interface HeroChartSeries {
  key: string;
  label: string;
  type: "agent" | "benchmark";
}

export type HeroChartPoint = {
  day: number;
  date: string;
} & Record<string, number | string>;

export interface HeroChartData {
  series: HeroChartSeries[];
  points: HeroChartPoint[];
  startingValue: number;
}

const DAYS = 30;
const STARTING_VALUE = 1_000_000;
const TOP_N = 4;

const BENCHMARK_LABELS: Record<string, string> = {
  "SPY.US": "S&P 500 (SPY)",
  "URTH.US": "MSCI World (URTH)",
};

async function fetchHeroChart(): Promise<HeroChartData> {
  const supabase = getSupabase();

  const { data: lbData } = await supabase
    .from("agent_leaderboard")
    .select("handle, display_name, pnl_pct_30d")
    .not("pnl_pct_30d", "is", null)
    .order("pnl_pct_30d", { ascending: false, nullsFirst: false })
    .limit(TOP_N);
  const topRows = (lbData ?? []) as Array<{
    handle: string;
    display_name: string;
  }>;

  // 30-day window keyed off today UTC. Pull a day extra so the very first
  // point in the window still has a forward-fill anchor if it's a weekend.
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (DAYS + 1));
  const sinceIso = since.toISOString().slice(0, 10);

  // Agent histories — resolve handle → id, then bulk-pull snapshots.
  const agentHistory = new Map<string, Map<string, number>>();
  if (topRows.length > 0) {
    const { data: idRows } = await supabase
      .from("agents")
      .select("id, handle")
      .in(
        "handle",
        topRows.map((r) => r.handle),
      );
    const idToHandle = new Map<string, string>();
    for (const r of (idRows ?? []) as Array<{ id: string; handle: string }>) {
      idToHandle.set(r.id, r.handle);
    }
    for (const h of idToHandle.values()) agentHistory.set(h, new Map());

    const agentIds = Array.from(idToHandle.keys());
    if (agentIds.length > 0) {
      const { data: histData } = await supabase
        .from("agent_portfolio_history")
        .select("agent_id, snapshot_date, total_value_usd")
        .in("agent_id", agentIds)
        .gte("snapshot_date", sinceIso)
        .order("snapshot_date", { ascending: true });
      for (const row of (histData ?? []) as Array<{
        agent_id: string;
        snapshot_date: string;
        total_value_usd: number | string;
      }>) {
        const handle = idToHandle.get(row.agent_id);
        if (!handle) continue;
        agentHistory.get(handle)!.set(row.snapshot_date, Number(row.total_value_usd));
      }
    }
  }

  // Benchmark prices.
  const benchHistory = new Map<string, Map<string, number>>();
  const benchTickers = Object.keys(BENCHMARK_LABELS);
  const { data: benchData } = await supabase
    .from("benchmark_prices")
    .select("ticker, price_date, close")
    .in("ticker", benchTickers)
    .gte("price_date", sinceIso)
    .order("price_date", { ascending: true });
  for (const ticker of benchTickers) benchHistory.set(ticker, new Map());
  for (const row of (benchData ?? []) as Array<{
    ticker: string;
    price_date: string;
    close: number | string;
  }>) {
    benchHistory.get(row.ticker)?.set(row.price_date, Number(row.close));
  }

  const series: HeroChartSeries[] = [
    ...topRows.map((r) => ({
      key: r.handle,
      label: r.display_name,
      type: "agent" as const,
    })),
    ...benchTickers
      .filter((t) => (benchHistory.get(t)?.size ?? 0) > 0)
      .map((t) => ({
        key: t,
        label: BENCHMARK_LABELS[t],
        type: "benchmark" as const,
      })),
  ];

  // Date union across every series, then trim to the trailing DAYS so the
  // chart always reads "last 30 trading days" regardless of weekends.
  const allDates = new Set<string>();
  for (const m of agentHistory.values()) for (const d of m.keys()) allDates.add(d);
  for (const m of benchHistory.values()) for (const d of m.keys()) allDates.add(d);
  const sortedDates = Array.from(allDates).sort().slice(-DAYS);

  // Scale benchmarks so day-0 = STARTING_VALUE. Agents already start at $1M.
  const benchScale = new Map<string, number>();
  if (sortedDates.length > 0) {
    for (const [ticker, m] of benchHistory) {
      // Use the first close ON or BEFORE the start of the window so the
      // normalisation anchor doesn't drift if the window opens on a
      // weekend.
      let anchor: number | null = null;
      const sortedTicker = Array.from(m.entries()).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      for (const [d, v] of sortedTicker) {
        if (d <= sortedDates[0]) anchor = v;
        else break;
      }
      if (anchor == null && sortedTicker.length > 0) {
        anchor = sortedTicker[0][1];
      }
      if (anchor != null && anchor > 0) {
        benchScale.set(ticker, STARTING_VALUE / anchor);
      }
    }
  }

  // Forward-fill within each series so weekend gaps don't break the line.
  const lastValue = new Map<string, number>();
  const points: HeroChartPoint[] = sortedDates.map((date, i) => {
    const row: HeroChartPoint = { day: i + 1, date };
    for (const s of series) {
      let v: number | undefined;
      if (s.type === "agent") {
        v = agentHistory.get(s.key)?.get(date);
      } else {
        const close = benchHistory.get(s.key)?.get(date);
        const scale = benchScale.get(s.key);
        if (close != null && scale != null) v = close * scale;
      }
      if (v != null) {
        lastValue.set(s.key, v);
        row[s.key] = v;
      } else if (lastValue.has(s.key)) {
        row[s.key] = lastValue.get(s.key)!;
      }
    }
    return row;
  });

  return { series, points, startingValue: STARTING_VALUE };
}

export const getHeroChart = unstable_cache(
  fetchHeroChart,
  ["hero-chart-v1"],
  {
    revalidate: 600,
    tags: ["leaderboard"],
  },
);
