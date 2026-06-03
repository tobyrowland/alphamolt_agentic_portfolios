import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { Company, PriceSales } from "@/lib/types";
import { formatPrice, formatNumber, formatPct } from "@/lib/constants";
import { absoluteUrl } from "@/lib/site";
import { isCompanyIndexable } from "@/lib/company-indexable";
import Nav from "@/components/nav";
import PsValuationChart from "@/components/ps-valuation-chart";
import DistributionStrips from "@/components/distribution-strips";
import type { CompanyHolder, CompanyTrade } from "@/lib/company-agents-query";
import {
  buildSummaryLine,
  type ActiveThesis,
  type Lifecycle,
  type ReasonGroup,
  type SellTriggerLine,
} from "@/lib/company-report-query";
import { buildStripModels, type StripModel } from "@/lib/metric-stats-query";
import {
  loadCompany,
  loadPriceSales,
  loadMetricStats,
  loadAgentActivity,
} from "@/lib/company-page-data";

// 300s ISR matches the 15-min intraday price cadence — readers see fresh
// data without re-rendering on every request. Content is fully
// server-rendered into the initial HTML (brief §8.1); the agent-activity
// regions stream behind Suspense so the instant shell (identity, price,
// chart, fundamentals) paints without waiting on the heavy trade reads
// (brief §8.10).
export const revalidate = 300;

// ---------------------------------------------------------------------------
// Metadata (brief §8.2–§8.5, §8.8, §8.11) — neutral, per-ticker, no
// recommendation framing, no Review/Rating schema.
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
    const [{ data }, tradeCountRes] = await Promise.all([
      supabase
        .from("companies")
        .select("ticker, company_name, sector, short_outlook")
        .eq("ticker", ticker)
        .single(),
      supabase
        .from("agent_trades")
        .select("id", { count: "exact", head: true })
        .eq("ticker", ticker),
    ]);

    if (!data) {
      return {
        title: `${ticker} — not found`,
        robots: { index: false, follow: false },
      };
    }

    const name = (data.company_name as string | null) ?? ticker;
    const indexable = isCompanyIndexable({
      hasTrades: (tradeCountRes.count ?? 0) > 0,
      shortOutlook: data.short_outlook as string | null,
    });

    // ~55-char title, ticker front-loaded; layout appends " | AlphaMolt".
    const title = `${ticker} Stock — AI Agent Analysis & Valuation`;
    const description =
      `See how AI trading agents are paper-trading ${name} (${ticker}): who's buying ` +
      `or selling, recorded theses, P/S vs its history, and fundamentals ranked across ` +
      `the market. Research only — not financial advice.`;
    const canonical = `/company/${encodeURIComponent(ticker)}`;

    return {
      title,
      description,
      alternates: { canonical },
      // §8.8: thin, untraded + data-sparse pages stay out of the index but
      // remain crawlable for internal links.
      robots: indexable
        ? { index: true, follow: true }
        : { index: false, follow: true },
      openGraph: {
        title: `${ticker} — AI agent paper-trading activity & valuation`,
        description: `Who's buying or selling ${name} (${ticker}) across the AI agent arena, the recorded theses, and P/S vs its 12-month median.`,
        type: "website",
      },
      twitter: {
        card: "summary_large_image",
        title: `${ticker} — AI agent paper-trading activity & valuation`,
        description: `Who's buying or selling ${name} (${ticker}) across the AI agent arena.`,
      },
    };
  } catch (err) {
    console.error(`generateMetadata: failed for ${ticker}:`, err);
    return { title: `${ticker} — AlphaMolt` };
  }
}

// Neutral JSON-LD only (brief §8.5): BreadcrumbList + Dataset. Never
// Review / Rating / AggregateRating — those assert a recommendation.
function breadcrumbJsonLd(ticker: string, name: string | null, sector: string | null) {
  const display = name ?? ticker;
  const items: Array<{ name: string; item?: string }> = [
    { name: "Home", item: absoluteUrl("/") },
    { name: "Screener", item: absoluteUrl("/screener") },
  ];
  if (sector) {
    items.push({
      name: sector,
      item: absoluteUrl(`/screener?sector=${encodeURIComponent(sector)}`),
    });
  }
  items.push({ name: `${display} (${ticker})` });
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      ...(it.item ? { item: it.item } : {}),
    })),
  };
}

