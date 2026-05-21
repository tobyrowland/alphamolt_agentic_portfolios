/**
 * Picks one recent `investment_theses` row to showcase the thesis-drift
 * feature on the logged-out homepage. Read-only — does not mutate.
 *
 * Strategy: prefer agent-authored theses with break signals (most telling
 * example: original thesis + signal check vs current state). Fall back
 * through agent-authored / snapshot-only rows so we still show *something*
 * if the picky case isn't populated yet.
 *
 * Returns null when there isn't a usable row — caller renders a static
 * explainer-only variant.
 */

import { getSupabase } from "@/lib/supabase";

export interface ThesisSignal {
  field: string;
  op: string;
  value: number | string;
  description?: string;
}

export interface DriftField {
  field: string;
  label: string;
  snapshot: number | null;
  current: number | null;
  /** Percentage-point delta (current - snapshot). Null when either side is null. */
  delta: number | null;
  /** Pretty-formatter hint for the cell. */
  format: "pct" | "ratio" | "score";
}

export interface ThesisDriftExample {
  agent_handle: string;
  agent_display_name: string;
  ticker: string;
  company_name: string;
  opened_at: string;
  status: "active" | "broken" | "improved" | "superseded" | "closed";
  source: "agent" | "auto";
  thesis_text: string | null;
  /** Up to 3 break signals + whether each is currently triggered. */
  break_signal_checks: { signal: ThesisSignal; triggered: boolean }[];
  /** Up to ~4 headline fields with snapshot vs current. */
  drift: DriftField[];
  /** Verdict computed live from snapshot + companies row. */
  verdict: "active" | "broken" | "improved";
}

// Fields we surface in the drift comparison, in priority order. Picks the
// first ~4 that actually have both snapshot + current populated.
const DRIFT_CANDIDATES: { field: string; label: string; format: DriftField["format"] }[] = [
  { field: "composite_score", label: "Composite score", format: "score" },
  { field: "rev_growth_ttm_pct", label: "Revenue growth TTM", format: "pct" },
  { field: "gross_margin_pct", label: "Gross margin", format: "pct" },
  { field: "rule_of_40", label: "Rule of 40", format: "score" },
  { field: "ps_now", label: "P/S ratio", format: "ratio" },
  { field: "price_pct_of_52w_high", label: "% of 52w high", format: "pct" },
];

interface RawThesisRow {
  id: number;
  agent_id: string;
  ticker: string;
  status: string;
  source: string;
  opened_at: string;
  thesis_text: string | null;
  snapshot: Record<string, unknown> | null;
  break_signals: ThesisSignal[] | null;
}

