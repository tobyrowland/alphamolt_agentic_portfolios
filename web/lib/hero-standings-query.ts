/**
 * Server-side fetch for the homepage hero "standings" card.
 *
 * Computes month-to-date (MTD) alpha vs SPY for every public, non-house
 * swarm and returns the best and worst. Alpha = the swarm's MTD return
 * minus SPY's MTD return over the same window, so the card reads as
 * "outperformance vs the index this month", not raw return.
 *
 * The two cells are the *spread* — top swarm and bottom swarm — rather
 * than a single cherry-picked number, which is the signature of the
 * hero redesign (see hero-redesign-brief.md).
 *
 * Fallback contract: if the data is missing or fewer than two swarms
 * have a computable MTD alpha, `top`/`bottom` come back null and the
 * card renders em-dashes while keeping the compliance footer. We never
 * fabricate numbers.
 */

import { unstable_cache } from "next/cache";
import { getSupabase } from "@/lib/supabase";

export interface HeroStanding {
  handle: string;
  name: string;
  /** MTD alpha vs SPY, in percentage points (e.g. 9.78 = +9.78pp). */
  alpha: number;
  positions: number;
}

export interface HeroStandings {
  top: HeroStanding | null;
  bottom: HeroStanding | null;
}

const SPY_TICKER = "SPY.US";

// First calendar day of the current UTC month — the MTD anchor date.
function monthStartIso(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function pctReturn(anchor: number, latest: number): number | null {
  if (!(anchor > 0)) return null;
  return ((latest - anchor) / anchor) * 100;
}

async function fetchHeroStandings(): Promise<HeroStandings> {
  const supabase = getSupabase();
  const now = new Date();
  const monthStart = monthStartIso(now);
  // Reach back a week before the month boundary so the anchor (the last
  // mark of the previous month) survives a weekend/holiday open.
  const sinceIso = (() => {
    const d = new Date(`${monthStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  // SPY MTD return — the benchmark we subtract from every swarm.
  const spyReturn = await fetchSpyMtdReturn(supabase, monthStart, sinceIso);
  if (spyReturn == null) return { top: null, bottom: null };

  // Public, competing swarms (house agents excluded, matching the
  // homepage leaderboard's scope).
  const { data: lbRows } = await supabase
    .from("agent_leaderboard")
    .select("handle, display_name")
    .eq("is_public", true)
    .eq("is_house_agent", false);
  const swarms = (lbRows ?? []) as Array<{
    handle: string;
    display_name: string;
  }>;
  if (swarms.length < 2) return { top: null, bottom: null };

  // Resolve handle → agent_id so we can pull each swarm's snapshot history.
  const { data: idRows } = await supabase
    .from("agents")
    .select("id, handle")
    .in(
      "handle",
      swarms.map((s) => s.handle),
    );
  const handleById = new Map<string, string>();
  const idByHandle = new Map<string, string>();
  for (const r of (idRows ?? []) as Array<{ id: string; handle: string }>) {
    handleById.set(r.id, r.handle);
    idByHandle.set(r.handle, r.id);
  }
  const agentIds = Array.from(handleById.keys());
  if (agentIds.length === 0) return { top: null, bottom: null };

  // One bulk pull of every candidate swarm's snapshots from a week before
  // the month boundary onward.
  const { data: histRows } = await supabase
    .from("agent_portfolio_history")
    .select("agent_id, snapshot_date, total_value_usd, num_positions")
    .in("agent_id", agentIds)
    .gte("snapshot_date", sinceIso)
    .order("snapshot_date", { ascending: true });

  // Group snapshots by handle in date order.
  const byHandle = new Map<
    string,
    Array<{ date: string; value: number; positions: number }>
  >();
  for (const r of (histRows ?? []) as Array<{
    agent_id: string;
    snapshot_date: string;
    total_value_usd: number | string;
    num_positions: number | string | null;
  }>) {
    const handle = handleById.get(r.agent_id);
    if (!handle) continue;
    let bucket = byHandle.get(handle);
    if (!bucket) {
      bucket = [];
      byHandle.set(handle, bucket);
    }
    bucket.push({
      date: r.snapshot_date,
      value: Number(r.total_value_usd),
      positions: Number(r.num_positions ?? 0),
    });
  }

  const nameByHandle = new Map(
    swarms.map((s) => [s.handle, s.display_name] as const),
  );

  const standings: HeroStanding[] = [];
  for (const [handle, snaps] of byHandle) {
    if (snaps.length === 0) continue;
    // Anchor = the last mark on or before the month boundary (the close
    // of the prior month). If the swarm was created this month it has no
    // such mark — fall back to its earliest snapshot so MTD is measured
    // from inception rather than skipping the swarm.
    let anchor: number | null = null;
    for (const s of snaps) {
      if (s.date < monthStart) anchor = s.value;
      else break;
    }
    if (anchor == null) anchor = snaps[0].value;

    const latest = snaps[snaps.length - 1];
    const swarmReturn = pctReturn(anchor, latest.value);
    if (swarmReturn == null) continue;

    standings.push({
      handle,
      name: nameByHandle.get(handle) ?? handle,
      alpha: swarmReturn - spyReturn,
      positions: latest.positions,
    });
  }

  if (standings.length < 2) return { top: null, bottom: null };

  let top = standings[0];
  let bottom = standings[0];
  for (const s of standings) {
    if (s.alpha > top.alpha) top = s;
    if (s.alpha < bottom.alpha) bottom = s;
  }
  return { top, bottom };
}

// SPY's MTD return in percentage points, or null if prices are missing.
async function fetchSpyMtdReturn(
  supabase: ReturnType<typeof getSupabase>,
  monthStart: string,
  sinceIso: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("benchmark_prices")
    .select("price_date, close")
    .eq("ticker", SPY_TICKER)
    .gte("price_date", sinceIso)
    .order("price_date", { ascending: true });
  const prices = ((data ?? []) as Array<{
    price_date: string;
    close: number | string;
  }>).map((p) => ({ date: p.price_date, close: Number(p.close) }));
  if (prices.length === 0) return null;

  // Anchor = last close on or before the month boundary (prior month's
  // last trading day); fall back to the earliest close in the window.
  let anchor: number | null = null;
  for (const p of prices) {
    if (p.date < monthStart) anchor = p.close;
    else break;
  }
  if (anchor == null) anchor = prices[0].close;

  const latest = prices[prices.length - 1].close;
  return pctReturn(anchor, latest);
}

export const getHeroStandings = unstable_cache(
  fetchHeroStandings,
  ["hero-standings-v1"],
  {
    revalidate: 600,
    tags: ["leaderboard"],
  },
);
