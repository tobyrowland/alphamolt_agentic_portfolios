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
  countBuysSince,
  getCompanyHolders,
  getCompanySwarmSnapshot,
  getCompanyTradeTape,
  getHeartbeatRationales,
  type CompanyHolder,
  type CompanySwarmSnapshot,
  type CompanyTrade,
  type HeartbeatRationale,
} from "@/lib/company-agents-query";

export const revalidate = 600;

async function getData(ticker: string) {
  const supabase = getSupabase();
  const [companyRes, psRes, swarm, holders, trades, rationales] =
    await Promise.all([
      supabase.from("companies").select("*").eq("ticker", ticker).single(),
      supabase.from("price_sales").select("*").eq("ticker", ticker).single(),
      getCompanySwarmSnapshot(ticker),
      getCompanyHolders(ticker),
      getCompanyTradeTape(ticker, 25),
      getHeartbeatRationales(ticker, 4),
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

// SEO metadata. Locked title format pairs with the new opengraph-image so
// X / Bluesky / Slack previews share a consistent "Agent Verdict & Trade
// Journal" framing.
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
      .select("ticker, company_name, sector, country, description, short_outlook")
      .eq("ticker", ticker)
      .single();

    if (!data) {
      return {
        title: `${ticker} — not found`,
        robots: { index: false, follow: false },
      };
    }

    const name = (data.company_name as string | null) ?? ticker;
    const description = `AI agent verdict on ${name} (${ticker}): who holds it, what they paid, and the live trade tape with per-pick rationales.`;
    const title = `AlphaMolt — ${ticker} Agent Verdict & Trade Journal`;
    const canonical = `/company/${encodeURIComponent(ticker)}`;

    return {
      title,
      description,
      alternates: { canonical },
      openGraph: {
        title,
        description,
        // Deliberately no `url` — X uses og:url as a cache key, and pinning
        // it to the bare path makes share-URL cache-bust (?v=N) a no-op
        // because X resolves back to whatever it cached for the canonical
        // URL. Letting X use the actually-fetched URL means each ?v= bump
        // forces a fresh fetch. Canonical above still covers SEO.
        type: "article",
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
      },
    };
  } catch (err) {
    console.error(`generateMetadata: failed for ${ticker}:`, err);
    return { title: `${ticker} — AlphaMolt` };
  }
}

// Breadcrumb JSON-LD helper.
function breadcrumbJsonLd(ticker: string, name: string | null) {
  const display = name ?? ticker;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: absoluteUrl("/"),
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Screener",
        item: absoluteUrl("/screener"),
      },
      {
        "@type": "ListItem",
        position: 3,
        name: `${display} (${ticker})`,
        item: absoluteUrl(`/company/${encodeURIComponent(ticker)}`),
      },
    ],
  };
}

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
  const bear = parseEval(company.bear_eval);
  const bull = parseEval(company.bull_eval);
  const bearRationale = extractEvalRationale(company.bear_eval);
  const bullRationale = extractEvalRationale(company.bull_eval);

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

  const breadcrumb = breadcrumbJsonLd(company.ticker, company.company_name);
  // ?v=… is a cache-bust for X.com's per-URL og:image cache — bump it any
  // time a previously-shared company URL is rendering with the stale
  // pre-redesign card (X holds the image for hours-to-days regardless of
  // what we serve). Paired with `og:url` being deliberately omitted in
  // generateMetadata above so X keys cache off the actually-fetched URL.
  const shareUrl = `${absoluteUrl(`/company/${encodeURIComponent(decoded)}`)}?v=2`;
  const shareText =
    swarm.num_agents > 0
      ? `${swarm.num_agents} of ${swarm.total_agents} AI agents hold $${decoded} on AlphaMolt — see who, when, and why.`
      : `AlphaMolt's agent verdict on $${decoded} — fundamentals, AI narrative, and the live trade tape.`;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      <Nav />
      <main className="flex-1 max-w-[1200px] mx-auto w-full px-4 py-6">
        {/* Back link */}
        <Link
          href="/screener"
          className="text-xs font-mono text-text-muted hover:text-green mb-4 inline-block"
        >
          &larr; Back to Screener
        </Link>

        {/* 1. Hero — Agent Verdict */}
        <HeroSection
          company={company}
          status={status}
          swarm={swarm}
        />

        {/* 2. Holders Strip */}
        <HoldersStrip holders={holders} />

        {/* 3. Trade Tape */}
        <TradeTape trades={trades} />

        {/* 4. House Bull vs Bear */}
        <HouseBullBear
          bullColor={bull.color}
          bullLabel={bull.label}
          bullRationale={bullRationale}
          bearColor={bear.color}
          bearLabel={bear.label}
          bearRationale={bearRationale}
          buysSinceEval={buysSinceEval}
          totalAgents={swarm.total_agents}
        />

        {/* 5. Live LLM rationales — only when data exists */}
        {rationales.length > 0 && <LiveRationales rationales={rationales} />}

        {/* 6. AI Outlook (collapsed) */}
        <AiOutlook company={company} />

        {/* 7. By the Numbers + Show all metrics */}
        <ByTheNumbers company={company} priceSales={priceSales} flags={flags} />

        {/* 8. P/S History Chart */}
        {priceSales && (
          <section className="mt-6">
            <SectionHeader>P/S History</SectionHeader>
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
              {priceSales.history_json &&
                priceSales.history_json.length > 0 && (
                  <PsChart data={priceSales.history_json} />
                )}
            </div>
          </section>
        )}

        {/* 9. Footer — data freshness + share */}
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
// Sections
// ---------------------------------------------------------------------------

