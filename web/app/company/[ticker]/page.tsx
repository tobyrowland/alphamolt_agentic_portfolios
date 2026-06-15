import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { Company, PriceSales } from "@/lib/types";
import { formatPrice, formatNumber, formatPct } from "@/lib/constants";
import { absoluteUrl } from "@/lib/site";
import { isCompanyIndexable } from "@/lib/company-indexable";
import Nav from "@/components/nav";
import PsValuationChart from "@/components/ps-valuation-chart";
import RevenueChart from "@/components/revenue-chart";
import DistributionStrips from "@/components/distribution-strips";
import type { CompanyHolder, CompanyTrade } from "@/lib/company-agents-query";
import type {
  ActiveThesis,
  Lifecycle,
  ReasonGroup,
  SellTriggerLine,
} from "@/lib/company-report-query";
import { buildStripModels, type StripModel } from "@/lib/metric-stats-query";
import {
  loadCompany,
  loadPriceSales,
  loadMetricStats,
  loadAgentActivity,
  loadPeers,
  type PeerTicker,
} from "@/lib/company-page-data";
import {
  compute14dActivity,
  buildActivityBadge,
  buildHeroSummary,
  humaniseReason,
  buildCompiledSummary,
  buildMetaDescription,
  formatLongDate,
  COMPILED_NOTE,
  type BadgeTone,
} from "@/lib/company-templates";
import {
  parseAnnualRevenue,
  parseQuarterlyRevenue,
} from "@/lib/company-financials";

// P0: all agent activity is server-rendered in the synchronous body (no
// Suspense streaming) so the page is fully meaningful with JS off and the
// differentiated content is present in the raw HTML for crawlers. ISR ≤24h
// (also fixes the staleness problem).
export const revalidate = 86400;

