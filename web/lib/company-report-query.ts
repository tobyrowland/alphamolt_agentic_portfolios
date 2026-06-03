/**
 * Derivations for the rebuilt /company/{ticker} reporting page
 * (company-page brief). Everything here is BEHAVIOURAL — it reports what
 * the AI agents *did* (watchlisted / bought / hold / sold) and the
 * recorded reasons, never a rating or recommendation in AlphaMolt's own
 * voice (brief §0.A, §3).
 *
 * Reuses the existing bulk reads in `company-agents-query.ts`
 * (getCompanyHolders / getCompanyTradeTape). Adds the per-ticker active
 * theses + watchlist count, and pure builders for the header summary,
 * the lifecycle counts, the "what the agents did" block, and the factual
 * sell-trigger line.
 */

import { getSupabase } from "@/lib/supabase";
import type { CompanyHolder, CompanyTrade } from "@/lib/company-agents-query";
import type { ThesisSignal } from "@/lib/theses-query";
import type { Company, PriceSales } from "@/lib/types";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface ActiveThesis {
  ticker: string;
  handle: string;
  display_name: string;
  thesis_text: string | null;
  break_signals: ThesisSignal[] | null;
  snapshot: Record<string, unknown> | null;
  opened_at: string;
}

/** Currently-active theses for one ticker, joined to the agent. Used for
 *  buy-side reasons + the machine-checkable sell triggers. */
export async function getActiveThesesForTicker(
  ticker: string,
): Promise<ActiveThesis[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("investment_theses")
    .select(
      "ticker, thesis_text, break_signals, snapshot, opened_at, " +
        "agents!inner(handle, display_name)",
    )
    .eq("ticker", ticker)
    .eq("status", "active")
    .order("opened_at", { ascending: false });

  if (error) {
    console.error("getActiveThesesForTicker failed:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Array<{
    ticker: string;
    thesis_text: string | null;
    break_signals: ThesisSignal[] | null;
    snapshot: Record<string, unknown> | null;
    opened_at: string;
    agents: { handle: string; display_name: string };
  }>).map((r) => ({
    ticker: r.ticker,
    handle: r.agents.handle,
    display_name: r.agents.display_name,
    thesis_text: r.thesis_text,
    break_signals: Array.isArray(r.break_signals) ? r.break_signals : null,
    snapshot: r.snapshot ?? null,
    opened_at: r.opened_at,
  }));
}

/** How many portfolios currently shortlist this ticker (the "watchlisted"
 *  step of the lifecycle). Counts distinct portfolio_watchlist rows. */
