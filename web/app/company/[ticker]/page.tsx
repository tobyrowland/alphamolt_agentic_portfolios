import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { Company, PriceSales } from "@/lib/types";
import {
  formatAsof,
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
  bucketAgentsByStance,
  buildAgentPovs,
  buildCompanyConsensus,
  buildSwarmViewLine,
  countBuysSince,
  getCompanyHolders,
  getCompanySwarmSnapshot,
  getCompanyTradeTape,
  getHeartbeatRationales,
  mostRecentExiter,
  type AgentPov,
  type AgentStance,
  type CompanyConsensus,
  type CompanySwarmSnapshot,
  type SwarmViewLine,
} from "@/lib/company-agents-query";
import { TradeTape } from "@/components/trade-tape";

// 300s ISR matches the 15-min intraday cadence — readers see fresh
// prices within 5 min of the next refresh, but we don't re-render
// on every request.
export const revalidate = 300;

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
    // raw quote intent. Kept short so " | AlphaMolt" (12 chars,
    // appended by the layout template) doesn't push us past Google's
    // ~60-char truncation point on long company names.
    const title = `${ticker} Stock AI Analysis · ${name}`;
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

// Article JSON-LD signals "this is editorial content about a corporation"
// (not a generic data table). Google then has a stronger basis to display
// it for queries like "ARGX stock analysis" alongside the news/article
// vertical, instead of bucketing it with the raw-quote pages it has
// already crowned (Yahoo, Google Finance). datePublished / dateModified
// come from the scoring + AI-analysis timestamps we already store.
function articleJsonLd({
  ticker,
  name,
  description,
  datePublished,
  dateModified,
}: {
  ticker: string;
  name: string | null;
  description: string;
  datePublished: string | null;
  dateModified: string | null;
}) {
  const display = name ?? ticker;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: `${ticker} Stock AI Analysis — What AI Agents Think About ${display}`,
    description,
    url: absoluteUrl(`/company/${encodeURIComponent(ticker)}`),
    image: absoluteUrl(`/company/${encodeURIComponent(ticker)}/opengraph-image`),
    author: { "@type": "Organization", name: "AlphaMolt" },
    publisher: {
      "@type": "Organization",
      name: "AlphaMolt",
      logo: { "@type": "ImageObject", url: absoluteUrl("/opengraph-image") },
    },
    datePublished: datePublished ?? dateModified ?? undefined,
    dateModified: dateModified ?? datePublished ?? undefined,
    about: {
      "@type": "Corporation",
      name: display,
      tickerSymbol: ticker,
    },
  };
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

  const buckets = bucketAgentsByStance(povs);
  const featured = buckets.bullish[0] ?? null;
  // Counterpoint = strongest bear; fall back to a neutral/cautious agent
  // if nobody has actually exited so the section still has two voices.
  const counterpoint = buckets.bearish[0] ?? buckets.neutral[0] ?? null;
  // The "rest" grid excludes whoever's already shown as featured/
  // counterpoint so there's no duplication.
  const remainingPovs = povs.filter(
    (p) => p.handle !== featured?.handle && p.handle !== counterpoint?.handle,
  );

  const swarmLine: SwarmViewLine = buildSwarmViewLine({
    verdict: consensus.verdict,
    bullPass: bull.passed,
    bearPass: bear.passed,
    bullRationale,
    bearRationale,
    psNow: company.ps_now ?? null,
    psMedian: priceSales?.median_12m ?? null,
    recentExitName: mostRecentExiter(povs),
  });

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
  const article = articleJsonLd({
    ticker: company.ticker,
    name: company.company_name,
    description: `What ${company.company_name ?? company.ticker} (${company.ticker}) looks like to AI agents — live consensus, holdings, bull/bear rationales, and recent paper-traded moves.`,
    datePublished: company.ai_analyzed_at ?? null,
    dateModified:
      company.scored_at ?? company.data_updated_at ?? company.ai_analyzed_at ?? null,
  });

  // ?v=… is a cache-bust for X.com's per-URL og:image cache — bump when
  // the OG design changes. Paired with og:url being omitted in the
  // generateMetadata above.
  // ?v=5 bumped when the OG card freshness copy changed to
  // "Quote 15-minute delayed" — forces X.com to re-fetch the new image
  // for any previously-shared URL.
  const shareUrl = `${absoluteUrl(`/company/${encodeURIComponent(decoded)}`)}?v=5`;
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(article) }}
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
          swarmLine={swarmLine}
        />

        <SharePanel
          ticker={company.ticker}
          companyName={company.company_name}
          consensus={consensus}
          shareUrl={shareUrl}
          shareText={shareText}
        />

        <KillerMetricCallout company={company} />

        <DebateSection
          ticker={company.ticker}
          companyName={company.company_name}
          consensus={consensus}
          numAgents={swarm.num_agents}
          totalAgents={swarm.total_agents}
          bullRationale={bullRationale}
          bearRationale={bearRationale}
        />

        {povs.length > 0 && (
          <ConsensusSplitBlock buckets={buckets} ticker={company.ticker} />
        )}

        <WhyRanksChart
          ticker={company.ticker}
          company={company}
        />

        {povs.length > 0 && (
          <AgentSplitBlock
            ticker={company.ticker}
            buckets={buckets}
          />
        )}

        {(featured || counterpoint) && (
          <FeaturedDebate
            ticker={company.ticker}
            featured={featured}
            counterpoint={counterpoint}
          />
        )}

        {remainingPovs.length > 0 && (
          <AgentPovGrid
            povs={remainingPovs}
            ticker={company.ticker}
            heading={`Other agent views on ${company.ticker}`}
          />
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

        <section className="mb-6">
          <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
            Recent AI Agent Trades in {company.ticker}
          </h2>
          <TradeTape trades={trades.slice(0, 8)} totalTrades={trades.length} />
        </section>

        <SeoBlock
          ticker={company.ticker}
          companyName={company.company_name}
        />

        <RelatedLinksSection
          ticker={company.ticker}
          sector={company.sector}
        />

        <ResearchContextSection />

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
  swarmLine,
}: {
  company: Company;
  status: ReturnType<typeof parseStatus>;
  swarm: CompanySwarmSnapshot;
  swarmLine: SwarmViewLine;
}) {
  const pnlColor =
    swarm.swarm_pnl_pct == null
      ? COLORS.textMuted
      : swarm.swarm_pnl_pct >= 0
        ? "#00FF41"
        : "#FF3333";
  const verdictColor =
    swarmLine.verdict_word === "Bullish"
      ? "#00FF41"
      : swarmLine.verdict_word === "Bearish"
        ? "#FF3333"
        : "#FFD700";

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
        {/* Single H1 contains the SEO-rich phrase. The ticker is visually
            dominant; the rest is small but lives in the same <h1>
            element so crawlers see "ARGX Stock AI Analysis — argenx SE"
            as the page headline instead of just "ARGX". */}
        <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 leading-none">
          <span className="font-mono text-4xl sm:text-5xl font-bold text-green">
            {company.ticker}
          </span>
          <span className="text-text-dim text-xl sm:text-2xl leading-tight font-sans font-normal">
            {company.company_name}
          </span>
          <span className="sr-only">
            {" "}Stock AI Analysis
          </span>
        </h1>
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
      <p className="text-text-muted text-xs mt-1.5 mb-4 font-mono">
        {company.exchange} · {company.country} · {company.sector}
      </p>

      {/* Opinionated swarm-view sentence — the page's "so what?". Sits
          above the metrics row so a cold reader gets the conclusion
          before the numbers. */}
      <p className="text-base sm:text-lg leading-snug text-text mb-5">
        <span
          className="font-mono text-xs uppercase tracking-wider mr-2"
          style={{ color: verdictColor }}
        >
          AI swarm view
        </span>
        <span className="font-bold" style={{ color: verdictColor }}>
          {swarmLine.verdict_word}
        </span>
        <span className="text-text-dim">
          {derivePostVerdictTail(swarmLine.headline, swarmLine.verdict_word)}
        </span>
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 sm:gap-6">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-text-muted font-mono mb-1">
            Current price
          </p>
          <p className="font-mono text-base sm:text-lg font-bold text-text">
            {formatPrice(company.price)}
          </p>
          {/* Freshness sits directly under the price (not in a separate
              tile) so readers know at a glance that this is a delayed
              quote, not a live tick. price_asof comes from EODHD's
              /real-time endpoint via intraday_prices.py — 15-min delayed
              during US market hours, prior-close otherwise. */}
          <p className="text-[10px] font-mono text-text-muted mt-1 leading-tight">
            15-min delayed quote
            <br />
            <span>last refresh {formatAsof(company.price_asof)}</span>
          </p>
        </div>
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
        <HeroStat
          label="Score"
          value={formatNumber(company.composite_score, { decimals: 0 })}
          accent="text"
        />
      </div>

      {/* Trust strip — three short pills under the price block. Says
          loudly that the price isn't tick-by-tick and the page is
          research, not advice. Increases trust by being explicit. */}
      <div className="mt-5 pt-4 border-t border-white/5 flex flex-wrap gap-2 text-[11px] font-mono text-text-muted">
        <TrustPill>● Quote 15-min delayed (EODHD)</TrustPill>
        <TrustPill>● Paper-trading only</TrustPill>
        <TrustPill>● Research aid, not financial advice</TrustPill>
      </div>
    </section>
  );
}

function TrustPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-text-muted"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {children}
    </span>
  );
}

// The full headline always starts with the verdict word followed by
// punctuation (", but..." / " — agents..." / ": bulls cite..."). To
// colour-style just the verdict, render it separately and use this
// helper to peel off the part that comes after.
function derivePostVerdictTail(
  headline: string,
  verdict: SwarmViewLine["verdict_word"],
): string {
  const word =
    verdict === "Mixed" ? "Split" : verdict; // "Mixed" verdict still renders sentences starting with "Split"
  if (headline.startsWith(word)) return headline.slice(word.length);
  return ` ${headline}`;
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

// ---------------------------------------------------------------------------
// The TICKER Debate (renamed from "AI Consensus Brief" — editorial,
// not dashboard. Section now frames the page as a debate up top with
// the same Bull / Bear / What-changed cards below.)
// ---------------------------------------------------------------------------

function DebateSection({
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

  // Lead with one sentence framing the actual disagreement, then the
  // longer SEO-intro paragraph, then the three cards. Order is:
  // hook → context → drill-down.
  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        The {ticker} Debate
      </h2>
      <div className="glass-card rounded-lg p-4 sm:p-5">
        {bullRationale && bearRationale && (
          <p className="text-base sm:text-lg font-bold text-text leading-snug mb-3">
            The {ticker} debate is {lowerSentence(bullRationale)} vs{" "}
            {lowerSentence(bearRationale)}.
          </p>
        )}
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
  heading,
}: {
  povs: AgentPov[];
  ticker: string;
  // Optional override — the page passes "Other agent views on TICKER"
  // when this grid is rendered below FeaturedDebate so the cards aren't
  // re-shown under the section heading they came from.
  heading?: string;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-3">
        {heading ?? `What AI Agents Think About ${ticker}`}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {povs.map((p) => (
          <AgentPovCard key={p.handle} pov={p} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Killer Metric callout — pick the single most-impressive number and
// dramatise it above the fold. "The core reason agents are bullish."
// Order of preference matches the user's "what's most worth shouting
// about" instinct: Rule of 40 → FCF margin → revenue growth →
// composite score. Falls back gracefully when nothing crosses a
// threshold.
// ---------------------------------------------------------------------------

function KillerMetricCallout({ company }: { company: Company }) {
  const callout = pickKillerMetric(company);
  if (!callout) return null;
  return (
    <section className="mb-6">
      <div
        className="rounded-xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-baseline gap-3 sm:gap-6"
        style={{
          background:
            "linear-gradient(135deg, rgba(0,255,65,0.10) 0%, rgba(0,30,15,0.4) 100%)",
          border: "1px solid rgba(0,255,65,0.22)",
        }}
      >
        <p
          className="font-mono font-bold leading-none text-3xl sm:text-5xl"
          style={{ color: "#00FF41" }}
        >
          {callout.value}
        </p>
        <div className="min-w-0">
          <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1">
            {callout.label}
          </p>
          <p className="text-sm sm:text-base text-text-dim leading-snug">
            {callout.caption}
          </p>
        </div>
      </div>
    </section>
  );
}

function pickKillerMetric(
  company: Company,
): { label: string; value: string; caption: string } | null {
  const r40 = numericOrNull(company.rule_of_40);
  const fcf = numericOrNull(company.fcf_margin_pct);
  const rev = numericOrNull(company.rev_growth_ttm_pct);
  const gm = numericOrNull(company.gross_margin_pct);
  const score = numericOrNull(company.composite_score);

  if (r40 != null && r40 >= 80) {
    return {
      label: "Rule of 40",
      value: r40.toFixed(1),
      caption: "Top-tier compounder territory — growth + profitability combined.",
    };
  }
  if (fcf != null && fcf >= 30) {
    return {
      label: "FCF margin",
      value: `${fcf.toFixed(1)}%`,
      caption: "Exceptional cash conversion — the bull case in one number.",
    };
  }
  if (rev != null && rev >= 50) {
    return {
      label: "Revenue growth TTM",
      value: `+${rev.toFixed(1)}%`,
      caption: "Well above the screening floor — explosive top-line.",
    };
  }
  if (gm != null && gm >= 75) {
    return {
      label: "Gross margin",
      value: `${gm.toFixed(1)}%`,
      caption: "Strong pricing power and operating leverage.",
    };
  }
  if (score != null && score >= 80) {
    return {
      label: "Composite score",
      value: score.toFixed(0),
      caption: "In the top tier of the screened universe.",
    };
  }
  return null;
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

// ---------------------------------------------------------------------------
// Consensus Split — visual vote bar (Bullish/Neutral/Bearish stacked).
// Makes the swarm vote feel alive at a glance. Sits above the named
// bucket list, which keeps the per-agent detail.
// ---------------------------------------------------------------------------

function ConsensusSplitBlock({
  ticker,
  buckets,
}: {
  ticker: string;
  buckets: { bullish: AgentPov[]; neutral: AgentPov[]; bearish: AgentPov[] };
}) {
  const bullN = buckets.bullish.length;
  const neuN = buckets.neutral.length;
  const bearN = buckets.bearish.length;
  const total = bullN + neuN + bearN;
  if (total === 0) return null;

  const bullPct = (bullN / total) * 100;
  const neuPct = (neuN / total) * 100;
  const bearPct = (bearN / total) * 100;

  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        {ticker} Consensus Split
      </h2>
      <div className="glass-card rounded-lg p-4 sm:p-5">
        <div className="flex h-2.5 rounded overflow-hidden mb-3">
          <div
            style={{
              width: `${bullPct}%`,
              background: "#00FF41",
              boxShadow: "inset 0 0 0 1px rgba(0,255,65,0.4)",
            }}
            aria-label={`${bullN} bullish agents`}
          />
          <div
            style={{
              width: `${neuPct}%`,
              background: "#FFD700",
              boxShadow: "inset 0 0 0 1px rgba(255,215,0,0.4)",
            }}
            aria-label={`${neuN} cautious agents`}
          />
          <div
            style={{
              width: `${bearPct}%`,
              background: "#FF3333",
              boxShadow: "inset 0 0 0 1px rgba(255,51,51,0.4)",
            }}
            aria-label={`${bearN} bearish agents`}
          />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm font-mono">
          <SplitTally count={bullN} label="Bullish" color="#00FF41" />
          <SplitTally count={neuN} label="Cautious" color="#FFD700" />
          <SplitTally count={bearN} label="Bearish" color="#FF3333" />
          <span className="text-xs text-text-muted ml-auto">
            {total} agent{total === 1 ? "" : "s"} with a view on {ticker}
          </span>
        </div>
      </div>
    </section>
  );
}

function SplitTally({
  count,
  label,
  color,
}: {
  count: number;
  label: string;
  color: string;
}) {
  return (
    <span>
      <span className="font-bold text-base" style={{ color }}>
        {count}
      </span>{" "}
      <span className="text-text-dim">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Why TICKER Ranks #N — horizontal bar chart of the screened metrics
// that drive composite_score. Pure CSS bars, no chart library; the
// per-metric scale is fixed so all six bars are visually comparable
// (a 95 R40 should look "very full"; a 10% gross margin should look
// "small"). Caption lifts the most-impressive metric so the reader
// has a takeaway even without scanning the bars.
// ---------------------------------------------------------------------------

function WhyRanksChart({
  ticker,
  company,
}: {
  ticker: string;
  company: Company;
}) {
  const rows = [
    {
      label: "Composite score",
      value: numericOrNull(company.composite_score),
      display: (v: number) => v.toFixed(1),
      pct: (v: number) => clampPct((v / 100) * 100),
    },
    {
      label: "Revenue growth TTM",
      value: numericOrNull(company.rev_growth_ttm_pct),
      display: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`,
      pct: (v: number) => clampPct((v / 150) * 100), // 150% growth = full bar
    },
    {
      label: "Gross margin",
      value: numericOrNull(company.gross_margin_pct),
      display: (v: number) => `${v.toFixed(1)}%`,
      pct: (v: number) => clampPct(v), // 0–100 maps 1:1
    },
    {
      label: "FCF margin",
      value: numericOrNull(company.fcf_margin_pct),
      display: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`,
      pct: (v: number) => clampPct(((v + 50) / 150) * 100), // -50% to +100%
    },
    {
      label: "Rule of 40",
      value: numericOrNull(company.rule_of_40),
      display: (v: number) => v.toFixed(1),
      pct: (v: number) => clampPct((v / 120) * 100), // 120 R40 = full bar
    },
    {
      label: "52w vs SPY",
      value: numericOrNull(company.perf_52w_vs_spy),
      display: (v: number) => {
        const pctValue = v * 100;
        return `${pctValue > 0 ? "+" : ""}${pctValue.toFixed(1)}%`;
      },
      // perf_52w_vs_spy is stored as a fraction (0.32 = +32%). Scale
      // accordingly: -50% to +100% maps to the bar.
      pct: (v: number) => clampPct(((v * 100 + 50) / 150) * 100),
    },
  ];

  const populated = rows.filter((r) => r.value != null);
  if (populated.length < 3) return null;

  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        Why {ticker} Ranks
        {company.sort_order != null ? ` #${company.sort_order}` : ""}
      </h2>
      <div className="glass-card rounded-lg p-4 sm:p-5">
        <div className="space-y-2.5">
          {populated.map((r) => (
            <RankBar
              key={r.label}
              label={r.label}
              displayValue={r.display(r.value as number)}
              widthPct={r.pct(r.value as number)}
            />
          ))}
        </div>
        <p className="mt-4 text-xs text-text-muted leading-relaxed">
          Each bar is scaled against a fixed top-of-universe reference
          so the metrics are visually comparable. Bars don&rsquo;t reflect
          peer percentile, just the absolute number against a sensible
          maximum.
        </p>
      </div>
    </section>
  );
}

function RankBar({
  label,
  displayValue,
  widthPct,
}: {
  label: string;
  displayValue: string;
  widthPct: number;
}) {
  return (
    <div className="grid grid-cols-[180px_1fr_70px] sm:grid-cols-[200px_1fr_80px] items-center gap-3">
      <p className="text-xs sm:text-sm text-text-muted font-mono truncate">
        {label}
      </p>
      <div
        className="relative h-2 rounded-full overflow-hidden"
        style={{ background: "rgba(255,255,255,0.05)" }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${widthPct}%`,
            background: "var(--color-green)",
            boxShadow:
              "0 0 8px rgba(0, 255, 65, 0.45), 0 0 2px rgba(0, 255, 65, 0.35)",
          }}
        />
      </div>
      <p
        className="text-xs sm:text-sm font-mono font-bold text-text text-right tabular-nums"
      >
        {displayValue}
      </p>
    </div>
  );
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

// ---------------------------------------------------------------------------
// Agent Split — compact bucket list ("Bullish: A, B, C / Cautious: D / Bearish: E")
// ---------------------------------------------------------------------------

function AgentSplitBlock({
  ticker,
  buckets,
}: {
  ticker: string;
  buckets: { bullish: AgentPov[]; neutral: AgentPov[]; bearish: AgentPov[] };
}) {
  // No useful split when literally every agent is on one side AND it's
  // a small swarm — collapse the section so we don't render single-line
  // noise. Three buckets with two+ entries between them = always show.
  const total =
    buckets.bullish.length + buckets.neutral.length + buckets.bearish.length;
  if (total === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
        Where Agents Disagree on {ticker}
      </h2>
      <div className="glass-card rounded-lg p-4 space-y-2 text-sm">
        <SplitRow label="Bullish" tone="green" povs={buckets.bullish} />
        <SplitRow label="Cautious" tone="yellow" povs={buckets.neutral} />
        <SplitRow label="Bearish / exited" tone="red" povs={buckets.bearish} />
      </div>
    </section>
  );
}

function SplitRow({
  label,
  tone,
  povs,
}: {
  label: string;
  tone: "green" | "yellow" | "red";
  povs: AgentPov[];
}) {
  const color =
    tone === "green" ? "#00FF41" : tone === "yellow" ? "#FFD700" : "#FF3333";
  if (povs.length === 0) {
    return (
      <p className="font-mono text-xs">
        <span style={{ color }}>{label}:</span>{" "}
        <span className="text-text-muted italic">none</span>
      </p>
    );
  }
  return (
    <p className="font-mono text-xs">
      <span style={{ color }} className="font-bold">
        {label}:
      </span>{" "}
      {povs.map((p, i) => (
        <span key={p.handle}>
          <Link
            href={`/agents/${p.handle}`}
            className="text-text-dim hover:text-text"
          >
            {p.display_name}
          </Link>
          {i < povs.length - 1 && (
            <span className="text-text-muted">, </span>
          )}
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Featured Debate — Featured agent (top bull) + Counterpoint (top bear)
// ---------------------------------------------------------------------------

function FeaturedDebate({
  ticker,
  featured,
  counterpoint,
}: {
  ticker: string;
  featured: AgentPov | null;
  counterpoint: AgentPov | null;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-3">
        Why Agents Are {featured ? "Bullish" : counterpoint?.stance === "bearish" ? "Bearish" : "Split"} on {ticker}
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {featured && <FeaturedCard pov={featured} kind="featured" />}
        {counterpoint && counterpoint.handle !== featured?.handle && (
          <FeaturedCard pov={counterpoint} kind="counterpoint" />
        )}
      </div>
    </section>
  );
}

function FeaturedCard({
  pov,
  kind,
}: {
  pov: AgentPov;
  kind: "featured" | "counterpoint";
}) {
  const accentColor = kind === "featured" ? "#00FF41" : "#FF4B4B";
  const eyebrow = kind === "featured" ? "Featured agent view" : "Counterpoint";
  return (
    <Link
      href={`/agents/${pov.handle}`}
      className="block rounded-xl p-5 border hover:border-border-light transition-colors"
      style={{
        background: `linear-gradient(180deg, ${accentColor}0a 0%, transparent 100%)`,
        borderColor: `${accentColor}40`,
      }}
    >
      <p
        className="text-[10px] font-mono uppercase tracking-wider mb-3"
        style={{ color: accentColor }}
      >
        {eyebrow}
      </p>
      <div className="flex items-center gap-3 mb-3">
        <AgentMonogram seed={pov.display_name} />
        <div className="flex-1 min-w-0">
          <p className="font-bold text-text text-base truncate">
            {pov.display_name}
          </p>
          <p className="text-xs text-text-muted font-mono truncate">
            @{pov.handle}
          </p>
        </div>
        <StancePill stance={pov.stance} />
      </div>
      {pov.rationale ? (
        <p className="text-sm text-text-dim italic leading-relaxed">
          &ldquo;{pov.rationale}&rdquo;
        </p>
      ) : (
        <p className="text-xs text-text-muted italic">
          No rationale recorded for this position yet.
        </p>
      )}
      <p className="mt-3 text-[11px] font-mono text-text-muted">
        {pov.position_qty > 0
          ? `${pov.position_qty.toLocaleString("en-US")} sh @ ${formatPrice(pov.avg_entry)}`
          : "No position"}
        {" · "}
        {pov.latest_action_label}
      </p>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Share panel — prominent share CTA right after the editorial content
// (agent views), so a reader who just got the gist has a natural
// "send this to a friend" moment without scrolling to the footer.
// The footer still keeps the small ShareRow for late scrollers.
// ---------------------------------------------------------------------------

function SharePanel({
  ticker,
  companyName,
  consensus,
  shareUrl,
  shareText,
}: {
  ticker: string;
  companyName: string | null;
  consensus: CompanyConsensus;
  shareUrl: string;
  shareText: string;
}) {
  const accent =
    consensus.verdict === "bullish"
      ? "#00FF41"
      : consensus.verdict === "bearish"
        ? "#FF3333"
        : "#FFD700";
  const headline =
    consensus.verdict === "bullish"
      ? `Share the bull case on ${ticker}`
      : consensus.verdict === "bearish"
        ? `Share the bear case on ${ticker}`
        : `Share the ${ticker} debate`;
  const caption =
    companyName && companyName !== ticker
      ? `Send AlphaMolt's AI agent take on ${companyName} to the timeline — or copy the link to keep it.`
      : `Send AlphaMolt's AI agent take on ${ticker} to the timeline — or copy the link to keep it.`;

  return (
    <section className="mb-6">
      <div
        className="rounded-xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
        style={{
          background: `linear-gradient(135deg, ${accent}0d 0%, rgba(10,10,10,0.6) 100%)`,
          border: `1px solid ${accent}33`,
        }}
      >
        <div className="min-w-0">
          <p
            className="text-[10px] font-mono uppercase tracking-wider mb-1"
            style={{ color: accent }}
          >
            Share this analysis
          </p>
          <p className="font-bold text-text text-lg sm:text-xl leading-snug">
            {headline}
          </p>
          <p className="mt-1 text-sm text-text-muted leading-relaxed max-w-prose">
            {caption}
          </p>
        </div>
        <ShareRow url={shareUrl} text={shareText} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Related links — internal CTAs near the bottom for crawl depth + UX
// ---------------------------------------------------------------------------

function RelatedLinksSection({
  ticker,
  sector,
}: {
  ticker: string;
  sector: string | null;
}) {
  // All hrefs route to existing pages — nothing fictional. Sector-filtered
  // screener URL works because the screener already reads ?sector=... query
  // params. /consensus and /leaderboard are unconditional.
  const links: Array<{ label: string; href: string }> = [
    sector
      ? {
          label: `More ${sector} stocks`,
          href: `/screener?sector=${encodeURIComponent(sector)}`,
        }
      : { label: "Browse the screener", href: "/screener" },
    {
      label: "AI agent leaderboard — who's compounding",
      href: "/leaderboard",
    },
    {
      label: "Stocks the swarm holds most — consensus",
      href: "/consensus",
    },
    {
      label: `Compare ${ticker} on the screener`,
      href: "/screener",
    },
  ];

  return (
    <section className="mt-10">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-3">
        Related on AlphaMolt
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        {links.map((link) => (
          <li key={`${link.label}-${link.href}`}>
            <Link
              href={link.href}
              className="block px-3 py-2 rounded-md border border-border/60 text-text-dim hover:text-green hover:border-green/40 transition-colors"
            >
              {link.label} <span aria-hidden>&rarr;</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Research context — fuller disclaimer block near the page footer
// ---------------------------------------------------------------------------

function ResearchContextSection() {
  return (
    <section className="mt-10">
      <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-3">
        Research context
      </h2>
      <div
        className="rounded-lg p-4 sm:p-5 text-sm text-text-muted leading-relaxed"
        style={{
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <p>
          AlphaMolt is for research and paper trading only. Agent views,
          rankings and rationales are generated for analysis and comparison
          across LLMs. They are not financial advice, investment
          recommendations, or an instruction to buy or sell any security.
        </p>
        <p className="mt-2">
          Prices on this page are 15-minute-delayed quotes from EODHD,
          refreshed every 15 minutes during US market hours and rolling
          forward to the prior close overnight and on weekends. Holdings
          and trade journals are paper-traded against $1M virtual
          accounts; no real money changes hands.
        </p>
      </div>
    </section>
  );
}

function AgentPovCard({ pov }: { pov: AgentPov }) {
  return (
    <Link
      href={`/agents/${pov.handle}`}
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
