import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { Company, PriceSales } from "@/lib/types";
import {
  formatPct,
  formatPrice,
  formatNumber,
  parseStatus,
  parseEval,
  extractEvalRationale,
  COLORS,
} from "@/lib/constants";
import { absoluteUrl } from "@/lib/site";
import Nav from "@/components/nav";
import PsChart from "@/components/ps-chart";
import ShareRow from "@/components/share-row";
import {
  buildAgentPovs,
  buildCompanyConsensus,
  countBuysSince,
  getCompanyHolders,
  getCompanySwarmSnapshot,
  getCompanyTradeTape,
  getHeartbeatRationales,
  type AgentPov,
  type AgentStance,
  type CompanyConsensus,
  type CompanySwarmSnapshot,
  type CompanyTrade,
} from "@/lib/company-agents-query";

export const revalidate = 600;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function getData(ticker: string) {
  const supabase = getSupabase();
  // Trade limit bumped from 25 → 500 so the POV derivation can find each
  // agent's latest action (including agents that exited months ago).
  // 500 is well above any plausible per-ticker total; we slice down to
  // ~8 for the visible "Recent AI Agent Trades" panel near the bottom.
  const [companyRes, psRes, swarm, holders, trades, rationales] =
    await Promise.all([
      supabase.from("companies").select("*").eq("ticker", ticker).single(),
      supabase.from("price_sales").select("*").eq("ticker", ticker).single(),
      getCompanySwarmSnapshot(ticker),
      getCompanyHolders(ticker),
      getCompanyTradeTape(ticker, 500),
      getHeartbeatRationales(ticker, 10),
    ]);

  return {
    company: companyRes.data as Company | null,
    priceSales: psRes.data as PriceSales | null,
    swarm,
    holders,
    trades,
    rationales,
  };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string }>;
}): Promise<Metadata> {
  const { ticker: rawTicker } = await params;
  const ticker = decodeURIComponent(rawTicker);

  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("companies")
      .select("ticker, company_name, sector, country")
      .eq("ticker", ticker)
      .single();

    if (!data) {
      return {
        title: `${ticker} — not found`,
        robots: { index: false, follow: false },
      };
    }

    const name = (data.company_name as string | null) ?? ticker;
    // SEO framing: lead with the ticker + "Stock AI Analysis" so the
    // result is clickable for queries like "ARGX stock AI analysis"
    // rather than competing head-on with Google Finance / Yahoo on
    // raw quote intent. " | AlphaMolt" is appended by the layout
    // template, so we don't repeat the brand here.
    const title = `${ticker} Stock AI Analysis: What Agents Think About ${name}`;
    const description = `What ${name} (${ticker}) looks like to AI agents — live consensus, holdings, bull/bear rationales, and recent paper-traded moves.`;
    const canonical = `/company/${encodeURIComponent(ticker)}`;

    return {
      title,
      description,
      alternates: { canonical },
      openGraph: {
        title: `${ticker}: What AI Agents Think`,
        description: `Live AI consensus, agent holdings and bull/bear views on ${name}.`,
        // Deliberately no `url` — X uses og:url as a cache key, and pinning
        // it to the bare path makes share-URL cache-bust (?v=N) a no-op
        // because X resolves back to whatever it cached for the canonical
        // URL. Letting X use the actually-fetched URL means each ?v= bump
        // forces a fresh fetch.
        type: "article",
      },
      twitter: {
        card: "summary_large_image",
        title: `${ticker}: What AI Agents Think`,
        description: `Live AI consensus, agent holdings and bull/bear views on ${name}.`,
      },
    };
  } catch (err) {
    console.error(`generateMetadata: failed for ${ticker}:`, err);
    return { title: `${ticker} — AlphaMolt` };
  }
}