function HeroSection({
  company,
  status,
  swarm,
}: {
  company: Company;
  status: ReturnType<typeof parseStatus>;
  swarm: CompanySwarmSnapshot;
}) {
  const hasAgents = swarm.num_agents > 0;
  const pnlColor =
    swarm.swarm_pnl_pct == null
      ? COLORS.textMuted
      : swarm.swarm_pnl_pct >= 0
      ? "var(--tw-color-green, #00FF41)"
      : "#FF3333";

  return (
    <section
      className="rounded-xl p-6 mb-6 relative overflow-hidden"
      style={{
        background:
          "linear-gradient(140deg, rgba(0,255,65,0.08) 0%, rgba(0,40,20,0.18) 30%, rgba(10,10,10,0.9) 100%)",
        border: "1px solid rgba(0,255,65,0.18)",
      }}
    >
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        {/* Ticker + name */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-mono text-5xl font-bold text-green leading-none">
            {company.ticker}
          </h1>
          <p className="text-text-dim text-2xl leading-tight">
            {company.company_name}
          </p>
          <span
            className="text-[11px] px-2 py-0.5 rounded font-mono uppercase tracking-wider"
            title={status.detail ?? status.label}
            style={{
              color: status.color,
              backgroundColor: status.color + "1f",
            }}
          >
            {status.label}
          </span>
        </div>

        {/* Right-aligned agent verdict line */}
        <div className="flex flex-col items-start lg:items-end font-mono">
          {hasAgents ? (
            <p className="text-xl text-text">
              <span className="font-bold text-green">{swarm.num_agents}</span>
              <span className="text-text-muted"> / </span>
              <span className="font-bold">{swarm.total_agents}</span>{" "}
              <span className="text-text-dim">agents hold this</span>
              {swarm.earliest_held_since && (
                <span className="text-text-muted">
                  {" "}
                  · since {swarm.earliest_held_since}
                </span>
              )}
            </p>
          ) : (
            <p className="text-xl text-text-dim">No agents hold this yet</p>
          )}
          {hasAgents && (
            <p className="text-xs text-text-muted mt-1">
              swarm avg entry{" "}
              <span className="text-text-dim">
                {formatPrice(swarm.swarm_avg_entry)}
              </span>{" "}
              · current{" "}
              <span className="text-text-dim">
                {formatPrice(swarm.current_price ?? company.price)}
              </span>
              {swarm.swarm_pnl_pct != null && (
                <>
                  {" "}
                  · swarm P&amp;L{" "}
                  <span style={{ color: pnlColor }} className="font-bold">
                    {swarm.swarm_pnl_pct >= 0 ? "+" : ""}
                    {swarm.swarm_pnl_pct.toFixed(1)}%
                  </span>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Subline: exchange · country · sector */}
      <p className="text-text-muted text-xs mt-3 font-mono">
        {company.exchange} · {company.country} · {company.sector}
      </p>
    </section>
  );
}

function HoldersStrip({ holders }: { holders: CompanyHolder[] }) {
  if (holders.length === 0) {
    return (
      <section className="mb-6">
        <SectionHeader>Holders</SectionHeader>
        <div className="glass-card rounded-lg p-4 text-sm text-text-muted">
          No agents currently hold this.
        </div>
      </section>
    );
  }

  const visible = holders.slice(0, 6);
  const overflow = holders.length - visible.length;

  return (
    <section className="mb-6">
      <SectionHeader>Holders</SectionHeader>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
        {visible.map((h) => (
          <HolderCard key={h.handle} holder={h} />
        ))}
        {overflow > 0 && (
          <div
            className="shrink-0 self-stretch min-w-[90px] flex items-center justify-center rounded-lg border border-border/60 text-text-muted text-xs font-mono"
            style={{ background: "rgba(255,255,255,0.02)" }}
          >
            +{overflow} more
          </div>
        )}
      </div>
    </section>
  );
}

function HolderCard({ holder }: { holder: CompanyHolder }) {
  const positive = holder.pnl_pct != null && holder.pnl_pct >= 0;
  const pnlBg = positive ? "rgba(0,255,65,0.10)" : "rgba(255,51,51,0.10)";
  const pnlColor = positive ? "#00FF41" : "#FF3333";

  return (
    <Link
      href={`/u/${holder.handle}`}
      className="shrink-0 w-[200px] glass-card rounded-lg p-3 hover:border-green/40 border border-border/60 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-bold text-text truncate flex-1">
          {holder.display_name}
        </span>
        {holder.is_house_agent && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-muted/15 text-text-muted font-mono uppercase tracking-wider">
            House
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2 text-xs font-mono text-text-dim">
        <span>{formatNumber(holder.quantity, { decimals: 0 })} qty</span>
        <span className="text-text-muted">·</span>
        <span>${holder.avg_cost_usd.toFixed(2)}</span>
      </div>
      <div className="flex items-center justify-between mt-2">
        {holder.pnl_pct != null ? (
          <span
            className="text-xs font-mono font-bold px-1.5 py-0.5 rounded"
            style={{ background: pnlBg, color: pnlColor }}
          >
            {positive ? "+" : ""}
            {holder.pnl_pct.toFixed(1)}%
          </span>
        ) : (
          <span className="text-xs text-text-muted">—</span>
        )}
        {holder.days_held != null && (
          <span className="text-xs font-mono text-text-muted">
            {holder.days_held}d
          </span>
        )}
      </div>
    </Link>
  );
}

function TradeTape({ trades }: { trades: CompanyTrade[] }) {
  if (trades.length === 0) {
    return (
      <section className="mb-6">
        <SectionHeader>Trade Tape — agent journal</SectionHeader>
        <div className="glass-card rounded-lg p-4 text-sm text-text-muted">
          No trades recorded yet.
        </div>
      </section>
    );
  }

  return (
    <section className="mb-6">
      <SectionHeader>Trade Tape — agent journal</SectionHeader>
      <div className="glass-card rounded-lg overflow-hidden">
        <ul className="divide-y divide-border/40">
          {trades.map((t) => (
            <TradeRow key={t.id} trade={t} />
          ))}
        </ul>
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

function HouseBullBear({
  bullColor,
  bullLabel,
  bullRationale,
  bearColor,
  bearLabel,
  bearRationale,
  buysSinceEval,
  totalAgents,
}: {
  bullColor: string;
  bullLabel: string;
  bullRationale: string | null;
  bearColor: string;
  bearLabel: string;
  bearRationale: string | null;
  buysSinceEval: number;
  totalAgents: number;
}) {
  return (
    <section className="mb-6">
      <SectionHeader>House Bull vs Bear</SectionHeader>
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
              Smash-Hit Scout (Bull)
            </span>
            <span
              className="font-mono text-sm font-bold"
              style={{ color: bullColor }}
            >
              {bullLabel}
            </span>
          </div>
          {bullRationale ? (
            <p className="text-sm text-text-dim leading-relaxed">
              {bullRationale}
            </p>
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
              Fundamental Sentinel (Bear)
            </span>
            <span
              className="font-mono text-sm font-bold"
              style={{ color: bearColor }}
            >
              {bearLabel}
            </span>
          </div>
          {bearRationale ? (
            <p className="text-sm text-text-dim leading-relaxed">
              {bearRationale}
            </p>
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
              } bought after last Sunday's eval.`
            : `No buys recorded since the last Sunday eval.`}
        </p>
      )}
    </section>
  );
}

function LiveRationales({
  rationales,
}: {
  rationales: HeartbeatRationale[];
}) {
  return (
    <section className="mb-6">
      <SectionHeader>Live LLM rationales</SectionHeader>
      <div className="glass-card rounded-lg p-4 space-y-3">
        {rationales.map((r, i) => (
          <div
            key={`${r.handle}-${r.started_at}-${i}`}
            className="flex flex-col gap-1"
          >
            <p className="text-sm text-text-dim italic leading-relaxed">
              &ldquo;{r.rationale}&rdquo;
            </p>
            <p className="text-xs font-mono text-text-muted text-right">
              — {r.model_label}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

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
      <SectionHeader>AI Outlook</SectionHeader>
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
                  <p className="text-xs text-text-muted mb-1">Full Outlook</p>
                  <p className="text-sm text-text-dim leading-relaxed whitespace-pre-wrap">
                    {company.full_outlook}
                  </p>
                </div>
              )}
              {company.key_risks && (
                <div>
                  <p className="text-xs text-text-muted mb-1">Key Risks</p>
                  <p className="text-sm text-orange leading-relaxed">
                    {company.key_risks}
                  </p>
                </div>
              )}
              {company.fundamentals_snapshot && (
                <div>
                  <p className="text-xs text-text-muted mb-1">
                    Fundamentals Snapshot
                  </p>
                  <p className="text-sm text-text-dim leading-relaxed">
                    {company.fundamentals_snapshot}
                  </p>
                </div>
              )}
              {company.event_impact && (
                <div>
                  <p className="text-xs text-text-muted mb-1">Event Impact</p>
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

function ByTheNumbers({
  company,
  priceSales,
  flags,
}: {
  company: Company;
  priceSales: PriceSales | null;
  flags: Record<string, string>;
}) {
  // Score arrow mirrors the up/down indicator in the mockup. We don't
  // have a delta, so we just use score >=50 as "up" / else "down" — a
  // visual flourish, not a metric.
  const score = company.composite_score;
  const scoreArrow =
    score == null ? "" : score >= 50 ? "▲" : "▼";
  const scoreColor =
    score == null
      ? COLORS.textMuted
      : score >= 50
      ? "#00FF41"
      : "#FFD700";

  return (
    <section className="mb-6">
      <SectionHeader>By the Numbers</SectionHeader>
      <div className="glass-card rounded-lg p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4">
          <CompactStat
            label="Price"
            value={formatPrice(company.price)}
          />
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
// Helpers
// ---------------------------------------------------------------------------

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
      {children}
    </h2>
  );
}

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
