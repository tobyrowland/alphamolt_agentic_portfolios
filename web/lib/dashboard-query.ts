/**
 * Read-only data for the Dashboard (dashboard brief §4). Pulse + map: every
 * value here reports state; nothing writes. Scoped to the signed-in user's own
 * portfolios (paper + any live follower).
 *
 * No config endpoints are touched — the Dashboard only reads.
 */

import { getSupabase } from "@/lib/supabase";
import { PRESETS } from "@/lib/screen/config";

export interface DashSeriesPoint {
  date: string; // YYYY-MM-DD
  pct: number; // % return from the window start
}

export interface DashRosterMember {
  name: string;
  role: "buyer" | "reviewer" | null;
  poweredBy: string | null;
}

export interface DashPortfolio {
  id: string;
  slug: string;
  name: string;
  isPublic: boolean;
  value: number | null;
  pnlPct: number | null;
  numPositions: number;
  series: DashSeriesPoint[];
  hasBuyer: boolean;
  hasReviewer: boolean;
  mandateEmpty: boolean;
  /** The mandate text itself — used by the cold-start "team briefed" screen. */
  mandate: string;
  /** Human label for the portfolio's universe preset (or null if custom). */
  universeLabel: string | null;
  /** Member agents with their swarm role — for the cold-start brief recap. */
  roster: DashRosterMember[];
  draftEnabled: boolean;
  /**
   * The private real-money Alpaca follower (mode='live', migration 037). Kept
   * out of the paper cards / pulse aggregate / activity feed and surfaced as a
   * dedicated owner-only panel. Never derived from a `mode` column in the
   * payload — partitioned via a `mode='live'` id lookup so `mode` is never
   * serialized to the browser.
   */
  isLive: boolean;
}

export interface DashTrade {
  id: number | string;
  portfolioSlug: string;
  portfolioName: string;
  agentName: string;
  role: "buyer" | "reviewer" | null;
  side: string;
  ticker: string;
  qty: number;
  price: number;
  executedAt: string;
  reason: string | null;
}

export interface DashboardData {
  /** Paper (arena) books only — the live follower is split out below. */
  portfolios: DashPortfolio[];
  /** The private real-money Alpaca follower, if the owner has one. */
  livePortfolio: DashPortfolio | null;
  activity: DashTrade[];
  spySeries: DashSeriesPoint[];
}

const WINDOW_DAYS = 30;

function normalize(
  rows: { date: string; value: number }[],
): DashSeriesPoint[] {
  if (rows.length === 0) return [];
  const base = rows[0].value;
  if (!base) return rows.map((r) => ({ date: r.date, pct: 0 }));
  return rows.map((r) => ({ date: r.date, pct: (r.value / base - 1) * 100 }));
}