export async function getThesisDriftExample(): Promise<ThesisDriftExample | null> {
  const supabase = getSupabase();

  // Three-tiered pull: best-case rows first, then progressively looser
  // fallbacks. Stop as soon as one tier returns rows. Each query is
  // bounded so the page stays fast even if the table grows.
  const SELECT =
    "id, agent_id, ticker, status, source, opened_at, thesis_text, snapshot, break_signals";

  let candidates: RawThesisRow[] = [];
  for (let tier = 0; tier < 3 && candidates.length === 0; tier++) {
    let q = supabase
      .from("investment_theses")
      .select(SELECT)
      .order("opened_at", { ascending: false })
      .limit(20);
    if (tier === 0) {
      // Best case: agent-authored, active, has break_signals.
      q = q
        .eq("source", "agent")
        .eq("status", "active")
        .not("break_signals", "is", null);
    } else if (tier === 1) {
      // Next: any active agent-authored thesis.
      q = q.eq("source", "agent").eq("status", "active");
    } else {
      // Last resort: any active thesis (snapshot-only is still useful).
      q = q.eq("status", "active");
    }
    const { data, error } = await q;
    if (error) {
      console.error(`thesis drift tier ${tier} fetch failed:`, error);
      continue;
    }
    candidates = (data ?? []) as unknown as RawThesisRow[];
  }

  if (candidates.length === 0) return null;

  // Resolve agent handle/display_name + current companies row for each
  // candidate in two bulk lookups, then pick the first one where both
  // resolved successfully.
  const agentIds = Array.from(new Set(candidates.map((c) => c.agent_id)));
  const tickers = Array.from(new Set(candidates.map((c) => c.ticker)));

  const { data: agentRows } = await supabase
    .from("agents")
    .select("id, handle, display_name, is_house_agent")
    .in("id", agentIds);
  const agentById = new Map<
    string,
    { handle: string; display_name: string; is_house_agent: boolean }
  >();
  for (const r of (agentRows ?? []) as {
    id: string;
    handle: string;
    display_name: string;
    is_house_agent: boolean;
  }[]) {
    agentById.set(r.id, {
      handle: r.handle,
      display_name: r.display_name,
      is_house_agent: r.is_house_agent,
    });
  }

  const { data: companyRows } = await supabase
    .from("companies")
    .select(
      "ticker, company_name, composite_score, rev_growth_ttm_pct, gross_margin_pct, " +
        "rule_of_40, ps_now, price_pct_of_52w_high",
    )
    .in("ticker", tickers);
  const companyByTicker = new Map<string, Record<string, unknown>>();
  for (const r of (companyRows ?? []) as unknown as (Record<string, unknown> & {
    ticker: string;
  })[]) {
    companyByTicker.set(r.ticker, r);
  }

  for (const c of candidates) {
    const agent = agentById.get(c.agent_id);
    const company = companyByTicker.get(c.ticker);
    if (!agent || !company) continue;

    const snapshot = (c.snapshot ?? {}) as Record<string, unknown>;
    const drift = buildDrift(snapshot, company);
    // Need at least two comparable fields for the drift card to feel
    // substantive — otherwise the panel looks empty.
    if (drift.length < 2) continue;

    const signals = (c.break_signals ?? []).slice(0, 3);
    const break_signal_checks = signals.map((sig) => ({
      signal: sig,
      triggered: evaluateSignal(sig, snapshot, company),
    }));

    const triggeredBreaks = break_signal_checks.filter((s) => s.triggered);
    const verdict: ThesisDriftExample["verdict"] =
      triggeredBreaks.length > 0 ? "broken" : "active";

    return {
      agent_handle: agent.handle,
      agent_display_name: agent.display_name,
      ticker: c.ticker,
      company_name: (company.company_name as string) ?? c.ticker,
      opened_at: c.opened_at,
      status: (c.status as ThesisDriftExample["status"]) ?? "active",
      source: c.source === "agent" ? "agent" : "auto",
      thesis_text: c.thesis_text,
      break_signal_checks,
      drift,
      verdict,
    };
  }

  return null;
}

function buildDrift(
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
): DriftField[] {
  const out: DriftField[] = [];
  for (const c of DRIFT_CANDIDATES) {
    const s = toNum(snapshot[c.field]);
    const cur = toNum(current[c.field]);
    if (s == null && cur == null) continue;
    // Skip cases where both sides are identical — no signal to show.
    if (s != null && cur != null && Math.abs(s - cur) < 0.01) continue;
    out.push({
      field: c.field,
      label: c.label,
      snapshot: s,
      current: cur,
      delta: s != null && cur != null ? cur - s : null,
      format: c.format,
    });
    if (out.length >= 4) break;
  }
  return out;
}

// Tiny port of theses.py `_evaluate_signal`. Same operators, same
// "missing field returns false (conservative)" semantics.
const STATIC_OPS: Record<string, (c: number, t: number) => boolean> = {
  ">": (c, t) => c > t,
  ">=": (c, t) => c >= t,
  "<": (c, t) => c < t,
  "<=": (c, t) => c <= t,
  "==": (c, t) => c === t,
  "!=": (c, t) => c !== t,
};

function evaluateSignal(
  signal: ThesisSignal,
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  const { field, op, value } = signal;
  if (!field || !op) return false;
  const currentValue = toNum(current[field]);
  if (currentValue == null) return false;

  if (op in STATIC_OPS) {
    const threshold = toNum(value);
    if (threshold == null) return false;
    return STATIC_OPS[op](currentValue, threshold);
  }
  if (op === "change_pct_lt" || op === "change_pct_gt") {
    const snapshotValue = toNum(snapshot[field]);
    const threshold = toNum(value);
    if (snapshotValue == null || threshold == null) return false;
    const deltaPp = currentValue - snapshotValue;
    return op === "change_pct_lt" ? deltaPp < threshold : deltaPp > threshold;
  }
  return false;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
