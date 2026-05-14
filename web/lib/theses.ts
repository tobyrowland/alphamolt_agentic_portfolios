/**
 * TypeScript port of the investment-thesis recording path.
 *
 * Mirrors `theses.py` (the Python helper module used by house agents
 * running through `agent_heartbeat.py`). Together with the changes in
 * `web/lib/portfolio.ts`, this makes the snapshot capture **universal**:
 * every successful BUY records an `investment_theses` row regardless
 * of which code path executed the trade.
 *
 * The full Python module also exposes `check_thesis` / `mark_thesis_status`
 * for the maintenance check loop — those aren't needed by the public
 * buy/sell endpoints so they're intentionally not ported here. Read-side
 * access to investment_theses on the website goes through
 * `web/lib/theses-query.ts`.
 *
 * See `migrations/020_investment_theses.sql` for the table contract.
 */

import { getSupabase } from "@/lib/supabase";

export interface ThesisSignal {
  field: string;
  op: string;
  value: number | string;
  description?: string;
}

export interface ThesisInput {
  thesis_text?: string | null;
  extend_signals?: ThesisSignal[] | null;
  break_signals?: ThesisSignal[] | null;
}

// Fields captured into the `snapshot` JSONB at buy time. Must stay in
// lock-step with `_SNAPSHOT_FIELDS` in theses.py — keep them sorted the
// same way so a diff is easy to read.
const SNAPSHOT_FIELDS = [
  // Identity / overview
  "ticker", "company_name", "country", "sector",
  // Fundamentals (extended tier)
  "rating", "r40_score", "rule_of_40",
  "rev_growth_ttm_pct", "rev_growth_qoq_pct", "rev_cagr_pct",
  "rev_consistency_score",
  "gross_margin_pct", "operating_margin_pct", "net_margin_pct",
  "net_margin_yoy_pct", "fcf_margin_pct",
  "opex_pct_revenue", "sm_rd_pct_revenue",
  "eps_only", "eps_yoy_pct", "qrtrs_to_profitability",
  "gm_trend",
  // Valuation
  "price", "ps_now", "price_pct_of_52w_high",
  // Momentum
  "perf_52w_vs_spy", "composite_score",
  // Narrative
  "short_outlook", "key_risks", "full_outlook", "bull_eval", "bear_eval",
  "status",
  // Quality flags + audit
  "flags", "ai_analyzed_at",
] as const;

/** Read the latest companies row + reduce it to the snapshot field set. */
async function buildSnapshot(ticker: string): Promise<Record<string, unknown>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("ticker", ticker)
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    // Caller should already have validated the ticker (buy() resolves the
    // price via getPrice first), so this is a hard error. Still throw a
    // recognisable shape so callers can decide whether to swallow.
    throw new Error(`buildSnapshot: no companies row for ${ticker}`);
  }
  const row = data as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const field of SNAPSHOT_FIELDS) {
    snapshot[field] = row[field] ?? null;
  }
  return snapshot;
}

/**
 * Record a thesis row for a freshly-executed BUY.
 *
 * Always captures the snapshot. If any of `thesis_text` /
 * `extend_signals` / `break_signals` is provided, `source='agent'`;
 * otherwise `source='auto'`. Marks any prior `active` row for the same
 * (agentId, ticker) as `superseded`.
 *
 * Returns the new thesis id, or null if the insert silently no-op'd
 * (e.g. RLS rejection — but the snapshot insert runs under the
 * service-role key, so this shouldn't happen in practice).
 */
export async function recordThesis(opts: {
  agentId: string;
  ticker: string;
  tradeId: number | null;
  thesis?: ThesisInput | null;
}): Promise<number | null> {
  const supabase = getSupabase();
  const snapshot = await buildSnapshot(opts.ticker);

  // Supersede any prior active row for this (agent, ticker).
  await supabase
    .from("investment_theses")
    .update({
      status: "superseded",
      status_changed_at: new Date().toISOString(),
    })
    .eq("agent_id", opts.agentId)
    .eq("ticker", opts.ticker)
    .eq("status", "active");

  const text = opts.thesis?.thesis_text ?? null;
  const extend = opts.thesis?.extend_signals ?? null;
  const breakSig = opts.thesis?.break_signals ?? null;
  const source = text || extend || breakSig ? "agent" : "auto";

  const { data, error } = await supabase
    .from("investment_theses")
    .insert({
      agent_id: opts.agentId,
      ticker: opts.ticker,
      trade_id: opts.tradeId,
      snapshot,
      thesis_text: text,
      extend_signals: extend,
      break_signals: breakSig,
      source,
      status: "active",
    })
    .select("id")
    .single();

  if (error || !data) {
    // Don't blow up the buy on a thesis-recording failure — log and move on.
    // Matches the Python side's exception-safe wrapper.
    console.error("recordThesis insert failed:", error);
    return null;
  }
  return (data as { id: number }).id;
}

/**
 * Flip all non-closed theses for (agentId, ticker) to `status='closed'`.
 * Called from `sell()` after the position is zeroed out. Idempotent —
 * a no-op if there are no matching rows (e.g. legacy positions opened
 * before migration 020).
 */
export async function closeThesesForPosition(opts: {
  agentId: string;
  ticker: string;
}): Promise<void> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("investment_theses")
    .update({
      status: "closed",
      status_changed_at: now,
      closed_at: now,
    })
    .eq("agent_id", opts.agentId)
    .eq("ticker", opts.ticker)
    .neq("status", "closed");
  if (error) {
    console.error("closeThesesForPosition update failed:", error);
  }
}
