/**
 * Server-side query for /leaderboard and its OG card.
 *
 * Centralised so both `app/leaderboard/page.tsx` and
 * `app/leaderboard/opengraph-image.tsx` hit the same `unstable_cache` —
 * a single Supabase fetch per revalidation window powers both the HTML
 * page and the social-share image.
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import type {
  LeaderboardAgentRow,
  LeaderboardBenchmarkRow,
  LeaderboardRow,
  Period,
} from "@/components/leaderboard-table";

const PERIODS: readonly Period[] = ["1d", "30d", "ytd", "1yr"];

type TradeBuckets = Record<Period, number>;

function emptyBuckets(): TradeBuckets {
  return { "1d": 0, "30d": 0, ytd: 0, "1yr": 0 };
}

export interface LeaderboardResult {
  rows: LeaderboardRow[];
  latestDate: string | null;
}

async function fetchLeaderboard(): Promise<LeaderboardResult> {
  const supabase = getSupabase();

  // 1. Agent rows — view exposes all four interval returns + 30d Sharpe.
  interface RawAgentRow {
    handle: string;
    display_name: string;
    is_house_agent: boolean;
    snapshot_date: string;
    cash_usd: number | string;
    holdings_value_usd: number | string;
    total_value_usd: number | string;
    pnl_usd: number | string;
    pnl_pct_1d: number | string | null;
    pnl_pct_30d: number | string | null;
    pnl_pct_ytd: number | string | null;
    pnl_pct_1yr: number | string | null;
    sharpe: number | string | null;
    sharpe_n_returns: number | string | null;
    num_positions: number;
  }
  const { data: agentData, error: agentErr } = await supabase
    .from("agent_leaderboard")
    .select(
      "handle, display_name, is_house_agent, snapshot_date, cash_usd, " +
        "holdings_value_usd, total_value_usd, pnl_usd, " +
        "pnl_pct_1d, pnl_pct_30d, pnl_pct_ytd, pnl_pct_1yr, " +
        "sharpe, sharpe_n_returns, num_positions",
    );
  if (agentErr) console.error("Failed to fetch agent leaderboard:", agentErr);
  const rawAgents = (agentData ?? []) as unknown as RawAgentRow[];

  // 2. Trade counts + inception dates per agent.
  const [tradesByHandle, inceptionByHandle] = await Promise.all([
    fetchTradeBuckets(supabase, rawAgents),
    fetchInceptionDates(supabase, rawAgents),
  ]);

  const agentRows: LeaderboardAgentRow[] = rawAgents.map((r) => {
    const inception = inceptionByHandle.get(r.handle) ?? null;
    return {
      kind: "agent",
      handle: r.handle,
      display_name: r.display_name,
      is_house_agent: r.is_house_agent,
      snapshot_date: r.snapshot_date,
      cash_usd: Number(r.cash_usd),
      holdings_value_usd: Number(r.holdings_value_usd),
      total_value_usd: Number(r.total_value_usd),
      pnl_usd: Number(r.pnl_usd),
      returns: applyInceptionFloors(
        {
          "1d": toNum(r.pnl_pct_1d),
          "30d": toNum(r.pnl_pct_30d),
          ytd: toNum(r.pnl_pct_ytd),
          "1yr": toNum(r.pnl_pct_1yr),
        },
        inception,
      ),
      sharpe: toNum(r.sharpe),
      sharpe_n_returns: toNum(r.sharpe_n_returns) ?? 0,
      trades: tradesByHandle.get(r.handle) ?? emptyBuckets(),
      num_positions: r.num_positions,
    };
  });

  // 3. Benchmark rows — synthesised from benchmarks + benchmark_prices.
  interface RawBenchmarkRow {
    ticker: string;
    display_name: string;
    inception_price: number | string;
    latest_price: number | string | null;
    latest_price_date: string | null;
    notional_starting_cash: number | string;
  }
  interface RawPriceRow {
    price_date: string;
    close: number | string;
  }
  const benchmarkRows: LeaderboardBenchmarkRow[] = [];
  try {
    const { data: benchmarks, error: benchErr } = await supabase
      .from("benchmarks")
      .select(
        "ticker, display_name, inception_price, latest_price, " +
          "latest_price_date, notional_starting_cash",
      );
    if (benchErr) throw benchErr;

    for (const b of (benchmarks ?? []) as unknown as RawBenchmarkRow[]) {
      if (!b.latest_price || !b.latest_price_date) continue;
      const latest = Number(b.latest_price);
      const inception = Number(b.inception_price);
      const notional = Number(b.notional_starting_cash);
      if (!(latest > 0) || !(inception > 0)) continue;

      const { data: priceData } = await supabase
        .from("benchmark_prices")
        .select("price_date, close")
        .eq("ticker", b.ticker)
        .order("price_date", { ascending: true });
      const prices = ((priceData ?? []) as unknown as RawPriceRow[]).map(
        (p) => ({ date: p.price_date, close: Number(p.close) }),
      );

      const latestDate = b.latest_price_date;
      const dayAgo = shiftDays(latestDate, -1);
      const thirtyAgo = shiftDays(latestDate, -30);
      const yearAgo = shiftDays(latestDate, -365);
      const yearStart = `${latestDate.slice(0, 4)}-01-01`;

      const a1d = lastOnOrBefore(prices, dayAgo) ?? inception;
      const a30d = lastOnOrBefore(prices, thirtyAgo) ?? inception;
      const a1yr = lastOnOrBefore(prices, yearAgo) ?? inception;
      const aYtd = firstOnOrAfter(prices, yearStart) ?? inception;

      const totalValue = notional * (latest / inception);
      const pnlUsd = totalValue - notional;

      const benchSharpe = annualizedSharpe(prices);
      benchmarkRows.push({
        kind: "benchmark",
        ticker: b.ticker,
        display_name: b.display_name,
        snapshot_date: latestDate,
        total_value_usd: totalValue,
        pnl_usd: pnlUsd,
        returns: {
          "1d": pctChange(a1d, latest),
          "30d": pctChange(a30d, latest),
          ytd: pctChange(aYtd, latest),
          "1yr": pctChange(a1yr, latest),
        },
        sharpe: benchSharpe.sharpe,
        sharpe_n_returns: benchSharpe.n,
      });
    }
  } catch (err) {
    console.error("Benchmarks fetch failed (non-fatal):", err);
  }

  const rows: LeaderboardRow[] = [...agentRows, ...benchmarkRows];

  const latestDate = rows.reduce<string | null>(
    (acc, r) =>
      acc && (r.snapshot_date == null || acc > r.snapshot_date)
        ? acc
        : r.snapshot_date,
    null,
  );
  return { rows, latestDate };
}

export const getLeaderboard = unstable_cache(
  fetchLeaderboard,
  ["leaderboard-v1"],
  {
    revalidate: 300,
    tags: ["leaderboard"],
  },
);

async function fetchTradeBuckets(
  supabase: ReturnType<typeof getSupabase>,
  rawAgents: { handle: string }[],
): Promise<Map<string, TradeBuckets>> {
  const out = new Map<string, TradeBuckets>();
  if (rawAgents.length === 0) return out;

  // Resolve handle → id so we can attribute trades back to the leaderboard row.
  const { data: idRows, error: idErr } = await supabase
    .from("agents")
    .select("id, handle")
    .in(
      "handle",
      rawAgents.map((a) => a.handle),
    );
  if (idErr || !idRows) {
    if (idErr) console.error("Failed to resolve agent ids:", idErr);
    return out;
  }
  const idToHandle = new Map<string, string>();
  for (const row of idRows as { id: string; handle: string }[]) {
    idToHandle.set(row.id, row.handle);
  }

  const now = new Date();
  const yearAgoIso = new Date(
    now.getTime() - 365 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const dayAgoMs = now.getTime() - 24 * 60 * 60 * 1000;
  const thirtyDayMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const yearStartMs = Date.UTC(now.getUTCFullYear(), 0, 1);
  const yearAgoMs = new Date(yearAgoIso).getTime();

  const agentIds = Array.from(idToHandle.keys());
  if (agentIds.length === 0) return out;

  const pageSize = 1000;
  let from = 0;
  type TradeTuple = { agent_id: string; executed_at: string };
  const all: TradeTuple[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("agent_trades")
      .select("agent_id, executed_at")
      .in("agent_id", agentIds)
      .gte("executed_at", yearAgoIso)
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("Failed to fetch agent_trades:", error);
      break;
    }
    const batch = (data ?? []) as TradeTuple[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  for (const trade of all) {
    const handle = idToHandle.get(trade.agent_id);
    if (!handle) continue;
    let bucket = out.get(handle);
    if (!bucket) {
      bucket = emptyBuckets();
      out.set(handle, bucket);
    }
    const ts = new Date(trade.executed_at).getTime();
    if (ts >= dayAgoMs) bucket["1d"] += 1;
    if (ts >= thirtyDayMs) bucket["30d"] += 1;
    if (ts >= yearStartMs) bucket.ytd += 1;
    if (ts >= yearAgoMs) bucket["1yr"] += 1;
  }
  return out;
}

async function fetchInceptionDates(
  supabase: ReturnType<typeof getSupabase>,
  rawAgents: { handle: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rawAgents.length === 0) return out;

  const { data: idRows, error: idErr } = await supabase
    .from("agents")
    .select("id, handle")
    .in(
      "handle",
      rawAgents.map((a) => a.handle),
    );
  if (idErr || !idRows) {
    if (idErr) console.error("Failed to resolve agent ids:", idErr);
    return out;
  }
  const idToHandle = new Map<string, string>();
  for (const row of idRows as { id: string; handle: string }[]) {
    idToHandle.set(row.id, row.handle);
  }

  const { data: acctRows, error: acctErr } = await supabase
    .from("agent_accounts")
    .select("agent_id, inception_date")
    .in("agent_id", Array.from(idToHandle.keys()));
  if (acctErr || !acctRows) {
    if (acctErr) console.error("Failed to fetch agent_accounts:", acctErr);
    return out;
  }
  for (const r of acctRows as {
    agent_id: string;
    inception_date: string | null;
  }[]) {
    const handle = idToHandle.get(r.agent_id);
    if (handle && r.inception_date) out.set(handle, r.inception_date);
  }
  return out;
}

// Null out window returns for agents whose inception is inside the
// window — a 14-day-old agent's "30d" cell should read "calculating",
// not its 14-day return rebadged. Mirrors the SQL view's NULL-when-no-
// pre-cutoff-snapshot behaviour but is driven by inception_date so it
// stays correct even if a backfill produces older snapshots.
function applyInceptionFloors(
  returns: Record<Period, number | null>,
  inceptionDate: string | null,
): Record<Period, number | null> {
  if (!inceptionDate) return returns;
  const inception = new Date(`${inceptionDate}T00:00:00Z`);
  const now = new Date();
  const ageDays = (now.getTime() - inception.getTime()) / 86400000;
  const out = { ...returns };
  if (ageDays < 30) out["30d"] = null;
  if (ageDays < 365) out["1yr"] = null;
  if (inception.getUTCFullYear() >= now.getUTCFullYear()) out.ytd = null;
  return out;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pctChange(from: number, to: number): number | null {
  if (!(from > 0)) return null;
  return ((to - from) / from) * 100;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

function lastOnOrBefore(
  series: { date: string; close: number }[],
  cutoff: string,
): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].date <= cutoff) return series[i].close;
  }
  return null;
}

function firstOnOrAfter(
  series: { date: string; close: number }[],
  cutoff: string,
): number | null {
  for (const p of series) {
    if (p.date >= cutoff) return p.close;
  }
  return null;
}

// Mirrors the SQL Sharpe in agent_leaderboard: weekday-only daily returns
// over the entire price history, (mean - rf_daily) / sample stdev * sqrt(252),
// with rf = 5% annual. Min 30 returns to display.
const SHARPE_RF_ANNUAL = 0.05;
const SHARPE_RF_DAILY = SHARPE_RF_ANNUAL / 252;
const SHARPE_MIN_RETURNS = 30;

function annualizedSharpe(
  series: { date: string; close: number }[],
): { sharpe: number | null; n: number } {
  const window = series.filter((p) => isWeekday(p.date));
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1].close;
    const cur = window[i].close;
    if (!(prev > 0)) continue;
    returns.push((cur - prev) / prev);
  }
  if (returns.length < SHARPE_MIN_RETURNS) {
    return { sharpe: null, n: returns.length };
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const stdev = Math.sqrt(variance);
  if (!(stdev > 0)) return { sharpe: null, n: returns.length };
  return {
    sharpe: ((mean - SHARPE_RF_DAILY) / stdev) * Math.sqrt(252),
    n: returns.length,
  };
}

function isWeekday(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function parseInitialPeriod(
  raw: string | string[] | undefined,
): Period {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (val && (PERIODS as readonly string[]).includes(val)) {
    return val as Period;
  }
  return "30d";
}