export async function getDashboardData(userId: string): Promise<DashboardData> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - (WINDOW_DAYS + 5) * 86400000)
    .toISOString()
    .slice(0, 10);

  const { data: pRows } = await supabase
    .from("portfolios")
    .select(
      "id, slug, display_name, is_public, description, draft_config, screen_config",
    )
    .eq("owner_user_id", userId)
    .order("created_at", { ascending: true });

  const portfolios = (pRows ?? []) as Array<{
    id: string;
    slug: string;
    display_name: string;
    is_public: boolean;
    description: string | null;
    draft_config: Record<string, unknown> | null;
    screen_config: Record<string, unknown> | null;
  }>;
  const ids = portfolios.map((p) => p.id);

  if (ids.length === 0) {
    return { portfolios: [], livePortfolio: null, activity: [], spySeries: [] };
  }

  // Fan out the shared reads. The live-follower lookup is filtered on
  // `mode='live'` and selects only `id` — `mode` itself is never read into
  // the payload (it's owner-only; the dashboard only ever reaches the owner,
  // but we keep the same discipline as the dedicated accessors).
  const [historyRes, membersRes, spyRes, tradesRes, liveRes] = await Promise.all([
    supabase
      .from("agent_portfolio_history")
      .select("portfolio_id, snapshot_date, total_value_usd, pnl_pct, num_positions")
      .in("portfolio_id", ids)
      .gte("snapshot_date", since)
      .order("snapshot_date", { ascending: true }),
    supabase
      .from("portfolio_agents")
      .select("portfolio_id, agent_id, role, agents (display_name, powered_by)")
      .in("portfolio_id", ids),
    supabase
      .from("benchmark_prices")
      .select("price_date, close")
      .eq("ticker", "SPY.US")
      .gte("price_date", since)
      .order("price_date", { ascending: true }),
    supabase
      .from("agent_trades")
      .select("id, agent_id, ticker, side, quantity, price_usd, executed_at, note, portfolio_id")
      .in("portfolio_id", ids)
      .order("executed_at", { ascending: false })
      .limit(20),
    supabase
      .from("portfolios")
      .select("id")
      .eq("owner_user_id", userId)
      .eq("mode", "live")
      .maybeSingle(),
  ]);

  const liveId = (liveRes.data as { id?: string } | null)?.id ?? null;

  // History grouped by portfolio.
  const histByP = new Map<string, { date: string; value: number; pnl: number | null; pos: number }[]>();
  for (const h of (historyRes.data ?? []) as Array<{
    portfolio_id: string;
    snapshot_date: string;
    total_value_usd: number | string;
    pnl_pct: number | string | null;
    num_positions: number;
  }>) {
    const arr = histByP.get(h.portfolio_id) ?? [];
    arr.push({
      date: h.snapshot_date,
      value: Number(h.total_value_usd) || 0,
      pnl: h.pnl_pct == null ? null : Number(h.pnl_pct),
      pos: Number(h.num_positions) || 0,
    });
    histByP.set(h.portfolio_id, arr);
  }

  // Roles + roster per portfolio. Supabase returns the joined `agents` as
  // either an object or a single-element array depending on the relationship
  // shape, so normalise defensively.
  const rolesByP = new Map<string, { buyer: boolean; reviewer: boolean }>();
  const roleByPA = new Map<string, "buyer" | "reviewer" | null>();
  const rosterByP = new Map<string, DashRosterMember[]>();
  for (const m of (membersRes.data ?? []) as Array<{
    portfolio_id: string;
    agent_id: string;
    role: "buyer" | "reviewer" | null;
    agents:
      | { display_name: string | null; powered_by: string | null }
      | { display_name: string | null; powered_by: string | null }[]
      | null;
  }>) {
    const r = rolesByP.get(m.portfolio_id) ?? { buyer: false, reviewer: false };
    if (m.role === "buyer") r.buyer = true;
    if (m.role === "reviewer") r.reviewer = true;
    rolesByP.set(m.portfolio_id, r);
    roleByPA.set(`${m.portfolio_id}:${m.agent_id}`, m.role ?? null);

    const agent = Array.isArray(m.agents) ? m.agents[0] : m.agents;
    const roster = rosterByP.get(m.portfolio_id) ?? [];
    roster.push({
      name: agent?.display_name ?? "An agent",
      role: m.role ?? null,
      poweredBy: agent?.powered_by ?? null,
    });
    rosterByP.set(m.portfolio_id, roster);
  }

  const spySeries = normalize(
    ((spyRes.data ?? []) as Array<{ price_date: string; close: number | string }>).map((r) => ({
      date: r.price_date,
      value: Number(r.close) || 0,
    })),
  );

  const dashAll: DashPortfolio[] = portfolios.map((p) => {
    const hist = (histByP.get(p.id) ?? []).slice(-WINDOW_DAYS);
    const latest = hist.length ? hist[hist.length - 1] : null;
    const roles = rolesByP.get(p.id) ?? { buyer: false, reviewer: false };
    const presetId =
      typeof p.screen_config?.preset === "string"
        ? (p.screen_config.preset as string)
        : null;
    return {
      id: p.id,
      slug: p.slug,
      name: p.display_name,
      isPublic: p.is_public,
      value: latest ? latest.value : null,
      pnlPct: latest ? latest.pnl : null,
      numPositions: latest ? latest.pos : 0,
      series: normalize(hist.map((h) => ({ date: h.date, value: h.value }))),
      hasBuyer: roles.buyer,
      hasReviewer: roles.reviewer,
      mandateEmpty: !(p.description && p.description.trim()),
      mandate: (p.description ?? "").trim(),
      universeLabel:
        presetId && PRESETS[presetId] ? PRESETS[presetId].label : null,
      roster: rosterByP.get(p.id) ?? [],
      draftEnabled: !!p.draft_config,
      isLive: p.id === liveId,
    };
  });

  // Split the private live follower out of the paper (arena) books so it
  // never double-counts in the pulse aggregate / cards / switch chips.
  const dashPortfolios = dashAll.filter((p) => !p.isLive);
  const livePortfolio = dashAll.find((p) => p.isLive) ?? null;

  // Activity feed — arena books only; the live follower's mirror trades are
  // real-money plumbing, not swarm decisions, so they stay off this feed.
  const trades = ((tradesRes.data ?? []) as Array<{
    id: number | string;
    agent_id: string;
    ticker: string;
    side: string;
    quantity: number | string;
    price_usd: number | string;
    executed_at: string;
    note: string | null;
    portfolio_id: string;
  }>).filter((t) => t.portfolio_id !== liveId);
  const agentIds = [...new Set(trades.map((t) => t.agent_id))];
  const nameByAgent = new Map<string, string>();
  if (agentIds.length) {
    const { data: agents } = await supabase
      .from("agents")
      .select("id, display_name")
      .in("id", agentIds);
    for (const a of (agents ?? []) as Array<{ id: string; display_name: string }>) {
      nameByAgent.set(a.id, a.display_name);
    }
  }
  const slugById = new Map(portfolios.map((p) => [p.id, { slug: p.slug, name: p.display_name }]));
  const activity: DashTrade[] = trades.map((t) => {
    const meta = slugById.get(t.portfolio_id);
    return {
      id: t.id,
      portfolioSlug: meta?.slug ?? "",
      portfolioName: meta?.name ?? "",
      agentName: nameByAgent.get(t.agent_id) ?? "an agent",
      role: roleByPA.get(`${t.portfolio_id}:${t.agent_id}`) ?? null,
      side: t.side,
      ticker: t.ticker,
      qty: Number(t.quantity) || 0,
      price: Number(t.price_usd) || 0,
      executedAt: t.executed_at,
      reason: t.note,
    };
  });

  return { portfolios: dashPortfolios, livePortfolio, activity, spySeries };
}
