/**
 * Per-ticker queries that power the agent-focused /company/[ticker] page.
 *
 * Mirrors the style of `consensus-query.ts` — single bulk SELECTs, no
 * per-ticker N+1, defensive nulls. The page calls all four in a
 * Promise.all alongside the existing companies + price_sales reads.
 */

import { getSupabase } from "@/lib/supabase";

export interface CompanySwarmSnapshot {
  // Latest weekly consensus_snapshots row, or null if the ticker has
  // never made it onto a snapshot.
  snapshot_date: string | null;
  // Live counts — recomputed from agent_holdings so the page stays
  // accurate intra-week even when the snapshot is stale.
  num_agents: number;
  total_agents: number;
  pct_agents: number;
  // Aggregates from the snapshot when present; null otherwise.
  swarm_avg_entry: number | null;
  current_price: number | null;
  swarm_pnl_pct: number | null;
  // Earliest first_bought_at across current holders (ISO date or null).
  // Sourced from agent_holdings, NOT the snapshot, so it's always live.
  earliest_held_since: string | null;
  // For OG-card consistency: snapshot's curated top-holders list.
  top_holders: ConsensusHolder[];
}

export interface ConsensusHolder {
  handle: string;
  display_name: string;
  mtm_usd: number;
}

export interface CompanyHolder {
  handle: string;
  display_name: string;
  is_house_agent: boolean;
  quantity: number;
  avg_cost_usd: number;
  first_bought_at: string | null;
  // Computed live with companies.price.
  current_value_usd: number | null;
  pnl_pct: number | null;
  days_held: number | null;
}

export interface CompanyTrade {
  id: string;
  handle: string;
  display_name: string;
  side: "buy" | "sell";
  quantity: number;
  price_usd: number;
  executed_at: string;
  note: string | null;
}

export interface HeartbeatRationale {
  handle: string;
  display_name: string;
  // Agent's own model id for attribution ("Claude Opus 4.7", etc.).
  // Pulled from notes.model when present; falls back to display_name.
  model_label: string;
  rationale: string;
  started_at: string;
}

export type AgentStance = "bullish" | "bearish" | "neutral";

/**
 * One row per agent that has ever interacted with this ticker. Combines
 * current holding state with their last trade action so the page can
 * render an editorial-feeling POV card per agent (stance pill, position,
 * latest action, rationale).
 *
 * Stance derivation — kept simple so the rule is auditable:
 *   - holds AND latest_side == sell  → "neutral"  (trimmed but still in)
 *   - holds                          → "bullish"  (still in, last buy)
 *   - exited (no holding)            → "bearish"  (sold out)
 */
export interface AgentPov {
  handle: string;
  display_name: string;
  is_house_agent: boolean;
  stance: AgentStance;
  position_qty: number;
  avg_entry: number | null;
  current_pnl_pct: number | null;
  latest_action_label: string; // "Bought 2d ago" / "Trimmed 5d ago" / "Sold 1d ago"
  latest_action_at: string | null;
  rationale: string | null;
}

export interface CompanyConsensus {
  // Page-level verdict. Derivation rule (intentionally crude so it stays
  // auditable):
  //   - holders == 0                          → "bearish"
  //   - holders / total >= 0.5                → "bullish"
  //   - otherwise                              → "mixed"
  verdict: "bullish" | "bearish" | "mixed";
  // Plain-English "what changed in the last ~14 days" sentence. Empty
  // string when no trades happened recently — caller renders nothing.
  what_changed: string;
}

/**
 * Latest weekly consensus row + live overlays from agent_holdings so the
 * hero is accurate even mid-week before the next snapshot.
 *
 * `total_agents` falls back to the count of agents with a non-null
 * strategy when the snapshot row is missing — that matches the snapshot
 * builder's denominator.
 */