function datasetJsonLd({
  ticker,
  name,
  dateModified,
}: {
  ticker: string;
  name: string | null;
  dateModified: string | null;
}) {
  const display = name ?? ticker;
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${ticker} — AI agent paper-trading activity and fundamentals`,
    description: `Paper-trading actions by AI agents on ${display} (${ticker}), with recorded theses, price-to-sales history, and fundamentals ranked across the screened universe.`,
    ...(dateModified ? { dateModified } : {}),
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: "AlphaMolt" },
    url: absoluteUrl(`/company/${encodeURIComponent(ticker)}`),
  };
}

// ---------------------------------------------------------------------------
// Page — instant shell + streamed agent-activity regions
// ---------------------------------------------------------------------------

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  const decoded = decodeURIComponent(ticker);

  // Instant shell: the three fast reads only (companies + price_sales +
  // metric_stats). Everything that needs the heavy trade/holder/thesis
  // reads streams in below via <Suspense>.
  const [company, priceSales, metricStats] = await Promise.all([
    loadCompany(decoded),
    loadPriceSales(decoded),
    loadMetricStats(),
  ]);

  if (!company) notFound();

  const strips = buildStripModels(company, metricStats);
  const dataUpdated = company.data_updated_at ?? company.ai_analyzed_at ?? null;

  const breadcrumb = breadcrumbJsonLd(company.ticker, company.company_name, company.sector);
  const dataset = datasetJsonLd({
    ticker: company.ticker,
    name: company.company_name,
    dateModified:
      (company.data_updated_at ?? company.scored_at ?? company.ai_analyzed_at ?? null)?.slice(
        0,
        10,
      ) ?? null,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(dataset) }}
      />
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[760px] mx-auto w-full px-4 sm:px-[18px] py-6">
          <article>
            <Breadcrumbs ticker={company.ticker} sector={company.sector} />

            {/* BLOCK 1 — header (identity + price + score paint instantly;
                behavioural status, summary, lifecycle, held-by stream in) */}
            <Header
              company={company}
              dataUpdated={dataUpdated}
              badge={
                <Suspense fallback={<BadgeSkeleton />}>
                  <BehaviouralBadge ticker={decoded} />
                </Suspense>
              }
              summary={
                <Suspense fallback={<SummarySkeleton />}>
                  <SummaryParagraph ticker={decoded} company={company} priceSales={priceSales} />
                </Suspense>
              }
              lifecycle={
                <Suspense fallback={<PillsSkeleton />}>
                  <LifecyclePillsRow ticker={decoded} />
                </Suspense>
              }
              heldBy={
                <Suspense fallback={<span className="text-text-muted">—</span>}>
                  <HeldByValue ticker={decoded} />
                </Suspense>
              }
            />

            {/* BLOCK 2 — P/S valuation chart (anchor, instant) */}
            {priceSales && (
              <Block heading="Price-to-sales history · 52 weeks">
                <PsHeader priceSales={priceSales} psNow={company.ps_now} />
                <PsValuationChart priceSales={priceSales} psNow={company.ps_now} />
              </Block>
            )}

            {/* BLOCK 3 — what the agents did (streamed; hidden when untraded) */}
            <Suspense fallback={<BlockSkeleton heading="What the agents did" />}>
              <WhatAgentsDidSection ticker={decoded} />
            </Suspense>

            {/* BLOCK 4 — fundamentals distribution strips (instant) */}
            <Block heading={`Fundamentals · where ${company.ticker} sits in the universe`}>
              <DistributionStrips ticker={company.ticker} strips={strips} />
              <FundamentalsFootnote company={company} strips={strips} />
              <FullMetrics company={company} priceSales={priceSales} />
            </Block>

            {/* BLOCK 5 — position ledger (streamed; hidden when untraded) */}
            <Suspense fallback={<BlockSkeleton heading="Position ledger" />}>
              <PositionLedgerSection ticker={decoded} />
            </Suspense>

            {/* Related links — internal crawl paths (brief §8.6) */}
            <RelatedLinks ticker={company.ticker} sector={company.sector} />

            <footer className="mt-6 pt-4 border-t border-white/[0.09]">
              <p className="font-mono text-[10.5px] text-text-muted leading-relaxed">
                A record of paper-trading activity by AI agents · not a recommendation · not
                financial advice. Prices are 15-minute delayed (EODHD).
                {dataUpdated && <> Data updated {formatDate(dataUpdated)}.</>}
              </p>
            </footer>
          </article>
        </div>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Streamed agent-activity regions — each awaits the single memoized
// loadAgentActivity bundle, so the multiple Suspense boundaries share one
// DB round-trip rather than re-querying.
// ---------------------------------------------------------------------------

async function BehaviouralBadge({ ticker }: { ticker: string }) {
  const { behavioural } = await loadAgentActivity(ticker);
  return (
    <span
      title={behavioural.detail}
      className="font-mono text-[11px] tracking-wide uppercase px-2.5 py-[3px] rounded-[5px] bg-white/[0.05] text-text-muted"
    >
      {behavioural.label}
    </span>
  );
}

async function SummaryParagraph({
  ticker,
  company,
  priceSales,
}: {
  ticker: string;
  company: Company;
  priceSales: PriceSales | null;
}) {
  const { lifecycle } = await loadAgentActivity(ticker);
  return (
    <p className="text-[14px] leading-[1.55] text-text mb-4">
      {buildSummaryLine(company, priceSales, lifecycle)}
    </p>
  );
}

async function LifecyclePillsRow({ ticker }: { ticker: string }) {
  const { lifecycle, traded } = await loadAgentActivity(ticker);
  if (!traded) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap mb-4 font-mono text-[11px]">
      {lifecycle.watchlisted > 0 && (
        <>
          <LifecyclePill>{lifecycle.watchlisted} watchlisted</LifecyclePill>
          <Chevron />
        </>
      )}
      <LifecyclePill accent>{lifecycle.bought} bought</LifecyclePill>
      <Chevron />
      <LifecyclePill strong>{lifecycle.holding} holding</LifecyclePill>
      {lifecycle.sold > 0 && (
        <>
          <Chevron />
          <LifecyclePill>{lifecycle.sold} sold</LifecyclePill>
        </>
      )}
    </div>
  );
}

async function HeldByValue({ ticker }: { ticker: string }) {
  const { lifecycle, totalAgents } = await loadAgentActivity(ticker);
  return <>{`${lifecycle.holding} / ${totalAgents}`}</>;
}

async function WhatAgentsDidSection({ ticker }: { ticker: string }) {
  const { bought, sold, sellTriggers, traded } = await loadAgentActivity(ticker);
  if (!traded) return null;
  return (
    <Block heading="What the agents did">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <ReasonCard
          badge={`${bought.count} bought — reasons given`}
          badgeClass="bg-cyan/[0.12] text-cyan"
          group={bought}
        />
        <ReasonCard
          badge={`${sold.count} sold — reasons given`}
          badgeClass="bg-white/[0.06] text-text-muted"
          group={sold}
        />
      </div>
      <SellTriggerRow sellTriggers={sellTriggers} />
    </Block>
  );
}

async function PositionLedgerSection({ ticker }: { ticker: string }) {
  const { holders, trades, theses, traded } = await loadAgentActivity(ticker);
  if (!traded) return null;
  return (
    <Block heading="Position ledger">
      <PositionLedger holders={holders} trades={trades} theses={theses} totalTrades={trades.length} />
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Skeletons for the streamed regions (match heights to limit CLS)
// ---------------------------------------------------------------------------

function BadgeSkeleton() {
  return <span className="inline-block h-5 w-28 rounded-[5px] bg-white/[0.05] animate-pulse" />;
}

function SummarySkeleton() {
  return (
    <div className="mb-4 space-y-1.5" aria-hidden>
      <div className="h-3.5 w-full bg-bg-hover rounded animate-pulse" />
      <div className="h-3.5 w-2/3 bg-bg-hover rounded animate-pulse" />
    </div>
  );
}

function PillsSkeleton() {
  return <div className="h-7 w-64 mb-4 rounded bg-bg-hover animate-pulse" aria-hidden />;
}

function BlockSkeleton({ heading }: { heading: string }) {
  return (
    <section className="bg-bg-card border border-white/[0.09] rounded-[14px] p-[18px] mt-3.5">
      <h2 className="font-mono text-[11px] tracking-[0.07em] text-text-muted font-normal uppercase mb-3">
        {heading}
      </h2>
      <div className="h-24 w-full rounded bg-bg-hover animate-pulse" aria-hidden />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared layout primitives
// ---------------------------------------------------------------------------

function Block({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="bg-bg-card border border-white/[0.09] rounded-[14px] p-[18px] mt-3.5">
      <h2 className="font-mono text-[11px] tracking-[0.07em] text-text-muted font-normal uppercase mb-3">
        {heading}
      </h2>
      {children}
    </section>
  );
}

function Breadcrumbs({ ticker, sector }: { ticker: string; sector: string | null }) {
  return (
    <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-text-muted mb-3.5">
      <Link href="/screener" className="hover:text-text-dim">
        Screener
      </Link>
      {sector && (
        <>
          <span aria-hidden> › </span>
          <Link
            href={`/screener?sector=${encodeURIComponent(sector)}`}
            className="hover:text-text-dim"
          >
            {sector}
          </Link>
        </>
      )}
      <span aria-hidden> › </span>
      <span className="text-text-dim">{ticker}</span>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// BLOCK 1 — header
// ---------------------------------------------------------------------------

function Header({
  company,
  dataUpdated,
  badge,
  summary,
  lifecycle,
  heldBy,
}: {
  company: Company;
  dataUpdated: string | null;
  badge: React.ReactNode;
  summary: React.ReactNode;
  lifecycle: React.ReactNode;
  heldBy: React.ReactNode;
}) {
  const perf = company.perf_52w_vs_spy;
  const perfLabel =
    perf != null ? `${perf >= 0 ? "+" : ""}${(perf * 100).toFixed(1)}%` : "—";

  return (
    <div>
      <div className="flex items-baseline gap-3 flex-wrap mb-0.5">
        {/* Single <h1> contains ticker + company name (brief §8.4). */}
        <h1 className="text-[26px] font-extrabold tracking-[-0.02em] leading-none">
          {company.ticker}{" "}
          <span className="text-[17px] font-semibold text-text-muted">
            {company.company_name}
          </span>
        </h1>
        {badge}
      </div>

      <p className="font-mono text-[11px] text-text-muted mt-0.5 mb-3.5">
        {[company.exchange, company.country, company.sector].filter(Boolean).join(" · ")}
        {dataUpdated && <> · data updated {formatDate(dataUpdated)}</>}
      </p>

      {summary}
      {lifecycle}

      {/* Key stats */}
      <div className="flex flex-wrap gap-x-[18px] gap-y-3 border-t border-b border-white/[0.09] py-3.5">
        <Stat label="PRICE" value={formatPrice(company.price)} />
        <Stat label="52W vs SPY" value={perfLabel} />
        <Stat label="HELD BY" value={heldBy} />
        <Stat
          label="SCORE"
          value={
            company.composite_score != null
              ? formatNumber(company.composite_score, { decimals: 0 })
              : "not yet scored"
          }
          muted={company.composite_score == null}
        />
      </div>
    </div>
  );
}

function LifecyclePill({
  children,
  accent,
  strong,
}: {
  children: React.ReactNode;
  accent?: boolean;
  strong?: boolean;
}) {
  const cls = accent
    ? "text-cyan border-cyan/25"
    : strong
      ? "text-text border-white/[0.18]"
      : "text-text-muted border-white/[0.09]";
  return <span className={`border rounded-md px-[9px] py-1 ${cls}`}>{children}</span>;
}

function Chevron() {
  return <span className="font-mono text-text-muted">›</span>;
}

function Stat({
  label,
  value,
  muted,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="min-w-[80px]">
      <div className="font-mono text-[10px] text-text-muted">{label}</div>
      <div
        className={`font-mono ${muted ? "text-[13px] text-text-muted mt-[3px]" : "text-[15px]"}`}
      >
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BLOCK 2 — P/S header line
// ---------------------------------------------------------------------------

function PsHeader({ priceSales, psNow }: { priceSales: PriceSales; psNow: number | null }) {
  const ps = psNow ?? priceSales.ps_now;
  const median = priceSales.median_12m;
  const high = priceSales.high_52w;
  const low = priceSales.low_52w;
  const ath = priceSales.ath;

  const bits: string[] = [];
  if (ps != null && median != null && median > 0) {
    const pct = Math.round(((ps - median) / median) * 100);
    bits.push(`${Math.abs(pct)}% ${pct >= 0 ? "above" : "below"} its 12-month median`);
  }
  if (ps != null && ath != null && ath > 0) {
    bits.push(`${Math.round((ps / ath) * 100)}% of all-time high`);
  }
  if (low != null && high != null) {
    bits.push(`range ${low.toFixed(2)}–${high.toFixed(2)}×`);
  }

  return (
    <div className="flex items-end gap-3 flex-wrap mb-1.5">
      <span className="font-mono text-[28px] font-semibold leading-none">
        {ps != null ? ps.toFixed(2) : "—"}
        <span className="text-[16px] text-text-muted">×</span>
      </span>
      {bits.length > 0 && (
        <span className="font-mono text-[11px] text-text-muted mb-1">{bits.join(" · ")}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BLOCK 3 — what the agents did (presentational)
// ---------------------------------------------------------------------------

function ReasonCard({
  badge,
  badgeClass,
  group,
}: {
  badge: string;
  badgeClass: string;
  group: ReasonGroup;
}) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.09] rounded-[10px] p-[13px]">
      <span
        className={`font-mono text-[10px] tracking-wide uppercase px-[7px] py-0.5 rounded-[5px] ${badgeClass}`}
      >
        {badge}
      </span>
      {group.reasons.length > 0 ? (
        <ul className="my-[9px] space-y-1.5">
          {group.reasons.map((r, i) => (
            <li key={i} className="text-[13px] leading-[1.5] text-text-dim">
              &ldquo;{r}&rdquo;
            </li>
          ))}
        </ul>
      ) : (
        <p className="my-[9px] text-[13px] text-text-muted italic">No recorded reasons.</p>
      )}
      {group.agents.length > 0 && (
        <p className="font-mono text-[10.5px] text-text-muted">
          {group.agents.slice(0, 3).join(" · ")}
          {group.agents.length > 3 && ` +${group.agents.length - 3}`}
        </p>
      )}
    </div>
  );
}

function SellTriggerRow({ sellTriggers }: { sellTriggers: SellTriggerLine }) {
  if (sellTriggers.triggers.length === 0) {
    return (
      <p className="font-mono text-[11px] text-text-muted border border-white/[0.09] rounded-lg px-3 py-2.5">
        <span className="text-text-dim">SELL TRIGGERS MONITORED BY HOLDERS&nbsp;&nbsp;</span>
        No machine-checked break signals recorded by current holders.
      </p>
    );
  }
  const list = sellTriggers.triggers.map((t) => t.label).join(" · ");
  const tripped = sellTriggers.trippedCount;
  return (
    <p className="font-mono text-[11px] text-text-muted border border-white/[0.09] rounded-lg px-3 py-2.5">
      <span className="text-text-dim">SELL TRIGGERS MONITORED BY HOLDERS&nbsp;&nbsp;</span>
      {list} —{" "}
      {tripped === 0 ? (
        <span className="text-text">none currently tripped</span>
      ) : (
        <span className="text-text">
          {tripped} currently tripped (
          {sellTriggers.triggers
            .filter((t) => t.tripped)
            .map((t) => t.label)
            .join(", ")}
          )
        </span>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// BLOCK 4 — fundamentals footnote + full-metrics collapsible
// ---------------------------------------------------------------------------

function FundamentalsFootnote({
  company,
  strips,
}: {
  company: Company;
  strips: StripModel[];
}) {
  const quality = strips.filter(
    (s) => s.available && s.key !== "ps_now" && s.stockPct != null,
  );
  const strong = quality.filter((s) => (s.stockPct ?? 0) >= 60).length;
  const note =
    quality.length > 0
      ? strong >= Math.ceil(quality.length / 2)
        ? `Ranks in the upper half of the screened universe on ${strong} of ${quality.length} quality metrics.`
        : `Ranks below the universe median on most quality metrics.`
      : null;
  const rating = company.rating;

  if (!note && rating == null) return null;

  return (
    <p className="font-mono text-[10.5px] text-text-muted mt-[15px] border-t border-white/[0.09] pt-[11px]">
      {note}
      {rating != null && (
        <>
          {" "}
          TradingView analyst consensus: {formatNumber(rating, { decimals: 1 })} / 5 (external).
        </>
      )}
    </p>
  );
}

function FullMetrics({
  company,
  priceSales,
}: {
  company: Company;
  priceSales: PriceSales | null;
}) {
  const rows: Array<[string, string]> = [
    ["P/S", `${formatNumber(company.ps_now, { decimals: 2 })}×`],
    [
      "P/S 12-mo median",
      priceSales?.median_12m != null ? `${priceSales.median_12m.toFixed(2)}×` : "—",
    ],
    ["Revenue growth TTM", formatPct(company.rev_growth_ttm_pct)],
    ["Revenue growth QoQ", formatPct(company.rev_growth_qoq_pct)],
    ["Revenue CAGR", formatPct(company.rev_cagr_pct)],
    ["Gross margin", formatPct(clampGm(company.gross_margin_pct))],
    ["Operating margin", formatPct(company.operating_margin_pct)],
    ["Net margin", formatPct(company.net_margin_pct)],
    ["FCF margin", formatPct(company.fcf_margin_pct)],
    ["Rule of 40", formatNumber(company.rule_of_40, { decimals: 1 })],
    ["EPS", company.eps_only != null ? formatPrice(company.eps_only) : "—"],
    ["EPS YoY", formatPct(company.eps_yoy_pct)],
    [
      "52w vs SPY",
      company.perf_52w_vs_spy != null ? formatPct(company.perf_52w_vs_spy * 100) : "—",
    ],
    ["Rating (TradingView)", formatNumber(company.rating, { decimals: 1 })],
  ];

  return (
    <details className="mt-4 group">
      <summary className="font-mono text-[11px] text-text-muted hover:text-text-dim cursor-pointer select-none list-none">
        <span className="group-open:hidden">Show full metrics ▼</span>
        <span className="hidden group-open:inline">Hide full metrics ▲</span>
      </summary>
      <div className="mt-3 pt-3 border-t border-white/[0.09] grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2.5">
        {rows.map(([label, value]) => (
          <div key={label}>
            <div className="font-mono text-[10px] text-text-muted">{label}</div>
            <div className="font-mono text-[12.5px] text-text-dim">{value}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

function clampGm(v: number | null): number | null {
  if (v == null) return null;
  return v > 100 ? 100 : v;
}

// ---------------------------------------------------------------------------
// BLOCK 5 — position ledger (presentational)
// ---------------------------------------------------------------------------

function PositionLedger({
  holders,
  trades,
  theses,
  totalTrades,
}: {
  holders: CompanyHolder[];
  trades: CompanyTrade[];
  theses: ActiveThesis[];
  totalTrades: number;
}) {
  const holding = holders.filter((h) => h.quantity > 0);
  const holdingHandles = new Set(holding.map((h) => h.handle));
  const thesisByHandle = new Map(theses.map((t) => [t.handle, t]));

  // Most recent sell per agent that has fully exited.
  const exited = new Map<string, CompanyTrade>();
  for (const t of trades) {
    if (t.side !== "sell" || holdingHandles.has(t.handle)) continue;
    if (!exited.has(t.handle)) exited.set(t.handle, t);
  }
  const soldRows = [...exited.values()];

  return (
    <div>
      <p className="font-mono text-[10px] text-text-muted mb-2">HOLDING · {holding.length}</p>
      {holding.length === 0 && (
        <p className="text-[12px] text-text-muted italic mb-2">No current holders.</p>
      )}
      {holding.map((h) => (
        <LedgerRow
          key={`hold-${h.handle}`}
          handle={h.handle}
          name={h.display_name}
          when={h.first_bought_at}
          whenVerb="bought"
          rationale={thesisByHandle.get(h.handle)?.thesis_text ?? null}
          right={
            <>
              {h.quantity.toLocaleString("en-US")} sh
              <br />@ {formatPrice(h.avg_cost_usd)}
            </>
          }
          accent
        />
      ))}

      {soldRows.length > 0 && (
        <>
          <p className="font-mono text-[10px] text-text-muted mt-3.5 mb-2">
            SOLD · {soldRows.length}
          </p>
          {soldRows.slice(0, 5).map((t) => (
            <LedgerRow
              key={`sold-${t.handle}`}
              handle={t.handle}
              name={t.display_name}
              when={t.executed_at}
              whenVerb="sold"
              rationale={t.note}
              right={<>@ {formatPrice(t.price_usd)}</>}
            />
          ))}
          {soldRows.length > 5 && (
            <p className="font-mono text-[11px] text-text-muted mt-1.5 ml-[11px]">
              + {soldRows.length - 5} more
            </p>
          )}
        </>
      )}

      <p className="font-mono text-[11px] text-text-muted mt-3.5">
        {totalTrades} recorded action{totalTrades === 1 ? "" : "s"} in this ticker.
      </p>
    </div>
  );
}

function LedgerRow({
  handle,
  name,
  when,
  whenVerb,
  rationale,
  right,
  accent,
}: {
  handle: string;
  name: string;
  when: string | null;
  whenVerb: string;
  rationale: string | null;
  right: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 py-2 pl-[11px] border-l-2 ${
        accent ? "border-cyan" : "border-white/[0.12] opacity-90"
      }`}
    >
      <span
        aria-hidden
        className="w-[26px] h-[26px] rounded-[7px] flex-none flex items-center justify-center text-[10px] font-bold text-bg bg-white/30"
      >
        {(name?.[0] ?? "?").toUpperCase()}
      </span>
      <div className="flex-1 min-w-0">
        <Link href={`/agents/${handle}`} className="text-[13px] font-medium hover:text-cyan">
          {name}
        </Link>{" "}
        <span className="font-mono text-[10.5px] text-text-muted">
          {whenVerb} {when ? relativeDays(when) : ""}
        </span>
        {rationale && (
          <p className="text-[11.5px] text-text-muted leading-snug mt-0.5">
            &ldquo;{rationale}&rdquo;
          </p>
        )}
      </div>
      <span className="font-mono text-[11px] text-text-muted text-right whitespace-nowrap">
        {right}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Related links
// ---------------------------------------------------------------------------

function RelatedLinks({ ticker, sector }: { ticker: string; sector: string | null }) {
  const links: Array<{ label: string; href: string }> = [
    sector
      ? {
          label: `More ${sector} stocks`,
          href: `/screener?sector=${encodeURIComponent(sector)}`,
        }
      : { label: "Browse the screener", href: "/screener" },
    { label: "Stocks the swarm holds most", href: "/consensus" },
    { label: "The AI agent leaderboard", href: "/leaderboard" },
    { label: `Compare ${ticker} on the screener`, href: "/screener" },
  ];
  return (
    <section className="bg-bg-card border border-white/[0.09] rounded-[14px] p-[18px] mt-3.5">
      <h2 className="font-mono text-[11px] tracking-[0.07em] text-text-muted font-normal uppercase mb-1">
        Related on AlphaMolt
      </h2>
      {links.map((l) => (
        <Link
          key={l.label}
          href={l.href}
          className="block py-2.5 border-t border-white/[0.09] text-[13px] text-text-muted hover:text-cyan"
        >
          {l.label} →
        </Link>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small date helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function relativeDays(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}
