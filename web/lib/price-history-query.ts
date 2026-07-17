/**
 * Daily close history for one ticker off Level 0's `prices_daily` (public-read
 * RLS) — powers the holdings dropdown's "price since buy" sparkline. The table
 * holds ~2y per Tier-1 name, well under one PostgREST page.
 */

import { getSupabase } from "@/lib/supabase";

export interface PricePoint {
  date: string; // YYYY-MM-DD
  close: number;
}

export async function getPriceHistory(
  ticker: string,
  since: string,
): Promise<PricePoint[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("prices_daily")
    .select("date, close")
    .eq("ticker", ticker.toUpperCase())
    .gte("date", since)
    .order("date", { ascending: true });

  if (error) {
    console.error("getPriceHistory failed:", error);
    return [];
  }
  return ((data ?? []) as { date: string; close: unknown }[])
    .map((r) => ({ date: r.date, close: Number(r.close) }))
    .filter((p) => Number.isFinite(p.close) && p.close > 0);
}