export async function getCompanySwarmSnapshot(
  ticker: string,
): Promise<CompanySwarmSnapshot> {
  const supabase = getSupabase();

  const [snapRes, holdersRes, agentCountRes, priceRes] = await Promise.all([
    supabase
      .from("consensus_snapshots")
      .select(
        "snapshot_date, num_agents, total_agents, pct_agents, " +
          "swarm_avg_entry, current_price, swarm_pnl_pct, top_holders",
      )
      .eq("ticker", ticker)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("agent_holdings")
      .select("agent_id, avg_cost_usd, quantity, first_bought_at")
      .eq("ticker", ticker),
    supabase
      .from("agents")
      .select("id", { count: "exact", head: true })
      .not("strategy", "is", null),
    supabase
      .from("companies")
      .select("price")
      .eq("ticker", ticker)
      .maybeSingle(),
  ]);

  const snap = snapRes.data as
    | {
        snapshot_date: string;
        num_agents: number;
        total_agents: number;
        pct_agents: number | string;
        swarm_avg_entry: number | string | null;
        current_price: number | string | null;
        swarm_pnl_pct: number | string | null;
        top_holders: ConsensusHolder[] | null;
      }
    | null;

  const holdings = (holdersRes.data ?? []) as Array<{
    agent_id: string;
    avg_cost_usd: number | string;
    quantity: number | string;
    first_bought_at: string | null;
  }>;

  // Live num_agents = unique holder count today.
  const liveHolders = new Set(holdings.map((h) => h.agent_id));
  const numAgents = liveHolders.size;

  const totalAgents =
    snap?.total_agents ?? agentCountRes.count ?? 0;

  const pctAgents =
    totalAgents > 0 ? (numAgents / totalAgents) * 100 : 0;

  // Live weighted-average entry from agent_holdings.
  // sum(qty * avg_cost) / sum(qty), so a single share at $100 plus 99
  // shares at $50 gives $50.50, not $75.
  let totalQty = 0;
  let weightedCost = 0;
  let earliestHeld: string | null = null;
  for (const h of holdings) {
    const qty = Number(h.quantity);
    const cost = Number(h.avg_cost_usd);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    totalQty += qty;
    if (Number.isFinite(cost)) weightedCost += qty * cost;
    if (h.first_bought_at) {
      if (!earliestHeld || h.first_bought_at < earliestHeld) {
        earliestHeld = h.first_bought_at;
      }
    }
  }
  const liveAvgEntry = totalQty > 0 ? weightedCost / totalQty : null;
  const livePrice = priceRes.data
    ? Number((priceRes.data as { price: number | string | null }).price)
    : null;
  const liveCurrentPrice =
    livePrice != null && Number.isFinite(livePrice) ? livePrice : null;
  const livePnlPct =
    liveAvgEntry != null && liveCurrentPrice != null && liveAvgEntry > 0
      ? ((liveCurrentPrice - liveAvgEntry) / liveAvgEntry) * 100
      : null;

  return {
    snapshot_date: snap?.snapshot_date ?? null,
    num_agents: numAgents,
    total_agents: totalAgents,
    pct_agents: pctAgents,
    swarm_avg_entry: liveAvgEntry,
    current_price: liveCurrentPrice,
    swarm_pnl_pct: livePnlPct,
    earliest_held_since: earliestHeld
      ? earliestHeld.slice(0, 10)
      : null,
    top_holders: Array.isArray(snap?.top_holders) ? snap.top_holders : [],
  };
}

/**
 * Current open positions in this ticker, joined to the `agents` table for
 * display name + house badge. Ordered by current MTM value descending.
 *
 * Live P&L is computed against companies.price; we don't store it.
 */
