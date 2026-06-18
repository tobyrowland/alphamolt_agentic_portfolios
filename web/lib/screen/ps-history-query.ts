/**
 * P/S 12-month history for the screener sparkline (redesign brief §5).
 *
 * The 12-mo P/S *series* is deliberately NOT in screen_facts_mv (the matview
 * excludes the big JSONB for speed — migration 044/057). So the sparkline reads
 * it per-ticker, lazily, only when a row is expanded — fetched CLIENT-SIDE after
 * the cached page paints (the same pattern as the holdings overlay), so the
 * public ISR-cached page stays identical for every viewer.
 *
 * Source: Level 0 `valuation.history_json` (covers ~all Tier-1 names), with the
 * legacy `price_sales.history_json` as a fallback. Both store `[[date, ps], …]`
 * weekly tuples; some rows use `{date, ps}` objects — normalise both (mirrors
 * web/components/ps-valuation-chart.tsx).
 */

import { getSupabase } from "@/lib/supabase";

export interface PsPoint {
  date: string;
  ps: number;
}

type RawRow = [string, number] | { date?: unknown; ps?: unknown };

function normalise(history: unknown): PsPoint[] {
  if (!Array.isArray(history)) return [];
  const out: PsPoint[] = [];
  for (const row of history as RawRow[]) {
    if (Array.isArray(row)) {
      const [date, ps] = row;
      if (typeof date === "string" && typeof ps === "number" && Number.isFinite(ps)) {
        out.push({ date, ps });
      }
    } else if (row && typeof row.date === "string" && typeof row.ps === "number") {
      out.push({ date: row.date, ps: row.ps });
    }
  }
  return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/** Weekly P/S series for one ticker, newest last. Empty when no history. */
export async function getPsHistory(ticker: string): Promise<PsPoint[]> {
  const supabase = getSupabase();
  const t = ticker.toUpperCase();

  const { data: vrow } = await supabase
    .from("valuation")
    .select("history_json")
    .eq("ticker", t)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  let points = normalise((vrow as { history_json?: unknown } | null)?.history_json);

  if (points.length < 2) {
    const { data: prow } = await supabase
      .from("price_sales")
      .select("history_json")
      .eq("ticker", t)
      .maybeSingle();
    const legacy = normalise((prow as { history_json?: unknown } | null)?.history_json);
    if (legacy.length > points.length) points = legacy;
  }

  return points;
}
