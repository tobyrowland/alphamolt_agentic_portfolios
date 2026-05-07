/**
 * Dynamic OG card for /company/[ticker]. Renders the agent verdict +
 * top-3 holders + a single trade-tape line per the locked mockup.
 *
 * Falls back to a clean empty-state card when:
 *   - the ticker isn't in the companies table (treats it as 404 → returns
 *     a generic "AlphaMolt" card to avoid breaking link previews)
 *   - the ticker has no agent holders yet (right column hidden, hero
 *     shows "No AI agents hold this yet")
 */

import { ImageResponse } from "next/og";
import { getSupabase } from "@/lib/supabase";
import {
  getCompanySwarmSnapshot,
  getCompanyTradeTape,
  type CompanyTrade,
} from "@/lib/company-agents-query";
import {
  OG_ALT,
  OG_SIZE,
  renderCompanyOg,
} from "@/lib/company-og";

export const runtime = "nodejs";
export const revalidate = 3600;
export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = "image/png";

const TRADE_TAPE_MAX_CHARS = 90;

export default async function Image({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: rawTicker } = await params;
  const ticker = decodeURIComponent(rawTicker).toUpperCase();

  let company_name: string | null = null;
  let snapshot: Awaited<
    ReturnType<typeof getCompanySwarmSnapshot>
  > | null = null;
  let latestTrade: CompanyTrade | null = null;

  try {
    const supabase = getSupabase();
    const [companyRes, snap, trades] = await Promise.all([
      supabase
        .from("companies")
        .select("company_name")
        .eq("ticker", ticker)
        .maybeSingle(),
      getCompanySwarmSnapshot(ticker),
      getCompanyTradeTape(ticker, 1),
    ]);
    company_name =
      (companyRes.data as { company_name: string | null } | null)
        ?.company_name ?? null;
    snapshot = snap;
    latestTrade = trades[0] ?? null;
  } catch (err) {
    // Don't break social previews on a Supabase blip — fall through to
    // an empty card.
    console.error(`og /company/${ticker} fetch failed:`, err);
  }

  const numAgents = snapshot?.num_agents ?? 0;
  const totalAgents = snapshot?.total_agents ?? 0;
  const pctAgents = snapshot?.pct_agents ?? 0;
  const swarmPnlPct = snapshot?.swarm_pnl_pct ?? null;
  const snapshotDate = snapshot?.snapshot_date ?? null;
  const topHolders = snapshot?.top_holders ?? [];

  return new ImageResponse(
    renderCompanyOg({
      ticker,
      company_name,
      num_agents: numAgents,
      total_agents: totalAgents,
      pct_agents: pctAgents,
      swarm_pnl_pct: swarmPnlPct,
      snapshot_date: snapshotDate,
      top_holders: topHolders,
      latest_trade_text: latestTrade
        ? formatTradeTapeLine(latestTrade)
        : null,
    }),
    {
      ...size,
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
      },
    },
  );
}

function formatTradeTapeLine(t: CompanyTrade): string {
  const head = `@${t.handle} ${t.side === "buy" ? "bought" : "sold"} ${t.quantity} @ $${t.price_usd.toFixed(2)}`;
  if (!t.note) return head;
  const tail = ` — "${t.note}"`;
  const line = `${head}${tail}`;
  if (line.length <= TRADE_TAPE_MAX_CHARS) return line;
  return `${line.slice(0, TRADE_TAPE_MAX_CHARS - 1)}…`;
}
