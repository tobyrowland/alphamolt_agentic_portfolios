/**
 * Query layer for the /sold ad landing page — "the AI sold at a loss and
 * wrote down its excuse".
 *
 * A "story" is a broken investment thesis (`investment_theses.status =
 * 'broken'`, see migration 020) joined to its BUY trade (via `trade_id`) and
 * the SELL trade that closed the position (the reviewer marks the thesis
 * broken immediately before selling, so the sell is the first `side='sell'`
 * row for the same portfolio + ticker at/after `status_changed_at`).
 *
 * The reviewer's one-line rationale travels on the sell trade's `note`
 * ("portfolio-reviewer drift (<rationale>)" — see portfolio_reviewer.py);
 * `mark_thesis_status` doesn't persist its reason, so the note is the only
 * stored copy of the excuse.
 */

import { getSupabase } from "@/lib/supabase";
import type { InvestmentThesis } from "@/lib/theses-query";

interface TradeRow {
  id: number;
  agent_id: string;
  portfolio_id: string | null;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  price_usd: number;
  executed_at: string;
  note: string | null;
}

type ThesisRow = InvestmentThesis & { portfolio_id: string | null };

export interface SoldStory {
  thesisId: number;
  ticker: string;
  companyName: string | null;
  exchange: string | null;
  thesisText: string | null;
  breakSignals: { field: string; op: string; value: number | string }[];
  buyerName: string;
  sellerName: string;
  openedAt: string;
  brokenAt: string;
  buyPrice: number | null;
  sellPrice: number | null;
  sellAt: string | null;
  resultPct: number | null;
  daysHeld: number | null;
  /** Reviewer's one-line rationale, unwrapped from the sell-trade note. */
  excuse: string | null;
}

export interface SoldStats {
  tradesRecorded: number | null;
  thesesBroken: number | null;
}

/** "portfolio-reviewer drift (margin compression…)" → "margin compression…" */
function unwrapSellNote(note: string | null): string | null {
  if (!note) return null;
  const m = note.match(/^portfolio-reviewer drift \((.*)\)$/s);
  return (m ? m[1] : note).trim() || null;
}

async function agentName(agentId: string): Promise<string> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("agents")
    .select("display_name, handle")
    .eq("id", agentId)
    .maybeSingle();
  return data?.display_name || data?.handle || "an AI agent";
}

async function buildStory(thesis: ThesisRow): Promise<SoldStory | null> {
  const supabase = getSupabase();

  // BUY leg — recorded on the thesis at open.
  let buy: TradeRow | null = null;
  if (thesis.trade_id != null) {
    const { data } = await supabase
      .from("agent_trades")
      .select("*")
      .eq("id", thesis.trade_id)
      .maybeSingle();
    buy = (data as TradeRow | null) ?? null;
  }

  // SELL leg — first sell of the same book + ticker at/after the break.
  // Legacy theses without portfolio_id fall back to the agent's own book.
  let sellQuery = supabase
    .from("agent_trades")
    .select("*")
    .eq("ticker", thesis.ticker)
    .eq("side", "sell")
    .gte("executed_at", thesis.status_changed_at)
    .order("executed_at", { ascending: true })
    .limit(1);
  sellQuery = thesis.portfolio_id
    ? sellQuery.eq("portfolio_id", thesis.portfolio_id)
    : sellQuery.eq("agent_id", thesis.agent_id);
  const { data: sellRows } = await sellQuery;
  const sell = ((sellRows ?? [])[0] as TradeRow | undefined) ?? null;

  const { data: company } = await supabase
    .from("companies")
    .select("company_name, exchange")
    .eq("ticker", thesis.ticker)
    .maybeSingle();

  const [buyerName, sellerName] = await Promise.all([
    agentName(thesis.agent_id),
    sell ? agentName(sell.agent_id) : Promise.resolve("Portfolio Reviewer"),
  ]);

  const buyPrice = buy?.price_usd ?? null;
  const sellPrice = sell?.price_usd ?? null;
  const resultPct =
    buyPrice && sellPrice ? ((sellPrice - buyPrice) / buyPrice) * 100 : null;
  const daysHeld = sell
    ? Math.max(
        0,
        Math.round(
          (new Date(sell.executed_at).getTime() -
            new Date(thesis.opened_at).getTime()) /
            86400000,
        ),
      )
    : null;

  return {
    thesisId: thesis.id,
    ticker: thesis.ticker,
    companyName: company?.company_name ?? null,
    exchange: company?.exchange ?? null,
    thesisText: thesis.thesis_text,
    breakSignals: thesis.break_signals ?? [],
    buyerName,
    sellerName,
    openedAt: thesis.opened_at,
    brokenAt: thesis.status_changed_at,
    buyPrice,
    sellPrice,
    sellAt: sell?.executed_at ?? null,
    resultPct,
    daysHeld,
    excuse: unwrapSellNote(sell?.note ?? null),
  };
}

/** Pinned story for /sold/[id] — any broken thesis, even without a sell. */
export async function getSoldStoryById(id: number): Promise<SoldStory | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("investment_theses")
    .select("*")
    .eq("id", id)
    .eq("status", "broken")
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("getSoldStoryById failed:", error);
    return null;
  }
  return buildStory(data as ThesisRow);
}

/**
 * Campaign default for /sold — the most recent broken thesis that actually
 * closed at a loss (the page's whole premise). Falls back to the most recent
 * broken thesis with any completed sell, then to the most recent broken
 * thesis at all. Returns null only when nothing has ever broken.
 */
export async function getLatestSoldStory(): Promise<SoldStory | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("investment_theses")
    .select("*")
    .eq("status", "broken")
    .not("thesis_text", "is", null)
    .order("status_changed_at", { ascending: false })
    .limit(12);
  if (error) {
    console.error("getLatestSoldStory failed:", error);
    return null;
  }
  const candidates = (data ?? []) as ThesisRow[];

  let firstWithSell: SoldStory | null = null;
  let firstAny: SoldStory | null = null;
  for (const thesis of candidates) {
    const story = await buildStory(thesis);
    if (!story) continue;
    firstAny ??= story;
    if (story.sellPrice != null) {
      firstWithSell ??= story;
      if (story.resultPct != null && story.resultPct < 0) return story;
    }
  }
  return firstWithSell ?? firstAny;
}

/** Honesty-strip counts. Labels on the page must match what these count. */
export async function getSoldStats(): Promise<SoldStats> {
  const supabase = getSupabase();
  const [trades, broken] = await Promise.all([
    supabase.from("agent_trades").select("id", { count: "exact", head: true }),
    supabase
      .from("investment_theses")
      .select("id", { count: "exact", head: true })
      .eq("status", "broken"),
  ]);
  return {
    tradesRecorded: trades.count ?? null,
    thesesBroken: broken.count ?? null,
  };
}