export async function getWatchlistCount(ticker: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("portfolio_watchlist")
    .select("portfolio_id", { count: "exact", head: true })
    .eq("ticker", ticker);
  if (error) {
    console.error("getWatchlistCount failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Lifecycle counts — watchlisted › bought › holding › sold
// ---------------------------------------------------------------------------

export interface Lifecycle {
  watchlisted: number;
  bought: number; // distinct agents that ever bought
  holding: number; // distinct agents currently holding
  sold: number; // distinct agents that bought then fully exited
}

export function buildLifecycle(
  holders: CompanyHolder[],
  trades: CompanyTrade[],
  watchlisted: number,
): Lifecycle {
  const buyers = new Set<string>();
  for (const t of trades) if (t.side === "buy") buyers.add(t.handle);
  const holdingHandles = new Set(
    holders.filter((h) => h.quantity > 0).map((h) => h.handle),
  );
  let sold = 0;
  for (const h of buyers) if (!holdingHandles.has(h)) sold += 1;
  return {
    watchlisted,
    bought: buyers.size,
    holding: holdingHandles.size,
    sold,
  };
}

// ---------------------------------------------------------------------------
// Behavioural status — "Net selling · 14d" / "Net buying · 14d" / hold ratio
// ---------------------------------------------------------------------------

export interface BehaviouralStatus {
  // Short label for the badge, e.g. "NET SELLING · 14D".
  label: string;
  // Longer descriptor for the aria/title attribute.
  detail: string;
}

export function buildBehaviouralStatus(
  trades: CompanyTrade[],
  lifecycle: Lifecycle,
  totalAgents: number,
): BehaviouralStatus {
  const cutoff = Date.now() - 14 * MS_PER_DAY;
  const firstActionInWindow = new Map<string, "buy" | "sell">();
  for (const t of trades) {
    if (new Date(t.executed_at).getTime() < cutoff) break; // reverse-chrono
    if (!firstActionInWindow.has(t.handle)) {
      firstActionInWindow.set(t.handle, t.side === "sell" ? "sell" : "buy");
    }
  }
  let buyers = 0;
  let sellers = 0;
  for (const side of firstActionInWindow.values()) {
    if (side === "buy") buyers += 1;
    else sellers += 1;
  }

  if (buyers === 0 && sellers === 0) {
    return {
      label: `${lifecycle.holding} of ${totalAgents} hold`,
      detail: `${lifecycle.holding} of ${totalAgents} agents currently hold a position; no trades in the last 14 days.`,
    };
  }
  if (buyers > sellers) {
    return {
      label: "Net buying · 14d",
      detail: `${buyers} agent(s) bought vs ${sellers} sold in the last 14 days.`,
    };
  }
  if (sellers > buyers) {
    return {
      label: "Net selling · 14d",
      detail: `${sellers} agent(s) sold vs ${buyers} bought in the last 14 days.`,
    };
  }
  return {
    label: "Mixed activity · 14d",
    detail: `${buyers} agent(s) bought and ${sellers} sold in the last 14 days.`,
  };
}

// ---------------------------------------------------------------------------
// Header summary line — templated from structured fields + agent_trades
// only. No numbers lifted from the AI narrative (brief §3, §7).
// ---------------------------------------------------------------------------

export function buildSummaryLine(
  company: Company,
  priceSales: PriceSales | null,
  lifecycle: Lifecycle,
): string {
  const ticker = company.ticker;
  const parts: string[] = [];

  if (lifecycle.bought === 0) {
    parts.push(`No agent has taken a position in ${ticker}.`);
  } else {
    const agentWord = lifecycle.bought === 1 ? "agent has" : "agents have";
    let s = `${lifecycle.bought} ${agentWord} bought ${ticker}`;
    const tail: string[] = [];
    if (lifecycle.holding > 0) tail.push(`${lifecycle.holding} still hold`);
    if (lifecycle.sold > 0) tail.push(`${lifecycle.sold} have exited`);
    if (tail.length) s += `; ${tail.join(" and ")}`;
    parts.push(`${s}.`);
  }

  // P/S sentence — strictly from price_sales / companies fields.
  const ps = company.ps_now ?? priceSales?.ps_now ?? null;
  const median = priceSales?.median_12m ?? null;
  if (ps != null) {
    let psSentence = `Its price-to-sales multiple is ${ps.toFixed(2)}×`;
    if (median != null && median > 0) {
      const pct = Math.round(((ps - median) / median) * 100);
      const dir = pct >= 0 ? "above" : "below";
      psSentence += ` — ${Math.abs(pct)}% ${dir} its 12-month median of ${median.toFixed(2)}×`;
    }
    parts.push(`${psSentence}.`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// "What the agents did" — bought-reasons vs sold-reasons from real theses
// and trade notes (brief §3).
// ---------------------------------------------------------------------------

export interface ReasonGroup {
  count: number;
  agents: string[]; // display names
  reasons: string[]; // distinct recorded rationales
}

function dedupeReasons(raw: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const t = (r ?? "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function buildBoughtReasons(
  trades: CompanyTrade[],
  theses: ActiveThesis[],
): ReasonGroup {
  const buyers = trades.filter((t) => t.side === "buy");
  const agents = dedupeReasons(buyers.map((t) => t.display_name));
  // Prefer agent-authored thesis text (richer), fall back to buy notes.
  const reasons = dedupeReasons([
    ...theses.map((t) => t.thesis_text),
    ...buyers.map((t) => t.note),
  ]).slice(0, 4);
  return {
    count: new Set(buyers.map((t) => t.handle)).size,
    agents,
    reasons,
  };
}

export function buildSoldReasons(
  holders: CompanyHolder[],
  trades: CompanyTrade[],
): ReasonGroup {
  const holding = new Set(
    holders.filter((h) => h.quantity > 0).map((h) => h.handle),
  );
  // Sellers who fully exited — the genuine "sold" cohort.
  const sells = trades.filter(
    (t) => t.side === "sell" && !holding.has(t.handle),
  );
  const agents = dedupeReasons(sells.map((t) => t.display_name));
  const reasons = dedupeReasons(sells.map((t) => t.note)).slice(0, 4);
  return {
    count: new Set(sells.map((t) => t.handle)).size,
    agents,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Factual sell-trigger line — the machine-checkable break thresholds the
// current holders recorded, checked against the live company values
// (brief §3, §4). Mirrors theses._evaluate_signal in Python.
// ---------------------------------------------------------------------------

export interface SellTrigger {
  label: string; // "rev growth < 30"
  tripped: boolean;
}

export interface SellTriggerLine {
  // Empty when no current holder recorded a machine-checkable break signal.
  triggers: SellTrigger[];
  trippedCount: number;
}

const SIGNAL_FIELD_LABELS: Record<string, string> = {
  rev_growth_ttm_pct: "rev growth",
  rev_growth_qoq_pct: "rev growth QoQ",
  rule_of_40: "R40",
  gross_margin_pct: "gross margin",
  fcf_margin_pct: "FCF margin",
  net_margin_pct: "net margin",
  operating_margin_pct: "op margin",
  ps_now: "P/S",
  composite_score: "score",
  perf_52w_vs_spy: "52w vs SPY",
  price: "price",
};

function coerceNumber(v: unknown): number | null {
  if (v == null || v === "—") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function signalLabel(sig: ThesisSignal): string {
  const field = SIGNAL_FIELD_LABELS[sig.field] ?? sig.field;
  const op = sig.op;
  if (op === "change_pct_lt") return `${field} Δ < ${sig.value}`;
  if (op === "change_pct_gt") return `${field} Δ > ${sig.value}`;
  return `${field} ${op} ${sig.value}`;
}

/** Port of theses._evaluate_signal: true ⇒ the break condition currently
 *  holds (the thesis is broken). `current` is the live companies row;
 *  `snapshot` is the thesis's frozen buy-time state (for change_pct). */
function evaluateSignal(
  sig: ThesisSignal,
  snapshot: Record<string, unknown> | null,
  current: Record<string, unknown>,
): boolean {
  const { field, op, value } = sig;
  if (!field || !op) return false;
  const cur = coerceNumber(current[field]);
  if (cur == null) return false;
  const threshold = coerceNumber(value);
  switch (op) {
    case ">":
      return threshold != null && cur > threshold;
    case ">=":
      return threshold != null && cur >= threshold;
    case "<":
      return threshold != null && cur < threshold;
    case "<=":
      return threshold != null && cur <= threshold;
    case "==":
      return threshold != null && cur === threshold;
    case "!=":
      return threshold != null && cur !== threshold;
    case "change_pct_lt":
    case "change_pct_gt": {
      const snap = coerceNumber(snapshot?.[field]);
      if (snap == null || threshold == null) return false;
      const delta = cur - snap;
      return op === "change_pct_lt" ? delta < threshold : delta > threshold;
    }
    default:
      return false;
  }
}

export function buildSellTriggerLine(
  theses: ActiveThesis[],
  company: Company,
): SellTriggerLine {
  const current = company as unknown as Record<string, unknown>;
  const byKey = new Map<string, SellTrigger>();
  for (const thesis of theses) {
    for (const sig of thesis.break_signals ?? []) {
      if (!sig?.field || !sig?.op) continue;
      const key = `${sig.field}|${sig.op}|${sig.value}`;
      const tripped = evaluateSignal(sig, thesis.snapshot, current);
      const existing = byKey.get(key);
      if (existing) {
        existing.tripped = existing.tripped || tripped;
      } else {
        byKey.set(key, { label: signalLabel(sig), tripped });
      }
    }
  }
  const triggers = [...byKey.values()];
  return {
    triggers,
    trippedCount: triggers.filter((t) => t.tripped).length,
  };
}