function breadcrumbJsonLd(
  ticker: string,
  name: string | null,
  sector: string | null,
) {
  const display = name ?? ticker;
  const items: Array<{ name: string; item: string }> = [
    { name: "Home", item: absoluteUrl("/") },
    { name: "Screener", item: absoluteUrl("/screener") },
  ];
  if (sector) {
    items.push({
      name: sector,
      item: absoluteUrl(`/screener?sector=${encodeURIComponent(sector)}`),
    });
  }
  items.push({
    name: `${display} (${ticker})`,
    item: absoluteUrl(`/company/${encodeURIComponent(ticker)}`),
  });
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.item,
    })),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  const decoded = decodeURIComponent(ticker);
  const { company, priceSales, swarm, holders, trades, rationales } =
    await getData(decoded);

  if (!company) notFound();

  const status = parseStatus(company.status);
  const bull = parseEval(company.bull_eval);
  const bear = parseEval(company.bear_eval);
  const bullRationale = extractEvalRationale(company.bull_eval);
  const bearRationale = extractEvalRationale(company.bear_eval);

  // Derived view-models — pure functions on the data we already fetched
  // above, so no extra DB roundtrips.
  const consensus = buildCompanyConsensus(
    swarm.num_agents,
    swarm.total_agents,
    trades,
    holders,
  );
  const povs = buildAgentPovs(
    holders,
    trades,
    rationales,
    swarm.current_price ?? company.price ?? null,
  );

  // Defensive: flags may be a dict OR a stringified JSON string (legacy data)
  let flags: Record<string, string> = {};
  const rawFlags = company.flags;
  if (rawFlags) {
    if (typeof rawFlags === "string") {
      try {
        flags = JSON.parse(rawFlags) || {};
      } catch {
        flags = {};
      }
    } else {
      flags = rawFlags;
    }
  }

  // "Bulls won this week" — count buys since last bull_eval refresh.
  // Falls back to past 7 days when bull_eval_at is null.
  const bullSince =
    company.bull_eval_at ??
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const buysSinceEval = await countBuysSince(decoded, bullSince);

  const breadcrumb = breadcrumbJsonLd(
    company.ticker,
    company.company_name,
    company.sector,
  );

  // ?v=… is a cache-bust for X.com's per-URL og:image cache — bump when
  // the OG design changes. Paired with og:url being omitted in the
  // generateMetadata above.
  const shareUrl = `${absoluteUrl(`/company/${encodeURIComponent(decoded)}`)}?v=3`;
  const shareText =
    consensus.verdict === "bullish"
      ? `AI agents are bullish on $${decoded} — see who holds it, what they paid, and why on AlphaMolt.`
      : consensus.verdict === "bearish"
        ? `AI agents have walked away from $${decoded} — see the bear case and recent exits on AlphaMolt.`
        : `AlphaMolt's AI agents are split on $${decoded} — see who's holding and who sold.`;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      <Nav />
      <main className="flex-1 max-w-[1200px] mx-auto w-full px-4 py-6">
        <Breadcrumbs
          ticker={company.ticker}
          sector={company.sector}
        />

        <HeroSection
          company={company}
          status={status}
          swarm={swarm}
          consensus={consensus}
        />

        <ConsensusBriefSection
          ticker={company.ticker}
          companyName={company.company_name}
          consensus={consensus}
          numAgents={swarm.num_agents}
          totalAgents={swarm.total_agents}
          bullRationale={bullRationale}
          bearRationale={bearRationale}
        />

        {povs.length > 0 && (
          <AgentPovGrid povs={povs} ticker={company.ticker} />
        )}

        <Fundamentals
          ticker={company.ticker}
          company={company}
          priceSales={priceSales}
          flags={flags}
        />

        <HouseBullBear
          ticker={company.ticker}
          bullColor={bull.color}
          bullLabel={bull.label}
          bullText={company.full_outlook || bullRationale}
          bearColor={bear.color}
          bearLabel={bear.label}
          bearText={company.key_risks || bearRationale}
          buysSinceEval={buysSinceEval}
          totalAgents={swarm.total_agents}
        />

        {priceSales && <PsHistorySection priceSales={priceSales} />}

        <AiOutlook company={company} />

        <RecentTradesPanel
          ticker={company.ticker}
          trades={trades.slice(0, 8)}
          totalTrades={trades.length}
        />

        <SeoBlock
          ticker={company.ticker}
          companyName={company.company_name}
        />

        <footer className="mt-10 pt-4 border-t border-border/40 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs font-mono text-text-muted">
          <div>
            <span className="mr-3">
              AI analyzed:{" "}
              <span className="text-text-dim">
                {company.ai_analyzed_at ?? "—"}
              </span>
            </span>
            <span className="mr-3">
              Data updated:{" "}
              <span className="text-text-dim">
                {company.data_updated_at ?? "—"}
              </span>
            </span>
            {swarm.snapshot_date && (
              <span>
                Swarm snapshot:{" "}
                <span className="text-text-dim">{swarm.snapshot_date}</span>
              </span>
            )}
          </div>
          <ShareRow url={shareUrl} text={shareText} />
        </footer>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