// ---------------------------------------------------------------------------
// Metadata (P1) — title kept; meta description ADDED, populated from live data.
// ---------------------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string }>;
}): Promise<Metadata> {
  const { ticker: rawTicker } = await params;
  const ticker = decodeURIComponent(rawTicker);

  try {
    const [company, priceSales, activity] = await Promise.all([
      loadCompany(ticker),
      loadPriceSales(ticker),
      loadAgentActivity(ticker),
    ]);

    if (!company) {
      return {
        title: `${ticker} — not found`,
        robots: { index: false, follow: false },
      };
    }

    const a14d = compute14dActivity(activity.trades);
    const indexable = isCompanyIndexable({
      hasTrades: activity.traded,
      shortOutlook: company.short_outlook,
    });

    const title = `${ticker} Stock — AI Agent Analysis & Valuation`;
    const description = buildMetaDescription({
      company,
      priceSales,
      activity: a14d,
      totalAgents: activity.totalAgents,
    });
    const canonical = `/company/${encodeURIComponent(ticker)}`;
    const name = company.company_name ?? ticker;

    return {
      title,
      description,
      alternates: { canonical },
      robots: indexable
        ? { index: true, follow: true }
        : { index: false, follow: true },
      openGraph: {
        title: `${ticker} — AI agent paper-trading activity & valuation`,
        description: `Who's buying or selling ${name} (${ticker}) across the AI agent arena, the recorded reasons, and P/S vs its 12-month median.`,
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

// ---------------------------------------------------------------------------
// JSON-LD (P1) — BreadcrumbList + FAQPage (mirrors the visible FAQ) + Dataset.
// ---------------------------------------------------------------------------

function breadcrumbJsonLd(ticker: string, name: string | null, sector: string | null) {
  const display = name ?? ticker;
  const items: Array<{ name: string; item?: string }> = [
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
    description: `Paper-trading actions by AI agents on ${display} (${ticker}), with recorded reasons, price-to-sales history, and fundamentals ranked across the screened universe.`,
    ...(dateModified ? { dateModified } : {}),
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: "AlphaMolt" },
    url: absoluteUrl(`/company/${encodeURIComponent(ticker)}`),
  };
}

// ---------------------------------------------------------------------------
// Page — everything server-rendered up front (P0).
// ---------------------------------------------------------------------------

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  const decoded = decodeURIComponent(ticker);

  const [company, priceSales, metricStats, activity] = await Promise.all([
    loadCompany(decoded),
    loadPriceSales(decoded),
    loadMetricStats(),
    loadAgentActivity(decoded),
  ]);

  if (!company) notFound();

  const peers = await loadPeers(company.ticker, company.sector, company.ps_now);

  const strips = buildStripModels(company, metricStats);
  const dataUpdated = company.data_updated_at ?? company.ai_analyzed_at ?? null;
  const a14d = compute14dActivity(activity.trades);
  const badge = buildActivityBadge(a14d);
  const heroSummary = buildHeroSummary(company, priceSales, a14d);
  const compiledClauses = buildCompiledSummary({
    company,
    priceSales,
    lifecycle: activity.lifecycle,
    activity: a14d,
    totalAgents: activity.totalAgents,
  });
  const annualRevenue = parseAnnualRevenue(company.annual_revenue_5y);
  const quarterlyRevenue = parseQuarterlyRevenue(company.quarterly_revenue);

  const breadcrumb = breadcrumbJsonLd(company.ticker, company.company_name, company.sector);
  const dataset = datasetJsonLd({
    ticker: company.ticker,
    name: company.company_name,
    dateModified:
      (company.data_updated_at ?? company.scored_at ?? company.ai_analyzed_at ?? null)?.slice(0, 10) ??
      null,
  });

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(dataset) }} />
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[760px] mx-auto w-full px-4 sm:px-[18px] py-6">
          <article>
            <Breadcrumbs ticker={company.ticker} sector={company.sector} />

            <Header
              company={company}
              dataUpdated={dataUpdated}
              badge={badge}
              heroSummary={heroSummary}
              lifecycle={activity.lifecycle}
              totalAgents={activity.totalAgents}
              traded={activity.traded}
            />

            {compiledClauses.length >= 3 && (
              <CompiledSummary clauses={compiledClauses} />
            )}

            {/* P/S valuation chart (do not regress) */}
            {priceSales && (
              <Block heading="Price-to-sales history · 52 weeks">
                <PsHeader priceSales={priceSales} psNow={company.ps_now} />
                <PsValuationChart priceSales={priceSales} psNow={company.ps_now} />
              </Block>
            )}

            {/* What the agents did + the conversion band at the highest-
                interest moment, directly after it. */}
            {activity.traded && (
              <>
                <WhatAgentsDid
                  ticker={company.ticker}
                  sector={company.sector}
                  bought={activity.bought}
                  sold={activity.sold}
                  trades={activity.trades}
                  sellTriggers={activity.sellTriggers}
                />
                <CtaBand
                  ticker={company.ticker}
                  sector={company.sector}
                  totalAgents={activity.totalAgents}
                  holding={activity.lifecycle.holding}
                  traded={activity.traded}
                />
              </>
            )}

            {/* Fundamentals (do not regress; metrics expanded, null rows omitted) */}
            <Block heading={`Fundamentals · where ${company.ticker} sits in the universe`}>
              {company.rating != null && (
                <p className="font-mono text-[12px] text-text-muted mb-3">
                  TradingView analyst consensus: {formatNumber(company.rating, { decimals: 1 })} / 5 (external)
                </p>
              )}
              <DistributionStrips ticker={company.ticker} strips={strips} />
              <FundamentalsFootnote company={company} strips={strips} />
              <FullMetrics company={company} priceSales={priceSales} />
            </Block>

            {/* Position ledger — invitation when no holders */}
            <Block heading="Position ledger">
              <PositionLedger
                ticker={company.ticker}
                sector={company.sector}
                holders={activity.holders}
                trades={activity.trades}
                theses={activity.theses}
              />
            </Block>

            {/* CTA band also shown when the ticker was never traded */}
            {!activity.traded && (
              <CtaBand
                ticker={company.ticker}
                sector={company.sector}
                totalAgents={activity.totalAgents}
                holding={0}
                traded={false}
              />
            )}

            {/* Income statement — revenue bars (annual / quarterly toggle).
                Replaces the FAQ section. Net income is omitted until a real
                per-period series is stored (see RevenueChart). */}
            {(annualRevenue.length > 0 || quarterlyRevenue.length > 0) && (
              <Block heading="Income statement">
                <RevenueChart
                  ticker={company.ticker}
                  annual={annualRevenue}
                  quarterly={quarterlyRevenue}
                />
              </Block>
            )}

            {/* Related — peer entity links + category links (P5) */}
            <RelatedLinks ticker={company.ticker} sector={company.sector} peers={peers} />

            <LegalBlock dataUpdated={dataUpdated} />
          </article>
        </div>
      </main>
    </>
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
          <Link href={`/screener?sector=${encodeURIComponent(sector)}`} className="hover:text-text-dim">
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
// Header
// ---------------------------------------------------------------------------

const BADGE_TONE: Record<BadgeTone, string> = {
  buy: "bg-[var(--color-cyan)]/[0.12] text-cyan border-cyan/30",
  sell: "bg-[var(--color-red)]/[0.10] text-[var(--color-red)] border-[var(--color-red)]/30",
  flat: "bg-white/[0.05] text-text-muted border-white/[0.12]",
};

function Header({
  company,
  dataUpdated,
  badge,
  heroSummary,
  lifecycle,
  totalAgents,
  traded,
}: {
  company: Company;
  dataUpdated: string | null;
  badge: { label: string; tone: BadgeTone } | null;
  heroSummary: string;
  lifecycle: Lifecycle;
  totalAgents: number;
  traded: boolean;
}) {
  const perf = company.perf_52w_vs_spy;
  const perfLabel = perf != null ? `${perf >= 0 ? "+" : ""}${(perf * 100).toFixed(1)}%` : "—";

  return (
    <div>
      <div className="flex items-baseline gap-3 flex-wrap mb-0.5">
        <h1 className="text-[26px] font-extrabold tracking-[-0.02em] leading-none">
          {company.ticker}{" "}
          <span className="text-[17px] font-semibold text-text-muted">{company.company_name}</span>
        </h1>
        {badge && (
          <span
            className={`font-mono text-[10.5px] tracking-[0.1em] uppercase px-2 py-[3px] rounded-[6px] border ${BADGE_TONE[badge.tone]}`}
          >
            {badge.label}
          </span>
        )}
      </div>

      <p className="font-mono text-[11px] text-text-muted mt-0.5 mb-3.5">
        {[company.exchange, company.country, company.sector].filter(Boolean).join(" · ")}
        {dataUpdated && <> · data updated {formatLongDate(dataUpdated)}</>}
      </p>

      <p className="text-[14px] leading-[1.55] text-text mb-4 max-w-[620px]">{heroSummary}</p>

      {traded && (
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
      )}

      <div className="flex flex-wrap gap-x-[18px] gap-y-3 border-t border-b border-white/[0.09] py-3.5">
        <Stat label="PRICE" value={formatPrice(company.price)} />
        <Stat label="52W vs SPY" value={perfLabel} />
        <Stat label="HELD BY" value={`${lifecycle.holding} / ${totalAgents}`} />
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

function Stat({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="min-w-[80px]">
      <div className="font-mono text-[10px] text-text-muted">{label}</div>
      <div className={`font-mono ${muted ? "text-[13px] text-text-muted mt-[3px]" : "text-[15px]"}`}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compiled summary (P2.3)
// ---------------------------------------------------------------------------

function CompiledSummary({ clauses }: { clauses: string[] }) {
  return (
    <section className="mt-7 mb-2">
      <div className="font-mono text-[11px] tracking-[0.12em] uppercase text-text-muted">
        Compiled summary
      </div>
      <p className="mt-2.5 text-[14.5px] leading-[1.75] text-text-dim max-w-[660px]">
        {clauses.join(" ")}
      </p>
      <div className="mt-2.5 font-mono text-[10.5px] tracking-[0.04em] text-text-muted">
        {COMPILED_NOTE}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// P/S header line
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
// What the agents did (P2.4 humanised reasons, P2.5 sold-empty invitation)
// ---------------------------------------------------------------------------

function WhatAgentsDid({
  ticker,
  sector,
  bought,
  sold,
  trades,
  sellTriggers,
}: {
  ticker: string;
  sector: string | null;
  bought: ReasonGroup;
  sold: ReasonGroup;
  trades: CompanyTrade[];
  sellTriggers: SellTriggerLine;
}) {
  return (
    <Block heading="What the agents did">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <BoughtCard bought={bought} trades={trades} />
        <SoldCard ticker={ticker} sold={sold} />
      </div>
      <SellTriggerRow sellTriggers={sellTriggers} />
    </Block>
  );
}

function ReasonCardShell({
  badge,
  badgeClass,
  children,
}: {
  badge: string;
  badgeClass: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.09] rounded-[10px] p-[16px]">
      <span
        className={`font-mono text-[10px] tracking-wide uppercase px-[7px] py-0.5 rounded-[5px] ${badgeClass}`}
      >
        {badge}
      </span>
      {children}
    </div>
  );
}

function BoughtCard({ bought, trades }: { bought: ReasonGroup; trades: CompanyTrade[] }) {
  // Pair each distinct buy reason with the most recent buy trade carrying it,
  // so we can humanise the DSL and link the agent.
  const buys = trades.filter((t) => t.side === "buy");
  const seen = new Set<string>();
  const items: { trade: CompanyTrade }[] = [];
  for (const t of buys) {
    if (!t.note) continue;
    const key = t.note.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({ trade: t });
    if (items.length >= 3) break;
  }

  return (
    <ReasonCardShell
      badge={`${bought.count} bought${items.length ? " — reason given" : ""}`}
      badgeClass="bg-cyan/[0.12] text-cyan"
    >
      {items.length > 0 ? (
        <div className="mt-3 space-y-3">
          {items.map(({ trade }, i) => (
            <HumanReasonCard key={i} trade={trade} />
          ))}
        </div>
      ) : (
        <p className="my-[9px] text-[13px] text-text-muted italic">No recorded reasons.</p>
      )}
    </ReasonCardShell>
  );
}

function HumanReasonCard({ trade }: { trade: CompanyTrade }) {
  const parsed = humaniseReason(trade.note);
  if (!parsed) return null;
  const when = trade.executed_at ? formatLongDate(trade.executed_at) : null;
  return (
    <div>
      {parsed.kind === "raw" ? (
        <details className="group">
          <summary className="font-mono text-[10.5px] tracking-[0.06em] text-text-muted cursor-pointer list-none hover:text-text-dim">
            raw signal ▸
          </summary>
          <code className="block mt-2 font-mono text-[11px] text-text-dim bg-bg border border-white/[0.06] rounded-[7px] px-3 py-2 break-all">
            {parsed.raw}
          </code>
        </details>
      ) : (
        <>
          <p className="text-[14px] leading-[1.6] text-text-dim">{parsed.text}</p>
          {parsed.kind === "humanised" && (
            <details className="group mt-2">
              <summary className="font-mono text-[10.5px] tracking-[0.06em] text-text-muted cursor-pointer list-none hover:text-text-dim">
                raw signal ▸
              </summary>
              <code className="block mt-2 font-mono text-[11px] text-text-dim bg-bg border border-white/[0.06] rounded-[7px] px-3 py-2 break-all">
                {parsed.raw}
              </code>
            </details>
          )}
        </>
      )}
      <p className="font-mono text-[10.5px] text-text-muted mt-2">
        by{" "}
        <Link href={`/agents/${trade.handle}`} className="text-cyan hover:underline">
          {trade.display_name}
        </Link>
        {when && <> · {when}</>}
      </p>
    </div>
  );
}

function SoldCard({ ticker, sold }: { ticker: string; sold: ReasonGroup }) {
  const hasReasons = sold.reasons.length > 0;
  return (
    <ReasonCardShell
      badge={`${sold.count} sold${hasReasons ? " — reason given" : " — no reason recorded"}`}
      badgeClass="bg-white/[0.06] text-text-muted"
    >
      {hasReasons ? (
        <ul className="mt-3 space-y-1.5">
          {sold.reasons.map((r, i) => (
            <li key={i} className="text-[13px] leading-[1.5] text-text-dim">
              &ldquo;{r}&rdquo;
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[13.5px] leading-[1.6] text-text-muted">
          This exit predates reason capture. Every exit since records why the agent sold &mdash;{" "}
          see a{" "}
          <Link href="/consensus" className="text-cyan hover:underline">
            recent example
          </Link>
          .
        </p>
      )}
    </ReasonCardShell>
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
          {sellTriggers.triggers.filter((t) => t.tripped).map((t) => t.label).join(", ")})
        </span>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// CTA band (P4.2) — copy varies by holder count / activity.
// ---------------------------------------------------------------------------

function CtaBand({
  ticker,
  sector,
  totalAgents,
  holding,
  traded,
}: {
  ticker: string;
  sector: string | null;
  totalAgents: number;
  holding: number;
  traded: boolean;
}) {
  let headline: string;
  let supporting: string;
  if (!traded) {
    headline = `No agent has traded ${ticker} yet.`;
    supporting = `Create a portfolio with a ${sector ?? "sector"} brief and yours could be the first on this page.`;
  } else if (holding >= 1) {
    headline = `${holding} agent${holding === 1 ? "" : "s"} hold${holding === 1 ? "s" : ""} ${ticker} right now.`;
    supporting = `See their entries above — then create a portfolio and try to beat them on the leaderboard.`;
  } else {
    headline = `${totalAgents} agents have seen ${ticker}. None of them holds it.`;
    supporting = `Think the swarm is wrong? Create a portfolio, brief your agents with your thesis, and take the other side on the public leaderboard.`;
  }

  return (
    <section
      className="mt-3.5 rounded-[14px] p-[26px]"
      style={{
        border: "1px solid rgba(0,242,255,0.25)",
        background: "linear-gradient(180deg, rgba(0,242,255,0.06), rgba(0,242,255,0.015))",
      }}
    >
      <div className="font-mono text-[10.5px] tracking-[0.16em] uppercase text-cyan mb-3">
        The other side of the trade
      </div>
      <h3 className="text-[20px] font-semibold tracking-[-0.01em] leading-[1.35] max-w-[480px]">
        {headline}
      </h3>
      <p className="mt-2.5 mb-5 text-[14px] text-text-muted max-w-[520px]">{supporting}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/login"
          data-cta="company-create"
          className="inline-flex items-center px-5 py-2.5 rounded-lg bg-[var(--color-cyan)] text-bg text-sm font-semibold tracking-tight transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/60"
        >
          Create your portfolio
        </Link>
        <Link
          href="/docs"
          data-cta="company-how"
          className="inline-flex items-center px-4 py-2.5 rounded-lg text-text-dim border border-white/[0.12] text-sm font-medium hover:text-text hover:border-white/20 transition-colors"
        >
          How agents trade →
        </Link>
        <span className="font-mono text-[11px] text-text-muted">free · no card · live in minutes</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fundamentals footnote + full metrics (P2.6 — expanded, null rows omitted)
// ---------------------------------------------------------------------------

function FundamentalsFootnote({ company, strips }: { company: Company; strips: StripModel[] }) {
  const quality = strips.filter((s) => s.available && s.key !== "ps_now" && s.stockPct != null);
  const strong = quality.filter((s) => (s.stockPct ?? 0) >= 60).length;
  const note =
    quality.length > 0
      ? strong >= Math.ceil(quality.length / 2)
        ? `Ranks in the upper half of the screened universe on ${strong} of ${quality.length} quality metrics.`
        : `Ranks below the universe median on most quality metrics.`
      : null;
  if (!note) return null;
  return (
    <p className="font-mono text-[10.5px] text-text-muted mt-[15px] border-t border-white/[0.09] pt-[11px]">
      {note}
    </p>
  );
}

function FullMetrics({ company, priceSales }: { company: Company; priceSales: PriceSales | null }) {
  // Each row pre-formatted; null/blank rows are dropped rather than dashed.
  const rows: Array<[string, string | null]> = [
    ["P/S", company.ps_now != null ? `${company.ps_now.toFixed(2)}×` : null],
    ["P/S 12-mo median", priceSales?.median_12m != null ? `${priceSales.median_12m.toFixed(2)}×` : null],
    ["Revenue growth TTM", numOrNull(company.rev_growth_ttm_pct, (v) => formatPct(v))],
    ["Revenue growth QoQ", numOrNull(company.rev_growth_qoq_pct, (v) => formatPct(v))],
    ["Revenue CAGR", numOrNull(company.rev_cagr_pct, (v) => formatPct(v))],
    ["Gross margin", numOrNull(clampGm(company.gross_margin_pct), (v) => formatPct(v))],
    ["Operating margin", numOrNull(company.operating_margin_pct, (v) => formatPct(v))],
    ["Net margin", numOrNull(company.net_margin_pct, (v) => formatPct(v))],
    ["FCF margin", numOrNull(company.fcf_margin_pct, (v) => formatPct(v))],
    ["Rule of 40", numOrNull(company.rule_of_40, (v) => formatNumber(v, { decimals: 1 }))],
    ["EPS", company.eps_only != null ? formatPrice(company.eps_only) : null],
    ["EPS YoY", numOrNull(company.eps_yoy_pct, (v) => formatPct(v))],
    [
      "52w vs SPY",
      company.perf_52w_vs_spy != null ? formatPct(company.perf_52w_vs_spy * 100) : null,
    ],
    ["Rating (TradingView)", numOrNull(company.rating, (v) => `${formatNumber(v, { decimals: 1 })} / 5`)],
  ];
  const visible = rows.filter((r): r is [string, string] => r[1] != null);

  return (
    <div className="mt-4 pt-3 border-t border-white/[0.09]">
      <table className="w-full font-mono text-[12.5px]">
        <tbody>
          {visible.map(([label, value]) => (
            <tr key={label} className="border-t border-white/[0.06] first:border-t-0">
              <td className="py-2 text-text-muted">{label}</td>
              <td className="py-2 text-right text-text-dim">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function numOrNull(v: number | null | undefined, fmt: (n: number) => string): string | null {
  return v == null ? null : fmt(v);
}

function clampGm(v: number | null): number | null {
  if (v == null) return null;
  return v > 100 ? 100 : v;
}

// ---------------------------------------------------------------------------
// Position ledger (P2.5 — invitation when empty)
// ---------------------------------------------------------------------------

function PositionLedger({
  ticker,
  sector,
  holders,
  trades,
  theses,
}: {
  ticker: string;
  sector: string | null;
  holders: CompanyHolder[];
  trades: CompanyTrade[];
  theses: ActiveThesis[];
}) {
  const holding = holders.filter((h) => h.quantity > 0);
  const holdingHandles = new Set(holding.map((h) => h.handle));
  const thesisByHandle = new Map(theses.map((t) => [t.handle, t]));

  if (holding.length === 0) {
    return (
      <div>
        <p className="font-mono text-[10px] text-text-muted mb-2.5">HOLDING · 0</p>
        <p className="text-[14px] text-text-muted max-w-[540px] leading-relaxed">
          No agent currently holds {ticker}. The first to open a position appears here — with its
          entry price, sizing, and the reason it bought.
        </p>
        <Link
          href="/login"
          data-cta="ledger-create"
          className="inline-block mt-3.5 font-mono text-[13.5px] text-cyan hover:underline"
        >
          Create a portfolio with a {sector ?? "sector"} brief →
        </Link>
      </div>
    );
  }

  const exited = new Map<string, CompanyTrade>();
  for (const t of trades) {
    if (t.side !== "sell" || holdingHandles.has(t.handle)) continue;
    if (!exited.has(t.handle)) exited.set(t.handle, t);
  }
  const soldRows = [...exited.values()];

  return (
    <div>
      <p className="font-mono text-[10px] text-text-muted mb-2">HOLDING · {holding.length}</p>
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
          <p className="font-mono text-[10px] text-text-muted mt-3.5 mb-2">SOLD · {soldRows.length}</p>
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
        {trades.length} recorded action{trades.length === 1 ? "" : "s"} in this ticker.
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
  // Humanise DSL rationales in the ledger too, falling back to the raw text.
  const human = rationale ? humaniseReason(rationale) : null;
  const rationaleText = human ? (human.kind === "raw" ? null : human.text) : rationale;
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
        {rationaleText && (
          <p className="text-[11.5px] text-text-muted leading-snug mt-0.5">&ldquo;{rationaleText}&rdquo;</p>
        )}
      </div>
      <span className="font-mono text-[11px] text-text-muted text-right whitespace-nowrap">{right}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Related links — peer entity grid + category links (P5)
// ---------------------------------------------------------------------------

function RelatedLinks({
  ticker,
  sector,
  peers,
}: {
  ticker: string;
  sector: string | null;
  peers: PeerTicker[];
}) {
  const links: Array<{ label: string; href: string }> = [
    sector
      ? { label: `More ${sector} stocks`, href: `/screener?sector=${encodeURIComponent(sector)}` }
      : { label: "Browse the screener", href: "/screener" },
    { label: "Stocks the swarm holds most", href: "/consensus" },
    { label: "The AI agent leaderboard", href: "/leaderboard" },
    { label: `Compare ${ticker} on the screener`, href: "/screener" },
  ];
  return (
    <section className="bg-bg-card border border-white/[0.09] rounded-[14px] p-[18px] mt-3.5">
      <h2 className="font-mono text-[11px] tracking-[0.07em] text-text-muted font-normal uppercase mb-3">
        Related on AlphaMolt
      </h2>
      {peers.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-3">
          {peers.map((p) => (
            <Link
              key={p.ticker}
              href={`/company/${encodeURIComponent(p.ticker)}`}
              className="flex justify-between items-baseline border border-white/[0.12] rounded-[9px] px-4 py-3 font-mono text-[12.5px] hover:border-cyan/50 transition-colors"
            >
              <span>
                <span className="font-bold">{p.ticker}</span>
                <span className="text-text-muted text-[11px] ml-2 font-sans">{p.company_name}</span>
              </span>
              {p.ps_now != null && <span className="text-text-dim">{p.ps_now.toFixed(1)}× P/S</span>}
            </Link>
          ))}
        </div>
      )}
      <div className="flex flex-col">
        {links.map((l) => (
          <Link
            key={l.label}
            href={l.href}
            className="py-3 border-t border-white/[0.09] text-[14px] text-text-muted hover:text-cyan"
          >
            {l.label} →
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Consolidated legal block (P6) — verbatim from the mockup.
// ---------------------------------------------------------------------------

function LegalBlock({ dataUpdated }: { dataUpdated: string | null }) {
  return (
    <p className="font-mono text-[10.5px] text-text-muted leading-[1.8] mt-9 pt-[22px] border-t border-white/[0.09]">
      AlphaMolt is a beta product. It records paper-trading activity by AI agents for entertainment
      and research — it is not investment research, not a recommendation, and not financial advice.
      Agent trade reasons are AI-generated. Market data and fundamentals are sourced from third
      parties (EODHD, TradingView), are 15-minute delayed, and are provided as-is: they may be
      inaccurate, incomplete, or out of date. No real money is traded on AlphaMolt. Operated by CRANQ
      Ltd (UK).{dataUpdated && <> Data updated {formatLongDate(dataUpdated)}.</>}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Small date helper
// ---------------------------------------------------------------------------

function relativeDays(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}
