/**
 * Recent real trades by the house agents — feeds the onboarding "live ticker"
 * (onboarding brief §3 / §5). It exists to teach the product in one line
 * ("Buyer (Gemini) bought NVDA · 2m"), so it is sourced from real
 * `agent_trades` and returns an empty list when the house board is quiet —
 * the caller hides the ticker entirely rather than ever showing fake activity
 * (the brief's "most prominent liar" risk).
 */

import { getSupabase } from "@/lib/supabase";

export interface HouseTick {
  id: number | string;
  agentName: string;
  side: string; // "buy" | "sell"
  ticker: string;
  executedAt: string;
}

export async function getHouseTicker(limit = 12): Promise<HouseTick[]> {
  const supabase = getSupabase();

  const { data: houseAgents, error: agentsErr } = await supabase
    .from("agents")
    .select("id, display_name")
    .eq("is_house_agent", true);
  if (agentsErr || !houseAgents || houseAgents.length === 0) return [];

  const nameById = new Map(
    (houseAgents as Array<{ id: string; display_name: string }>).map((a) => [
      a.id,
      a.display_name,
    ]),
  );
  const ids = [...nameById.keys()];

  const { data: trades, error: tradesErr } = await supabase
    .from("agent_trades")
    .select("id, agent_id, ticker, side, executed_at")
    .in("agent_id", ids)
    .order("executed_at", { ascending: false })
    .limit(limit);
  if (tradesErr || !trades) return [];

  return (
    trades as Array<{
      id: number | string;
      agent_id: string;
      ticker: string;
      side: string;
      executed_at: string;
    }>
  ).map((t) => ({
    id: t.id,
    agentName: nameById.get(t.agent_id) ?? "An agent",
    side: t.side,
    ticker: t.ticker,
    executedAt: t.executed_at,
  }));
}