export async function getCompanyHolders(
  ticker: string,
): Promise<CompanyHolder[]> {
  const supabase = getSupabase();

  const [holdingsRes, priceRes] = await Promise.all([
    supabase
      .from("agent_holdings")
      .select(
        "agent_id, quantity, avg_cost_usd, first_bought_at, " +
          "agents!inner(handle, display_name, is_house_agent)",
      )
      .eq("ticker", ticker),
    supabase
      .from("companies")
      .select("price")
      .eq("ticker", ticker)
      .maybeSingle(),
  ]);

  if (holdingsRes.error) {
    throw new Error(`agent_holdings lookup: ${holdingsRes.error.message}`);
  }

  const livePrice = priceRes.data
    ? Number((priceRes.data as { price: number | string | null }).price)
    : null;
  const price = livePrice != null && Number.isFinite(livePrice) ? livePrice : null;
  const now = Date.now();

  const rows = (holdingsRes.data ?? []) as unknown as Array<{
    quantity: number | string;
    avg_cost_usd: number | string;
    first_bought_at: string | null;
    agents: {
      handle: string;
      display_name: string;
      is_house_agent: boolean;
    };
  }>;

  return rows
    .map((r) => {
      const qty = Number(r.quantity);
      const cost = Number(r.avg_cost_usd);
      const currentValue =
        price != null && Number.isFinite(qty) ? qty * price : null;
      const pnlPct =
        price != null && Number.isFinite(cost) && cost > 0
          ? ((price - cost) / cost) * 100
          : null;
      const daysHeld = r.first_bought_at
        ? Math.max(
            0,
            Math.floor(
              (now - new Date(r.first_bought_at).getTime()) /
                (1000 * 60 * 60 * 24),
            ),
          )
        : null;
      return {
        handle: r.agents.handle,
        display_name: r.agents.display_name,
        is_house_agent: !!r.agents.is_house_agent,
        quantity: Number.isFinite(qty) ? qty : 0,
        avg_cost_usd: Number.isFinite(cost) ? cost : 0,
        first_bought_at: r.first_bought_at,
        current_value_usd: currentValue,
        pnl_pct: pnlPct,
        days_held: daysHeld,
      } satisfies CompanyHolder;
    })
    .sort((a, b) => {
      const av = a.current_value_usd ?? 0;
      const bv = b.current_value_usd ?? 0;
      return bv - av;
    });
}

/**
 * Reverse-chronological trade journal for this ticker. Joined to agents
 * for display name + handle. Top N server-side; v1 has no pagination.
 */
export async function getCompanyTradeTape(
  ticker: string,
  limit = 25,
): Promise<CompanyTrade[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agent_trades")
    .select(
      "id, side, quantity, price_usd, executed_at, note, " +
        "agents!inner(handle, display_name)",
    )
    .eq("ticker", ticker)
    .order("executed_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`agent_trades lookup: ${error.message}`);
  }
  return ((data ?? []) as unknown as Array<{
    id: string;
    side: string;
    quantity: number | string;
    price_usd: number | string;
    executed_at: string;
    note: string | null;
    agents: { handle: string; display_name: string };
  }>).map((r) => ({
    id: r.id,
    handle: r.agents.handle,
    display_name: r.agents.display_name,
    side: r.side === "sell" ? "sell" : "buy",
    quantity: Number(r.quantity),
    price_usd: Number(r.price_usd),
    executed_at: r.executed_at,
    note: r.note,
  }));
}

/**
 * Pull verbatim per-pick rationales from agent_heartbeats.notes JSONB
 * for this ticker. The picker writes stage 2 picks as
 * `{picks: [{ticker, weight_pct, rationale}, ...]}` (and stage 1
 * shortlist as `{shortlist: [{ticker, rationale}, ...]}`).
 *
 * Returns at most `limit` rationales, newest first. Defensive against
 * a missing/empty notes structure — the JSONB shape can vary across
 * strategies (`dual_positive`, `momentum`, `llm_pick`).
 */
