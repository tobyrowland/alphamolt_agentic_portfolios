/**
 * Dynamic OG card for /company/[ticker]. Renders the agent verdict +
 * top 3 POVs (2 bullish + 1 bearish where available) per the locked
 * mockup — with monogram avatars instead of brand logos so the card
 * doesn't read as an endorsement.
 *
 * Falls back to a clean empty-state card when:
 *   - the ticker isn't in the companies table → returns a generic
 *     AlphaMolt card to avoid breaking link previews
 *   - the ticker has no agent rationales yet → right column shows
 *     "No agent rationales recorded yet."
 */

import { ImageResponse } from "next/og";
import { getSupabase } from "@/lib/supabase";
import {
  buildAgentPovs,
  buildCompanyConsensus,
  getCompanyHolders,
  getCompanySwarmSnapshot,
  getCompanyTradeTape,
  getHeartbeatRationales,
} from "@/lib/company-agents-query";
import {
  OG_ALT,
  OG_SIZE,
  renderCompanyOg,
  type OgPov,
} from "@/lib/company-og";

export const runtime = "nodejs";
export const revalidate = 3600;
export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = "image/png";

const RATIONALE_MAX_CHARS = 90;

export default async function Image({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: rawTicker } = await params;
  const ticker = decodeURIComponent(rawTicker).toUpperCase();

  type CompanyShape = {
    company_name: string | null;
    exchange: string | null;
    country: string | null;
    sector: string | null;
    price: number | null;
    sort_order: number | null;
  };
  let company: CompanyShape | null = null;
  let snapshot: Awaited<ReturnType<typeof getCompanySwarmSnapshot>> | null =
    null;
  let holders: Awaited<ReturnType<typeof getCompanyHolders>> = [];
  let trades: Awaited<ReturnType<typeof getCompanyTradeTape>> = [];
  let rationales: Awaited<ReturnType<typeof getHeartbeatRationales>> = [];
  let totalScreened: number | null = null;

  try {
    const supabase = getSupabase();
    const [companyRes, snap, hldrs, trds, rats, countRes] = await Promise.all([
      supabase
        .from("companies")
        .select("company_name, exchange, country, sector, price, sort_order")
        .eq("ticker", ticker)
        .maybeSingle(),
      getCompanySwarmSnapshot(ticker),
      getCompanyHolders(ticker),
      // Wide window so the POV derivation can find each agent's latest
      // action even for stocks with thousands of historical trades.
      getCompanyTradeTape(ticker, 200),
      getHeartbeatRationales(ticker, 12),
      // Total screened-universe count → "Rank #N of M+" label.
      supabase
        .from("companies")
        .select("ticker", { count: "exact", head: true })
        .eq("in_tv_screen", true),
    ]);
    company =
      (companyRes.data as CompanyShape | null) ?? null;
    snapshot = snap;
    holders = hldrs;
    trades = trds;
    rationales = rats;
    totalScreened = countRes.count ?? null;
  } catch (err) {
    // Don't break social previews on a Supabase blip — fall through to
    // an empty card.
    console.error(`og /company/${ticker} fetch failed:`, err);
  }

  const consensus = buildCompanyConsensus(
    snapshot?.num_agents ?? 0,
    snapshot?.total_agents ?? 0,
    trades,
    holders,
  );
  const allPovs = buildAgentPovs(
    holders,
    trades,
    rationales,
    snapshot?.current_price ?? company?.price ?? null,
  );

  // Pick the three voices that tell the most interesting story:
  // top 2 bullish + 1 bearish (or counterpoint), where each one has a
  // non-empty rationale. We only show agents with something to say —
  // skip "Bought 12d ago" with no quote.
  const withRationale = allPovs.filter(
    (p) => p.rationale && p.rationale.trim().length > 0,
  );
  const bulls = withRationale.filter((p) => p.stance === "bullish");
  const bears = withRationale.filter((p) => p.stance === "bearish");
  const neutrals = withRationale.filter((p) => p.stance === "neutral");
  const picked = [
    bulls[0],
    bulls[1] ?? neutrals[0],
    bears[0] ?? neutrals[bulls[1] ? 1 : 0],
  ].filter((p): p is NonNullable<typeof p> => !!p);

  const povs: OgPov[] = picked.map((p) => ({
    display_name: p.display_name,
    stance: p.stance,
    rationale: truncate(p.rationale ?? "", RATIONALE_MAX_CHARS),
  }));

  return new ImageResponse(
    renderCompanyOg({
      ticker,
      company_name: company?.company_name ?? null,
      exchange: company?.exchange ?? null,
      country: company?.country ?? null,
      sector: company?.sector ?? null,
      price: company?.price ?? null,
      rank: company?.sort_order ?? null,
      total_screened: totalScreened,
      num_agents: snapshot?.num_agents ?? 0,
      total_agents: snapshot?.total_agents ?? 0,
      swarm_pnl_pct: snapshot?.swarm_pnl_pct ?? null,
      verdict: consensus.verdict,
      povs,
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
