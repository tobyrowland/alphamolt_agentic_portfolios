/**
 * Activity log — a read-only, unified timeline over the records the pipeline
 * already writes, surfaced behind the "Activity" drawer on the screener and
 * portfolio pages (faith-in-the-system brief). Nothing here writes; it merely
 * re-shapes existing rows into a single `ActivityEvent[]` the client renders.
 *
 * Two sources, two questions:
 *  - Portfolio: "what did my team do?" — `agent_heartbeats` (every real run,
 *    including the deliberate no-ops — cadence skips are never journaled, so
 *    each row is a genuine decision), `agent_trades` (the fills), and the
 *    owner-only `screener_rejections` (names a buyer passed on).
 *  - Screener: "what background data refreshes happened?" — `run_logs` for the
 *    jobs that feed the screen (prices, P/S, research cards, AI signals,
 *    universe membership).
 *
 * All reads use the service-role client; callers (API routes) are responsible
 * for access-gating before returning portfolio events to a viewer.
 */

import { getSupabase } from "@/lib/supabase";

/** One row in the activity timeline. The client renders this verbatim. */
export interface ActivityEvent {
  /** Stable key (table-prefixed row id) for React. */
  id: string;
  /** ISO timestamp the event happened at. */
  at: string;
  /** Short uppercase chip, e.g. "RAN" / "BUY" / "PASS" / "PRICES". */
  tag: string;
  /** Drives the left-stripe colour. */
  tone: "positive" | "negative" | "neutral" | "info";
  /** One-line summary. */
  title: string;
  /** Optional secondary line (the "roundup of what was decided"). */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Portfolio activity
// ---------------------------------------------------------------------------

interface HeartbeatRow {
  id: number | string;
  agent_id: string;
  strategy: string;
  status: string;
  started_at: string;
  trades_executed: number | null;
  buys: number | null;
  sells: number | null;
  notes: Record<string, unknown> | null;
  error_message: string | null;
}

interface TradeRow {
  id: number | string;
  agent_id: string;
  ticker: string;
  side: string;
  quantity: number | string;
  price_usd: number | string;
  executed_at: string;
  note: string | null;
}

interface RejectionRow {
  ticker: string;
  rejected_at: string;
  rejected_by_agent_id: string | null;
  verdict: string | null;
  conviction: number | null;
  reason: string | null;
}

/**
 * Build the portfolio activity timeline. `ownerAgentId` is set for legacy 1:1
 * agent portfolios (heartbeats keyed by agent_id); human portfolios filter
 * heartbeats by the `notes.portfolio_id` stamp the heartbeat writes. Rejections
 * are owner-only (a private portfolio's pass list), so the caller gates
 * `includeRejections`.
 */
export async function getPortfolioActivity(
  portfolioId: string,
  ownerAgentId: string | null,
  { includeRejections }: { includeRejections: boolean },
  limit = 60,
): Promise<ActivityEvent[]> {
  const supabase = getSupabase();

  let heartbeatQuery = supabase
    .from("agent_heartbeats")
    .select(
      "id, agent_id, strategy, status, started_at, trades_executed, buys, sells, notes, error_message",
    )
    // Drop operator dry-run rows — they're not real decisions.
    .neq("status", "dry-run")
    .order("started_at", { ascending: false })
    .limit(limit);
  heartbeatQuery = ownerAgentId
    ? heartbeatQuery.eq("agent_id", ownerAgentId)
    : heartbeatQuery.filter("notes->>portfolio_id", "eq", portfolioId);

  const [heartbeatsResp, tradesResp, rejectionsResp] = await Promise.all([
    heartbeatQuery,
    supabase
      .from("agent_trades")
      .select("id, agent_id, ticker, side, quantity, price_usd, executed_at, note")
      .eq("portfolio_id", portfolioId)
      .order("executed_at", { ascending: false })
      .limit(limit),
    includeRejections
      ? supabase
          .from("screener_rejections")
          .select("ticker, rejected_at, rejected_by_agent_id, verdict, conviction, reason")
          .eq("portfolio_id", portfolioId)
          .eq("verdict", "PASS")
          .order("rejected_at", { ascending: false })
          .limit(limit)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const heartbeats = (heartbeatsResp.data as HeartbeatRow[] | null) ?? [];
  const trades = (tradesResp.data as TradeRow[] | null) ?? [];
  const rejections = (rejectionsResp.data as RejectionRow[] | null) ?? [];

  const agentNames = await loadAgentNames(
    new Set<string>([
      ...heartbeats.map((h) => h.agent_id),
      ...trades.map((t) => t.agent_id),
      ...rejections.map((r) => r.rejected_by_agent_id ?? "").filter(Boolean),
    ]),
  );

  const events: ActivityEvent[] = [
    ...heartbeats.map((h) => heartbeatEvent(h, agentNames)),
    ...trades.map((t) => tradeEvent(t, agentNames)),
    ...rejections.map((r) => rejectionEvent(r, agentNames)),
  ];

  return events
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

async function loadAgentNames(ids: Set<string>): Promise<Map<string, string>> {
  const list = [...ids].filter(Boolean);
  if (list.length === 0) return new Map();
  const { data } = await getSupabase()
    .from("agents")
    .select("id, display_name")
    .in("id", list);
  return new Map(
    ((data as { id: string; display_name: string }[] | null) ?? []).map((a) => [
      a.id,
      a.display_name,
    ]),
  );
}

function heartbeatEvent(
  h: HeartbeatRow,
  names: Map<string, string>,
): ActivityEvent {
  const agent = names.get(h.agent_id) ?? "An agent";
  const notes = h.notes ?? {};
  const buys = h.buys ?? 0;
  const sells = h.sells ?? 0;

  if (h.status === "error") {
    return {
      id: `hb-${h.id}`,
      at: h.started_at,
      tag: "ERROR",
      tone: "negative",
      title: `${agent} hit an error`,
      detail: truncate(h.error_message ?? noteString(notes, "reason") ?? "see logs", 220),
    };
  }

  const parts: string[] = [];
  const evaluated = numNote(notes, "phase1_evaluations");
  if (evaluated != null) parts.push(`evaluated ${evaluated} candidate${evaluated === 1 ? "" : "s"}`);
  const reviewed = numNote(notes, "positions_reviewed");
  if (reviewed != null) parts.push(`reviewed ${reviewed} position${reviewed === 1 ? "" : "s"}`);
  if (buys > 0) parts.push(`bought ${buys}`);
  if (sells > 0) parts.push(`sold ${sells}`);
  const rejected = numNote(notes, "screener_rejections_recorded");
  if (rejected != null && rejected > 0) parts.push(`passed on ${rejected}`);
  if (buys === 0 && sells === 0) {
    const reason = noteString(notes, "reason");
    parts.push(reason ? reason : "no changes — held the book");
  }

  return {
    id: `hb-${h.id}`,
    at: h.started_at,
    tag: "RAN",
    tone: buys > 0 ? "positive" : "neutral",
    title: agent,
    detail: parts.join(" · "),
  };
}

function tradeEvent(t: TradeRow, names: Map<string, string>): ActivityEvent {
  const isBuy = t.side !== "sell";
  const agent = names.get(t.agent_id) ?? "An agent";
  const qty = fmtQty(Number(t.quantity));
  const price = Number(t.price_usd).toFixed(2);
  const detailBits = [`${qty} @ $${price}`, agent];
  if (t.note) detailBits.push(t.note);
  return {
    id: `tr-${t.id}`,
    at: t.executed_at,
    tag: isBuy ? "BUY" : "SELL",
    tone: isBuy ? "positive" : "negative",
    title: `${isBuy ? "Bought" : "Sold"} ${t.ticker}`,
    detail: detailBits.join(" · "),
  };
}

function rejectionEvent(
  r: RejectionRow,
  names: Map<string, string>,
): ActivityEvent {
  const agent = r.rejected_by_agent_id
    ? names.get(r.rejected_by_agent_id) ?? "A buyer"
    : "A buyer";
  const conv = r.conviction != null ? `conviction ${r.conviction}/5` : null;
  const detailBits = [agent];
  if (conv) detailBits.push(conv);
  if (r.reason) detailBits.push(truncate(r.reason, 180));
  return {
    id: `rj-${r.ticker}-${r.rejected_at}`,
    at: r.rejected_at,
    tag: "PASS",
    tone: "info",
    title: `Passed on ${r.ticker}`,
    detail: detailBits.join(" · "),
  };
}

// ---------------------------------------------------------------------------
// Screener / pipeline activity
// ---------------------------------------------------------------------------

interface RunLogRow {
  id: number | string;
  script_name: string;
  backfilled: number | null;
  updated: number | null;
  skipped: number | null;
  errors: number | null;
  duration_secs: number | null;
  created_at: string;
}

/**
 * The background jobs that shape what the screener shows, mapped to a
 * human-readable label + chip. Scripts not in this map are omitted from the
 * screener log (they don't affect the ranked table). `score_ai_analysis`,
 * `eodhd_updater` and `nightly_screen` don't yet write `run_logs`, so they
 * won't appear until they do — a deliberate "surface what's recorded" stance.
 */
const SCREENER_JOBS: Record<string, { tag: string; label: string }> = {
  research_evaluation: { tag: "RESEARCH", label: "Research cards refreshed" },
  bull_evaluation: { tag: "AI", label: "AI bull/bear signals refreshed" },
  prices_daily: { tag: "PRICES", label: "Daily prices updated" },
  price_sales_updater: { tag: "VALUE", label: "P/S valuation series updated" },
  universe_sync: { tag: "UNIVERSE", label: "Universe membership re-synced" },
  build_universe_snapshot: { tag: "DATA", label: "Universe snapshot built" },
  benchmarks_updater: { tag: "DATA", label: "Benchmarks (SPY/URTH) updated" },
  backfill_tier1_fundamentals: { tag: "DATA", label: "Fundamentals backfilled" },
  backfill_tier1_valuation: { tag: "DATA", label: "Valuation backfilled" },
};

export async function getScreenerActivity(limit = 60): Promise<ActivityEvent[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("run_logs")
    .select("id, script_name, backfilled, updated, skipped, errors, duration_secs, created_at")
    .in("script_name", Object.keys(SCREENER_JOBS))
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("getScreenerActivity failed:", error);
    return [];
  }

  return ((data as RunLogRow[] | null) ?? []).map((r) => {
    const job = SCREENER_JOBS[r.script_name];
    return {
      id: `rl-${r.id}`,
      at: r.created_at,
      tag: job.tag,
      tone: (r.errors ?? 0) > 0 ? "negative" : "info",
      title: job.label,
      detail: runLogDetail(r),
    } satisfies ActivityEvent;
  });
}

function runLogDetail(r: RunLogRow): string {
  const bits: string[] = [];
  const changed = (r.updated ?? 0) + (r.backfilled ?? 0);
  if (changed > 0) bits.push(`${changed.toLocaleString("en-US")} updated`);
  if ((r.skipped ?? 0) > 0) bits.push(`${(r.skipped ?? 0).toLocaleString("en-US")} unchanged`);
  if ((r.errors ?? 0) > 0) bits.push(`${r.errors} error${r.errors === 1 ? "" : "s"}`);
  if (bits.length === 0) bits.push("ran — no changes");
  if (r.duration_secs != null) bits.push(`${Math.round(Number(r.duration_secs))}s`);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function numNote(notes: Record<string, unknown>, key: string): number | null {
  const v = notes[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function noteString(notes: Record<string, unknown>, key: string): string | null {
  const v = notes[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