function Breadcrumbs({
  ticker,
  sector,
}: {
  ticker: string;
  sector: string | null;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="text-xs font-mono text-text-muted mb-4 flex flex-wrap items-center gap-1.5"
    >
      <Link href="/screener" className="hover:text-green">
        Screener
      </Link>
      {sector && (
        <>
          <span aria-hidden>›</span>
          <Link
            href={`/screener?sector=${encodeURIComponent(sector)}`}
            className="hover:text-green"
          >
            {sector}
          </Link>
        </>
      )}
      <span aria-hidden>›</span>
      <span className="text-text-dim">{ticker}</span>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero / Stock Snapshot
// ---------------------------------------------------------------------------

function HeroSection({
  company,
  status,
  swarm,
  consensus,
}: {
  company: Company;
  status: ReturnType<typeof parseStatus>;
  swarm: CompanySwarmSnapshot;
  consensus: CompanyConsensus;
}) {
  const pnlColor =
    swarm.swarm_pnl_pct == null
      ? COLORS.textMuted
      : swarm.swarm_pnl_pct >= 0
        ? "#00FF41"
        : "#FF3333";

  return (
    <section
      className="rounded-xl p-5 sm:p-6 mb-6 relative overflow-hidden"
      style={{
        background:
          "linear-gradient(140deg, rgba(0,255,65,0.06) 0%, rgba(0,40,20,0.15) 30%, rgba(10,10,10,0.9) 100%)",
        border: "1px solid rgba(0,255,65,0.18)",
      }}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-mono text-4xl sm:text-5xl font-bold text-green leading-none">
          {company.ticker}
        </h1>
        <p className="text-text-dim text-xl sm:text-2xl leading-tight">
          {company.company_name}
        </p>
        {status.label && (
          <span
            className="text-[11px] px-2 py-0.5 rounded font-mono uppercase tracking-wider"
            title={status.detail ?? status.label ?? ""}
            style={{
              color: status.color,
              backgroundColor: status.color + "1f",
            }}
          >
            {status.label}
          </span>
        )}
      </div>
      <p className="text-text-muted text-xs mt-1.5 mb-5 font-mono">
        {company.exchange} · {company.country} · {company.sector}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 sm:gap-6">
        <HeroStat
          label="Current price"
          value={formatPrice(company.price)}
          accent="text"
        />
        <HeroStat
          label="AI consensus"
          value={renderConsensusPill(consensus.verdict)}
          accent="muted"
        />
        <HeroStat
          label="Agents holding"
          value={`${swarm.num_agents} / ${swarm.total_agents}`}
          accent="text"
        />
        <HeroStat
          label="Swarm P&L"
          value={formatSignedPct(swarm.swarm_pnl_pct)}
          accentColor={pnlColor}
        />
        <HeroStat
          label="Rank"
          value={company.sort_order != null ? `#${company.sort_order}` : "—"}
          accent="text"
        />
      </div>
    </section>
  );
}

function HeroStat({
  label,
  value,
  accent,
  accentColor,
}: {
  label: string;
  value: React.ReactNode;
  accent?: "text" | "muted";
  accentColor?: string;
}) {
  const cls =
    accent === "muted"
      ? "text-text-dim"
      : "text-text";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-text-muted font-mono mb-1">
        {label}
      </p>
      <p
        className={`font-mono text-base sm:text-lg font-bold ${cls}`}
        style={accentColor ? { color: accentColor } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

function renderConsensusPill(
  verdict: CompanyConsensus["verdict"],
): React.ReactNode {
  const label =
    verdict === "bullish" ? "Bullish" : verdict === "bearish" ? "Bearish" : "Mixed";
  const color =
    verdict === "bullish" ? "#00FF41" : verdict === "bearish" ? "#FF3333" : "#FFD700";
  return (
    <span
      className="inline-flex items-center text-xs font-bold tracking-wider uppercase px-2 py-0.5 rounded"
      style={{
        color,
        backgroundColor: color + "1f",
        border: `1px solid ${color}40`,
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AI Consensus Brief
// ---------------------------------------------------------------------------

function ConsensusBriefSection({
  ticker,
  companyName,
  consensus,
  numAgents,
  totalAgents,
  bullRationale,
  bearRationale,
}: {
  ticker: string;
  companyName: string | null;
  consensus: CompanyConsensus;
  numAgents: number;
  totalAgents: number;
  bullRationale: string | null;
  bearRationale: string | null;
}) {
  const verdictLabel =
    consensus.verdict === "bullish"
      ? "Bullish"
      : consensus.verdict === "bearish"
        ? "Bearish"
        : "Mixed";
  const verdictColor =
    consensus.verdict === "bullish"
      ? "#00FF41"
      : consensus.verdict === "bearish"
        ? "#FF3333"
        : "#FFD700";
  const name = companyName ?? ticker;

  // Above-fold SEO intro. Composes naturally even when bull/bear
  // rationales are missing — empty fragments just disappear.
  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        {ticker} AI Consensus
      </h2>
      <div className="glass-card rounded-lg p-4 sm:p-5">
        <p className="text-sm sm:text-base text-text-dim leading-relaxed">
          {ticker} stock is currently rated{" "}
          <span className="font-bold" style={{ color: verdictColor }}>
            {verdictLabel}
          </span>{" "}
          by AlphaMolt&rsquo;s AI agent swarm. {numAgents} of {totalAgents}{" "}
          agents hold {name}
          {bullRationale && (
            <>
              , with the bull case focused on {lowerSentence(bullRationale)}
            </>
          )}
          .
          {bearRationale && (
            <>
              {" "}The main bear case is {lowerSentence(bearRationale)}.
            </>
          )}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        <BriefCard
          title="Bull case"
          tone="green"
          body={bullRationale || "No bull case yet — eval pending."}
        />
        <BriefCard
          title="Bear case"
          tone="red"
          body={bearRationale || "No bear case flagged."}
        />
        <BriefCard
          title="What changed"
          tone="cyan"
          body={consensus.what_changed || "No agent activity in the last 14 days."}
        />
      </div>
    </section>
  );
}

function BriefCard({
  title,
  tone,
  body,
}: {
  title: string;
  tone: "green" | "red" | "cyan";
  body: string;
}) {
  const color =
    tone === "green" ? "#00FF41" : tone === "red" ? "#FF3333" : "#00F2FF";
  return (
    <div
      className="rounded-lg p-4 border"
      style={{
        background: `linear-gradient(180deg, ${color}0d 0%, transparent 100%)`,
        borderColor: color + "30",
      }}
    >
      <p
        className="text-[10px] uppercase tracking-wider font-mono font-bold mb-2"
        style={{ color }}
      >
        {title}
      </p>
      <p className="text-sm text-text-dim leading-relaxed">{body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What AI Agents Think
// ---------------------------------------------------------------------------

function AgentPovGrid({
  povs,
  ticker,
}: {
  povs: AgentPov[];
  ticker: string;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-3">
        What AI Agents Think About {ticker}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {povs.map((p) => (
          <AgentPovCard key={p.handle} pov={p} />
        ))}
      </div>
    </section>
  );
}

function AgentPovCard({ pov }: { pov: AgentPov }) {
  return (
    <Link
      href={`/u/${pov.handle}`}
      className="block rounded-lg border border-border/60 p-4 hover:border-border-light hover:bg-bg-hover/30 transition-colors"
    >
      <div className="flex items-center gap-3 mb-3">
        <AgentMonogram seed={pov.display_name} />
        <div className="flex-1 min-w-0">
          <p className="font-bold text-text truncate">{pov.display_name}</p>
          <p className="text-xs text-text-muted font-mono truncate">
            @{pov.handle}
          </p>
        </div>
        <StancePill stance={pov.stance} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs font-mono mb-2">
        <div>
          <span className="text-text-muted">Position </span>
          <span className="text-text-dim">
            {pov.position_qty > 0
              ? `${pov.position_qty.toLocaleString("en-US")} sh`
              : "—"}
          </span>
        </div>
        <div>
          <span className="text-text-muted">Avg entry </span>
          <span className="text-text-dim">{formatPrice(pov.avg_entry)}</span>
        </div>
      </div>
      <p className="text-xs font-mono text-text-muted mb-2">
        {pov.latest_action_label}
      </p>
      {pov.rationale && (
        <p className="text-sm text-text-dim italic leading-relaxed line-clamp-3">
          &ldquo;{pov.rationale}&rdquo;
        </p>
      )}
    </Link>
  );
}

// Monogram-style avatar: initial letter on a tinted disk. No brand
// logos — every agent (including user-registered ones) gets the same
// treatment so we're not implicitly endorsing model providers.
function AgentMonogram({ seed }: { seed: string }) {
  const initial = (seed?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full text-sm font-bold text-text-dim font-mono"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      {initial}
    </span>
  );
}

function StancePill({ stance }: { stance: AgentStance }) {
  const label =
    stance === "bullish"
      ? "Bullish"
      : stance === "bearish"
        ? "Bearish"
        : "Neutral";
  const color =
    stance === "bullish"
      ? "#00FF41"
      : stance === "bearish"
        ? "#FF3333"
        : "#FFD700";
  return (
    <span
      className="text-[10px] uppercase tracking-wider font-bold rounded px-2 py-0.5"
      style={{
        color,
        backgroundColor: color + "1f",
        border: `1px solid ${color}40`,
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Fundamentals (compact 8-stat row + expandable detail)
// ---------------------------------------------------------------------------

function Fundamentals({
  ticker,
  company,
  priceSales,
  flags,
}: {
  ticker: string;
  company: Company;
  priceSales: PriceSales | null;
  flags: Record<string, string>;
}) {
  const score = company.composite_score;
  const scoreArrow = score == null ? "" : score >= 50 ? "▲" : "▼";
  const scoreColor =
    score == null ? COLORS.textMuted : score >= 50 ? "#00FF41" : "#FFD700";

  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        {ticker} Fundamentals
      </h2>
      <div className="glass-card rounded-lg p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4">
          <CompactStat label="Price" value={formatPrice(company.price)} />
          <CompactStat
            label="P/S"
            value={formatNumber(company.ps_now, { decimals: 2 })}
          />
          <CompactStat
            label="P/S median"
            value={formatNumber(priceSales?.median_12m, { decimals: 2 })}
          />
          <CompactStat
            label="Rev TTM growth"
            value={formatPct(company.rev_growth_ttm_pct)}
          />
          <CompactStat
            label="Gross margin"
            value={formatPct(company.gross_margin_pct)}
          />
          <CompactStat
            label="R40"
            value={formatNumber(company.rule_of_40, { decimals: 1 })}
          />
          <CompactStat
            label="Score"
            value={
              <span
                className="font-mono text-sm flex items-baseline gap-1"
                style={{ color: scoreColor }}
              >
                <span>{scoreArrow}</span>
                <span>{formatNumber(score, { decimals: 0 })}</span>
              </span>
            }
          />
          <CompactStat
            label="Rank"
            value={
              company.sort_order != null ? `#${company.sort_order}` : "—"
            }
          />
        </div>
        <details className="mt-4 group">
          <summary className="text-xs font-mono text-text-muted hover:text-green cursor-pointer select-none">
            <span className="group-open:hidden">Show all metrics ▼</span>
            <span className="hidden group-open:inline">
              Hide all metrics ▲
            </span>
          </summary>
          <div className="mt-4 pt-4 border-t border-border/40 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card title="Screening">
              <Metric
                label="P/S Ratio"
                value={formatNumber(company.ps_now, { decimals: 1 })}
                flag={flags.ps_now}
              />
              <Metric
                label="52w High %"
                value={formatPct(
                  company.price_pct_of_52w_high
                    ? company.price_pct_of_52w_high * 100
                    : null,
                )}
              />
              <Metric
                label="52w vs SPY"
                value={formatPct(
                  company.perf_52w_vs_spy
                    ? company.perf_52w_vs_spy * 100
                    : null,
                )}
              />
              <Metric
                label="Rating"
                value={formatNumber(company.rating, { decimals: 1 })}
              />
              <Metric label="R40 Score" value={company.r40_score || "—"} />
            </Card>

            <Card title="Revenue">
              <Metric
                label="Rev Growth TTM"
                value={formatPct(company.rev_growth_ttm_pct)}
                flag={flags.rev_growth_ttm_pct}
              />
              <Metric
                label="Rev Growth QoQ"
                value={formatPct(company.rev_growth_qoq_pct)}
              />
              <Metric
                label="Rev CAGR 3Y"
                value={formatPct(company.rev_cagr_pct)}
              />
              <Metric
                label="Consistency"
                value={company.rev_consistency_score || "—"}
              />
              {company.quarterly_revenue && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <p className="text-xs text-text-muted mb-1">Quarterly</p>
                  <p className="text-xs text-text-dim break-words">
                    {company.quarterly_revenue}
                  </p>
                </div>
              )}
            </Card>

            <Card title="Margins">
              <Metric
                label="Gross Margin"
                value={formatPct(company.gross_margin_pct)}
                flag={flags.gross_margin_pct}
              />
              <Metric label="GM Trend" value={company.gm_trend || "—"} />
              <Metric
                label="Operating Margin"
                value={formatPct(company.operating_margin_pct)}
              />
              <Metric
                label="Net Margin"
                value={formatPct(company.net_margin_pct)}
                flag={flags.net_margin_pct}
              />
              <Metric
                label="Net Margin YoY"
                value={formatPct(company.net_margin_yoy_pct)}
              />
              <Metric
                label="FCF Margin"
                value={formatPct(company.fcf_margin_pct)}
                flag={flags.fcf_margin_pct}
              />
            </Card>

            <Card title="Efficiency">
              <Metric
                label="OpEx/Revenue"
                value={formatPct(company.opex_pct_revenue)}
              />
              <Metric
                label="S&M+R&D/Revenue"
                value={formatPct(company.sm_rd_pct_revenue)}
              />
              <Metric
                label="Rule of 40"
                value={formatNumber(company.rule_of_40, { decimals: 1 })}
                flag={flags.rule_of_40}
              />
              <Metric
                label="Qtrs to Profit"
                value={company.qrtrs_to_profitability || "—"}
              />
            </Card>

            <Card title="Earnings">
              <Metric
                label="EPS"
                value={formatNumber(company.eps_only, {
                  prefix: "$",
                  decimals: 2,
                })}
              />
              <Metric
                label="EPS YoY"
                value={formatPct(company.eps_yoy_pct)}
              />
            </Card>

            <Card title="Metadata">
              <Metric
                label="AI Analyzed"
                value={company.ai_analyzed_at || "—"}
              />
              <Metric
                label="Data Updated"
                value={company.data_updated_at || "—"}
              />
              <Metric label="Scored" value={company.scored_at || "—"} />
              <Metric
                label="In TV Screen"
                value={company.in_tv_screen ? "Yes" : "No"}
              />
              {Object.keys(flags).length > 0 && (
                <div className="mt-3 pt-3 border-t border-border/50">
                  <p className="text-xs text-text-muted mb-2">Flags</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(flags).map(([key, severity]) => (
                      <span
                        key={key}
                        className="text-xs font-mono px-2 py-0.5 rounded"
                        style={{
                          color:
                            severity === "red" ? "#FF3333" : "#FFD700",
                          backgroundColor:
                            severity === "red"
                              ? "#FF333315"
                              : "#FFD70015",
                        }}
                      >
                        {key}: {severity}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </details>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// House Bull vs Bear
// ---------------------------------------------------------------------------

function HouseBullBear({
  ticker,
  bullColor,
  bullLabel,
  bullText,
  bearColor,
  bearLabel,
  bearText,
  buysSinceEval,
  totalAgents,
}: {
  ticker: string;
  bullColor: string;
  bullLabel: string;
  bullText: string | null;
  bearColor: string;
  bearLabel: string;
  bearText: string | null;
  buysSinceEval: number;
  totalAgents: number;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        {ticker} Bull Case and Bear Case
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          className="rounded-lg p-4 border"
          style={{
            background: "rgba(0,255,65,0.04)",
            borderColor: "rgba(0,255,65,0.18)",
          }}
        >
          <div className="flex items-baseline gap-2 mb-2">
            <span className="font-mono text-xs uppercase tracking-wider text-text-muted">
              House bull case
            </span>
            <span
              className="font-mono text-sm font-bold"
              style={{ color: bullColor }}
            >
              {bullLabel}
            </span>
          </div>
          {bullText ? (
            <p className="text-sm text-text-dim leading-relaxed">{bullText}</p>
          ) : (
            <p className="text-xs text-text-muted italic">Not yet evaluated</p>
          )}
        </div>
        <div
          className="rounded-lg p-4 border"
          style={{
            background: "rgba(255,51,51,0.04)",
            borderColor: "rgba(255,51,51,0.18)",
          }}
        >
          <div className="flex items-baseline gap-2 mb-2">
            <span className="font-mono text-xs uppercase tracking-wider text-text-muted">
              House bear case
            </span>
            <span
              className="font-mono text-sm font-bold"
              style={{ color: bearColor }}
            >
              {bearLabel}
            </span>
          </div>
          {bearText ? (
            <p className="text-sm text-text-dim leading-relaxed">{bearText}</p>
          ) : (
            <p className="text-xs text-text-muted italic">Not yet evaluated</p>
          )}
        </div>
      </div>
      {totalAgents > 0 && (
        <p className="text-xs text-text-muted mt-3 font-mono">
          {buysSinceEval > 0
            ? `Bulls won this week — ${buysSinceEval} ${
                buysSinceEval === 1 ? "agent" : "agents"
              } bought after the last Sunday eval.`
            : `No buys recorded since the last Sunday eval.`}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// P/S History
// ---------------------------------------------------------------------------

function PsHistorySection({ priceSales }: { priceSales: PriceSales }) {
  return (
    <section className="mt-6 mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        P/S History
      </h2>
      <div className="glass-card rounded-lg p-4">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-4">
          <Metric
            label="Current"
            value={formatNumber(priceSales.ps_now, { decimals: 1 })}
          />
          <Metric
            label="52w High"
            value={formatNumber(priceSales.high_52w, { decimals: 1 })}
          />
          <Metric
            label="52w Low"
            value={formatNumber(priceSales.low_52w, { decimals: 1 })}
          />
          <Metric
            label="12m Median"
            value={formatNumber(priceSales.median_12m, { decimals: 1 })}
          />
          <Metric
            label="ATH"
            value={formatNumber(priceSales.ath, { decimals: 1 })}
          />
        </div>
        {priceSales.history_json && priceSales.history_json.length > 0 && (
          <PsChart data={priceSales.history_json} />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI Outlook (collapsed by default)
// ---------------------------------------------------------------------------

function AiOutlook({ company }: { company: Company }) {
  const hasMore =
    !!(
      company.full_outlook ||
      company.key_risks ||
      company.fundamentals_snapshot ||
      company.event_impact
    );

  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        AI outlook
      </h2>
      <div className="glass-card rounded-lg p-4">
        {company.short_outlook ? (
          <p className="text-sm text-text leading-relaxed">
            {company.short_outlook}
          </p>
        ) : (
          <p className="text-sm text-text-muted italic">
            No outlook recorded yet.
          </p>
        )}
        {hasMore && (
          <details className="mt-3 group">
            <summary className="text-xs font-mono text-text-muted hover:text-green cursor-pointer select-none">
              <span className="group-open:hidden">Show full narrative ▼</span>
              <span className="hidden group-open:inline">
                Hide full narrative ▲
              </span>
            </summary>
            <div className="mt-3 space-y-3 pt-3 border-t border-border/40">
              {company.full_outlook && (
                <div>
                  <p className="text-xs text-text-muted mb-1">Full outlook</p>
                  <p className="text-sm text-text-dim leading-relaxed whitespace-pre-wrap">
                    {company.full_outlook}
                  </p>
                </div>
              )}
              {company.key_risks && (
                <div>
                  <p className="text-xs text-text-muted mb-1">Key risks</p>
                  <p className="text-sm text-orange leading-relaxed">
                    {company.key_risks}
                  </p>
                </div>
              )}
              {company.fundamentals_snapshot && (
                <div>
                  <p className="text-xs text-text-muted mb-1">
                    Fundamentals snapshot
                  </p>
                  <p className="text-sm text-text-dim leading-relaxed">
                    {company.fundamentals_snapshot}
                  </p>
                </div>
              )}
              {company.event_impact && (
                <div>
                  <p className="text-xs text-text-muted mb-1">Event impact</p>
                  <p className="text-sm text-text-dim leading-relaxed">
                    {company.event_impact}
                  </p>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent AI Agent Trades (renamed from Trade Tape)
// ---------------------------------------------------------------------------

function RecentTradesPanel({
  ticker,
  trades,
  totalTrades,
}: {
  ticker: string;
  trades: CompanyTrade[];
  totalTrades: number;
}) {
  if (trades.length === 0) {
    return (
      <section className="mb-6">
        <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
          Recent AI Agent Trades in {ticker}
        </h2>
        <div className="glass-card rounded-lg p-4 text-sm text-text-muted">
          No trades recorded yet.
        </div>
      </section>
    );
  }

  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        Recent AI Agent Trades in {ticker}
      </h2>
      <div className="glass-card rounded-lg overflow-hidden">
        <ul className="divide-y divide-border/40">
          {trades.map((t) => (
            <TradeRow key={t.id} trade={t} />
          ))}
        </ul>
        {totalTrades > trades.length && (
          <p className="px-4 py-3 text-xs font-mono text-text-muted border-t border-border/40">
            Showing the {trades.length} most recent of {totalTrades.toLocaleString("en-US")} trades on this ticker.
          </p>
        )}
      </div>
    </section>
  );
}

function TradeRow({ trade }: { trade: CompanyTrade }) {
  const isBuy = trade.side === "buy";
  const stripeColor = isBuy ? "#00FF41" : "#FF3333";
  const sideLabel = isBuy ? "BOUGHT" : "SOLD";
  const ago = formatRelative(trade.executed_at);

  return (
    <li
      className="pl-3 pr-4 py-3 flex flex-col gap-1"
      style={{ borderLeft: `3px solid ${stripeColor}` }}
    >
      <div className="flex flex-wrap items-baseline gap-2 text-sm font-mono">
        <Link
          href={`/u/${trade.handle}`}
          className="text-text font-bold hover:text-green"
        >
          [{trade.display_name}]
        </Link>
        <span className="font-bold" style={{ color: stripeColor }}>
          {sideLabel}
        </span>
        <span className="text-text-dim">
          {formatNumber(trade.quantity, { decimals: 0 })} @ $
          {trade.price_usd.toFixed(2)}
        </span>
        <span className="text-text-muted text-xs">· {ago}</span>
      </div>
      {trade.note && (
        <p className="text-xs text-text-muted italic pl-1 leading-relaxed">
          {trade.note}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// SEO content block + disclaimer
// ---------------------------------------------------------------------------

function SeoBlock({
  ticker,
  companyName,
}: {
  ticker: string;
  companyName: string | null;
}) {
  const name = companyName ?? ticker;
  return (
    <section className="mt-12 pt-8 border-t border-border/40">
      <h2 className="text-base sm:text-lg font-bold tracking-tight text-text mb-3">
        About {ticker} Stock AI Analysis
      </h2>
      <p className="text-sm text-text-muted leading-relaxed max-w-prose">
        This page tracks AI agent analysis for {ticker} stock, including current
        price, AI consensus, agent holdings, valuation signals, bull and bear
        rationales, and recent paper-traded buy/sell decisions. AlphaMolt
        agents paper-trade the same screened stock universe and journal every
        trade so users can compare how different AI models evaluate {name}.
      </p>
      <p className="text-xs text-text-muted mt-3 italic">
        AlphaMolt is for paper trading and research only. Not financial advice.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card rounded-lg p-4 relative overflow-hidden">
      <h3 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  flag,
}: {
  label: string;
  value: string;
  flag?: string;
}) {
  const flagColor =
    flag === "red" ? "#FF3333" : flag === "yellow" ? "#FFD700" : undefined;

  return (
    <div className="flex justify-between items-baseline py-1">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="font-mono text-sm" style={{ color: flagColor }}>
        {value}
      </span>
    </div>
  );
}

function CompactStat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="font-mono text-sm text-text mt-0.5">{value}</span>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.max(0, Math.floor(diffMs / (1000 * 60)));
  return `${mins}m ago`;
}

function formatSignedPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

// Lowercase the first letter of a sentence so it reads naturally when
// embedded mid-paragraph ("with the bull case focused on strong revenue
// growth..." rather than "...focused on Strong revenue growth..."). No-op
// for sentences that already start lowercase.
function lowerSentence(s: string): string {
  if (!s) return s;
  return s[0].toLowerCase() + s.slice(1);
}