export async function getHeartbeatRationales(
  ticker: string,
  limit = 10,
): Promise<HeartbeatRationale[]> {
  const supabase = getSupabase();

  // Pull recent successful heartbeats whose notes mention the ticker.
  // Filtering on JSONB containment in the WHERE clause is fragile across
  // strategy variants, so we fetch the recent runs and extract in JS.
  const { data, error } = await supabase
    .from("agent_heartbeats")
    .select(
      "started_at, notes, agents!inner(handle, display_name)",
    )
    .in("status", ["ok", "dry-run"])
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) {
    // Defensive: don't break the page if the heartbeat table is
    // missing or restricted.
    console.error("agent_heartbeats lookup failed:", error.message);
    return [];
  }

  const out: HeartbeatRationale[] = [];
  const upper = ticker.toUpperCase();
  for (const row of (data ?? []) as unknown as Array<{
    started_at: string;
    notes: unknown;
    agents: { handle: string; display_name: string };
  }>) {
    const rationale = extractRationale(row.notes, upper);
    if (!rationale) continue;
    out.push({
      handle: row.agents.handle,
      display_name: row.agents.display_name,
      model_label: row.agents.display_name,
      rationale,
      started_at: row.started_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Walk a heartbeat's notes JSONB looking for a ticker-specific rationale.
 * Prefers stage 2 / single-pass picks (final allocation) over stage 1
 * (broader shortlist), since stage 2 is the agent's actual decision.
 * Returns the first non-empty rationale string found, or null.
 */
function extractRationale(notes: unknown, ticker: string): string | null {
  if (!notes || typeof notes !== "object") return null;
  const n = notes as Record<string, unknown>;

  for (const key of ["stage2", "single", "stage1"] as const) {
    const stage = n[key];
    if (!stage || typeof stage !== "object") continue;
    const items =
      (stage as { picks?: unknown[]; shortlist?: unknown[] }).picks ??
      (stage as { shortlist?: unknown[] }).shortlist;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const r = it as { ticker?: unknown; rationale?: unknown };
      if (typeof r.ticker !== "string" || r.ticker.toUpperCase() !== ticker) {
        continue;
      }
      if (typeof r.rationale === "string" && r.rationale.trim().length > 0) {
        return r.rationale.trim();
      }
    }
  }
  return null;
}

/**
 * Count buys for this ticker since a given ISO timestamp. Used by the
 * "Bulls won this week — N of M agents bought after last Sunday's eval"
 * line under the House Bull vs Bear section.
 */
export async function countBuysSince(
  ticker: string,
  sinceIso: string,
): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("agent_trades")
    .select("id", { count: "exact", head: true })
    .eq("ticker", ticker)
    .eq("side", "buy")
    .gte("executed_at", sinceIso);
  if (error) {
    console.error("countBuysSince failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Derivation helpers — pure functions on already-fetched page data so the
// /company/[ticker] page can compose AI Consensus + per-agent POV cards
// without any extra DB roundtrips.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Build one AgentPov per agent that currently holds OR has ever traded
 * this ticker. Caller must pass:
 *   - holders: full current state (from getCompanyHolders)
 *   - trades:  trade history broad enough to include the latest-per-agent
 *              for both current holders AND exiters (page bumps the limit)
 *   - rationales: latest heartbeat rationales (one per holder is enough)
 *   - currentPrice: companies.price, for the live P&L badge
 */
export function buildAgentPovs(
  holders: CompanyHolder[],
  trades: CompanyTrade[],
  rationales: HeartbeatRationale[],
  currentPrice: number | null,
): AgentPov[] {
  // Latest trade per agent — trades are already reverse-chrono so the
  // first occurrence wins.
  const latestByHandle = new Map<string, CompanyTrade>();
  for (const t of trades) {
    if (!latestByHandle.has(t.handle)) latestByHandle.set(t.handle, t);
  }

  const rationaleByHandle = new Map<string, HeartbeatRationale>();
  for (const r of rationales) {
    if (!rationaleByHandle.has(r.handle)) rationaleByHandle.set(r.handle, r);
  }

  const holderByHandle = new Map<string, CompanyHolder>();
  for (const h of holders) holderByHandle.set(h.handle, h);

  // Union of handles: every current holder + every historical trader.
  const handles = new Set<string>([
    ...holders.map((h) => h.handle),
    ...trades.map((t) => t.handle),
  ]);

  const povs: AgentPov[] = [];
  for (const handle of handles) {
    const holder = holderByHandle.get(handle);
    const latest = latestByHandle.get(handle);
    if (!holder && !latest) continue;

    const display_name = holder?.display_name ?? latest?.display_name ?? handle;
    const is_house_agent = holder?.is_house_agent ?? false;

    const holds = !!holder && holder.quantity > 0;
    const stance: AgentStance = holds
      ? latest?.side === "sell"
        ? "neutral"
        : "bullish"
      : "bearish";

    const position_qty = holds ? holder!.quantity : 0;
    const avg_entry = holds ? holder!.avg_cost_usd : null;
    const current_pnl_pct =
      holds && currentPrice != null && holder!.avg_cost_usd > 0
        ? ((currentPrice - holder!.avg_cost_usd) / holder!.avg_cost_usd) * 100
        : null;

    // Action label. "Trimmed" only makes sense when the agent still
    // holds after a sell — otherwise a sell is a full exit.
    let latest_action_label = "Holding";
    let latest_action_at: string | null = null;
    if (latest) {
      const verb = latest.side === "sell" ? (holds ? "Trimmed" : "Sold") : "Bought";
      latest_action_label = `${verb} ${formatRelativeShort(latest.executed_at)}`;
      latest_action_at = latest.executed_at;
    }

    // Prefer the heartbeat rationale when present (richer prose).
    // Fall back to the trade note (one-liner the strategy attached
    // to the buy/sell). Either may be null.
    const rationale =
      rationaleByHandle.get(handle)?.rationale ??
      latest?.note ??
      null;

    povs.push({
      handle,
      display_name,
      is_house_agent,
      stance,
      position_qty,
      avg_entry,
      current_pnl_pct,
      latest_action_label,
      latest_action_at,
      rationale,
    });
  }

  // Sort: bullish first, then neutral, then bearish; within each tier
  // descending by position size so the biggest current bet on each side
  // surfaces first.
  const stanceRank: Record<AgentStance, number> = {
    bullish: 0,
    neutral: 1,
    bearish: 2,
  };
  povs.sort((a, b) => {
    const dr = stanceRank[a.stance] - stanceRank[b.stance];
    if (dr !== 0) return dr;
    return b.position_qty - a.position_qty;
  });
  return povs;
}

/**
 * Page-level swarm verdict + a "what changed in the last 14 days"
 * one-sentence summary. Stays compact because it lives in the hero
 * area where vertical real estate is precious.
 */
export function buildCompanyConsensus(
  numAgents: number,
  totalAgents: number,
  trades: CompanyTrade[],
  holders: CompanyHolder[],
): CompanyConsensus {
  const verdict: CompanyConsensus["verdict"] =
    numAgents === 0
      ? "bearish"
      : totalAgents > 0 && numAgents / totalAgents >= 0.5
        ? "bullish"
        : "mixed";

  const cutoff = Date.now() - 14 * MS_PER_DAY;
  const holderHandles = new Set(holders.map((h) => h.handle));
  const seenByHandle = new Set<string>();
  const bought: string[] = [];
  const trimmed: string[] = [];
  const exited: string[] = [];

  // Walk reverse-chrono and bucket the first action per agent in the
  // window. "Trimmed" iff they still hold after the sell; "exited"
  // otherwise. "Bought" covers both new positions and add-ons.
  for (const t of trades) {
    if (new Date(t.executed_at).getTime() < cutoff) break;
    if (seenByHandle.has(t.handle)) continue;
    seenByHandle.add(t.handle);
    if (t.side === "buy") {
      bought.push(t.display_name);
    } else if (holderHandles.has(t.handle)) {
      trimmed.push(t.display_name);
    } else {
      exited.push(t.display_name);
    }
  }

  const parts: string[] = [];
  if (bought.length) parts.push(`${joinNames(bought)} added`);
  if (trimmed.length) parts.push(`${joinNames(trimmed)} trimmed`);
  if (exited.length) parts.push(`${joinNames(exited)} exited`);
  const what_changed = parts.length
    ? `${capitalise(parts.join(", "))} in the last 14 days.`
    : "";

  return { verdict, what_changed };
}

function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function formatRelativeShort(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  const days = Math.floor(diffMs / MS_PER_DAY);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.max(0, Math.floor(diffMs / (1000 * 60)));
  return `${mins}m ago`;
}
