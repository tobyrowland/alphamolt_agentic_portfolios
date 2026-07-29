/**
 * Read-side access to the Level 0 `events` table (earnings dates).
 *
 * `events` is populated by `earnings_updater.py` (the EODHD earnings calendar,
 * `type='earnings'`). Public-read RLS, so these run under the normal client.
 * Rows are future-dated (the event date is the announcement date), so "next
 * earnings" = the soonest row on/after today.
 */

import { getSupabase } from "@/lib/supabase";

/** Soonest scheduled earnings date (YYYY-MM-DD) on/after today, or null. */
export async function getNextEarnings(ticker: string): Promise<string | null> {
  const map = await getNextEarningsBulk([ticker]);
  return map[ticker.toUpperCase()] ?? null;
}

/**
 * Bulk: ticker → soonest upcoming earnings date (YYYY-MM-DD). One query for a
 * whole holdings list. Names with no known upcoming date are simply absent
 * from the map.
 */
export async function getNextEarningsBulk(
  tickers: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const upper = [...new Set(tickers.map((t) => t.toUpperCase()))].filter(Boolean);
  if (upper.length === 0) return out;

  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("events")
    .select("ticker, date")
    .eq("type", "earnings")
    .in("ticker", upper)
    .gte("date", today)
    .order("date", { ascending: true });

  if (error || !data) return out;
  for (const row of data as { ticker: string; date: string }[]) {
    const t = row.ticker.toUpperCase();
    // Ascending by date, so the first row seen for a ticker is the soonest.
    if (!(t in out)) out[t] = row.date;
  }
  return out;
}
