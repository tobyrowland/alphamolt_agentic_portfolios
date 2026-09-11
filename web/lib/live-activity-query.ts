import { getSupabase } from "@/lib/supabase";
import type { HubFill, MirrorRun } from "@/lib/live-activity";

/**
 * Server reads for the live account's "what's happening" panel.
 *
 * Two signals, both sleeve-attributed and both surviving a reload:
 *
 *   - `runs`  — the `run_logs` journal. The website writes a
 *     `live_mirror_dispatch` row when it asks GitHub for a mirror (the
 *     dispatch itself returns HTTP 204 with no run id, so there is nothing
 *     else to correlate on), and `alpaca_mirror.py` writes a `live_mirror` row
 *     reporting what the run actually did — including the reason it did
 *     NOTHING (`market_closed`, `drift_refused`). That reason is the whole
 *     point: a silent no-op used to be indistinguishable from a broken run.
 *   - `fills` — `agent_trades` rows for the live sleeves, written by
 *     `alpaca_mirror._record_fill` once an order fills. They are deliberately
 *     excluded from the dashboard's swarm-activity feed, so the hub is the
 *     only place they can appear.
 *
 * `run_logs` is reused rather than adding a table: it is already the project's
 * "a job ran" journal, and the public screener feed reads it through an
 * explicit `script_name` allowlist (`activity-query.ts`), so these rows cannot
 * leak onto a public surface.
 *
 * Both reads fail open — the hub must degrade a line, never break the page.
 */

export type LiveActivity = {
  runs: MirrorRun[];
  fills: HubFill[];
};

export const EMPTY_LIVE_ACTIVITY: LiveActivity = { runs: [], fills: [] };

/** `run_logs.script_name` written by the website when it asks for a mirror. */
export const DISPATCH_SCRIPT = "live_mirror_dispatch";
/** `run_logs.script_name` written by alpaca_mirror.py for each mirror run. */
export const MIRROR_SCRIPT = "live_mirror";

type RunLogRow = {
  script_name: string;
  created_at: string;
  details: Record<string, unknown> | null;
};

/**
 * Recent mirror dispatches + runs, narrowed to the caller's own sleeves.
 *
 * Filtering happens in JS rather than through a JSONB path filter: the journal
 * is small (a handful of rows a day) and `details->>portfolio_id` filters are
 * easy to get subtly wrong in PostgREST.
 */
async function fetchRuns(portfolioIds: string[]): Promise<MirrorRun[]> {
  if (portfolioIds.length === 0) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("run_logs")
    .select("script_name, created_at, details")
    .in("script_name", [DISPATCH_SCRIPT, MIRROR_SCRIPT])
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    console.error("live-activity: run journal read failed:", error);
    return [];
  }
  const mine = new Set(portfolioIds);
  const runs: MirrorRun[] = [];
  for (const row of (data ?? []) as RunLogRow[]) {
    const details = row.details ?? {};
    const portfolioId =
      typeof details.portfolio_id === "string" ? details.portfolio_id : null;
    // Account-wide rows (no portfolio id) are kept; anything belonging to
    // someone else's sleeve is dropped.
    if (portfolioId != null && !mine.has(portfolioId)) continue;
    runs.push({
      kind: row.script_name === DISPATCH_SCRIPT ? "dispatch" : "run",
      portfolioId,
      slug: typeof details.slug === "string" ? details.slug : null,
      status: typeof details.status === "string" ? details.status : null,
      orders: numberOr(details.orders, 0),
      placed: numberOr(details.placed, 0),
      dryRun: details.dry_run === true,
      createdAt: row.created_at,
    });
  }
  return runs;
}

/** Newest real fills booked against the live sleeves. */
async function fetchFills(portfolioIds: string[]): Promise<HubFill[]> {
  if (portfolioIds.length === 0) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agent_trades")
    .select("id, portfolio_id, ticker, side, quantity, price_usd, executed_at")
    .in("portfolio_id", portfolioIds)
    .order("executed_at", { ascending: false })
    .limit(10);
  if (error) {
    console.error("live-activity: fills read failed:", error);
    return [];
  }
  return ((data ?? []) as {
    id: number | string;
    portfolio_id: string;
    ticker: string;
    side: string;
    quantity: number | string;
    price_usd: number | string | null;
    executed_at: string;
  }[]).map((t) => ({
    id: String(t.id),
    portfolioId: t.portfolio_id,
    ticker: t.ticker,
    side: (t.side ?? "").toLowerCase(),
    qty: Number(t.quantity) || 0,
    price: Number(t.price_usd ?? 0) || 0,
    executedAt: t.executed_at,
  }));
}

/** Everything the hub needs to say what is — and isn't — in flight. */
export async function getLiveActivity(
  portfolioIds: string[],
): Promise<LiveActivity> {
  const [runs, fills] = await Promise.all([
    fetchRuns(portfolioIds),
    fetchFills(portfolioIds),
  ]);
  return { runs, fills };
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
