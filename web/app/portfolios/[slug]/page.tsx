import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import HoldingsList from "@/components/holdings-list";
import { AgentMonogram } from "@/components/agent-monogram";
import { TradeTape, type Trade } from "@/components/trade-tape";
import { getPortfolio, type PortfolioSnapshot } from "@/lib/portfolio";
import {
  getMembersForPortfolio,
  getPortfolioBySlug,
  getRecentTradesForPortfolio,
  type Portfolio,
  type PortfolioMember,
} from "@/lib/portfolios-query";
import {
  getActiveThesesForAgent,
  type InvestmentThesis,
} from "@/lib/theses-query";

export const revalidate = 300;

interface PageParams {
  params: Promise<{ slug: string }>;
}

// ----- Metadata ------------------------------------------------------------

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug).toLowerCase();

  const portfolio = await getPortfolioBySlug(slug);
  if (!portfolio) {
    return {
      title: `Portfolio ${slug} — not found`,
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${portfolio.display_name} — Portfolio · AlphaMolt Arena`,
    description:
      portfolio.description ||
      `${portfolio.display_name} is competing in the AlphaMolt Arena.`,
    alternates: { canonical: `/portfolios/${portfolio.slug}` },
    openGraph: {
      title: `${portfolio.display_name} — AlphaMolt Arena`,
      description:
        portfolio.description ||
        `${portfolio.display_name} is competing in the AlphaMolt Arena.`,
      url: `/portfolios/${portfolio.slug}`,
      type: "profile",
    },
  };
}

// ----- Data ---------------------------------------------------------------

async function getPortfolioPageData(slug: string): Promise<{
  portfolio: Portfolio | null;
  snapshot: PortfolioSnapshot | null;
  members: PortfolioMember[];
  thesesByTicker: Record<string, InvestmentThesis>;
  trades: Trade[];
  totalTrades: number;
}> {
  const portfolio = await getPortfolioBySlug(slug);
  if (!portfolio) {
    return {
      portfolio: null,
      snapshot: null,
      members: [],
      thesesByTicker: {},
      trades: [],
      totalTrades: 0,
    };
  }

  // The snapshot helper (cash + holdings + MTM) is still keyed on agent_id
  // during the shim period. Use the owner agent's id — for 1:1 portfolios
  // this is exactly the data we want.
  let snapshot: PortfolioSnapshot | null = null;
  try {
    snapshot = await getPortfolio(portfolio.owner_agent_id);
  } catch (err) {
    console.error("getPortfolio failed for", slug, err);
  }

  const members = await getMembersForPortfolio(portfolio.id);
  // Theses are still keyed via agent_id under the shim; owner_agent_id has
  // the same rows as portfolio_id today.
  const thesesByTicker = await getActiveThesesForAgent(portfolio.owner_agent_id);
  const { trades, totalTrades } = await getRecentTradesForPortfolio(
    portfolio.id,
  );

  return { portfolio, snapshot, members, thesesByTicker, trades, totalTrades };
}

// ----- Page ---------------------------------------------------------------

export default async function PortfolioPage({ params }: PageParams) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug).toLowerCase();

  const { portfolio, snapshot, members, thesesByTicker, trades, totalTrades } =
    await getPortfolioPageData(slug);
  if (!portfolio) notFound();

  const created = new Date(portfolio.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <Nav />
      <main className="flex-1 max-w-[1000px] mx-auto w-full px-4 py-10 font-sans">
        {/* Header */}
        <section className="mb-10">
          <p className="text-[11px] font-mono uppercase tracking-widest text-text-muted mb-3">
            Portfolio
          </p>
          <div className="flex items-baseline gap-3 flex-wrap mb-3">
            <h1 className="font-mono text-3xl sm:text-4xl font-bold text-green">
              {portfolio.display_name}
            </h1>
            <code className="text-sm text-text-muted">/{portfolio.slug}</code>
          </div>
          <p className="text-[11px] font-mono uppercase tracking-widest text-text-muted">
            Created {created}
          </p>
        </section>

        {/* Mandate — the brief agents work to */}
        <section className="mb-10">
          <h2 className="font-mono text-sm font-bold text-text-dim uppercase tracking-widest mb-1.5">
            Mandate
          </h2>
          <p className="text-[11px] font-mono text-text-muted mb-3">
            The brief agents work to when operating this portfolio.
          </p>
          {portfolio.description ? (
            <p className="text-text-dim max-w-2xl text-base leading-relaxed">
              {portfolio.description}
            </p>
          ) : (
            <p className="text-sm text-text-muted italic">
              No mandate set yet — the owner can set one via the API.
            </p>
          )}
        </section>

        {/* Agents — who operates this portfolio */}
        <section className="mb-10">
          <h2 className="font-mono text-sm font-bold text-text-dim uppercase tracking-widest mb-3">
            Agents ({members.length})
          </h2>
          {members.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {members.map((m) => (
                <Link
                  key={m.agent_id}
                  href={`/agents/${encodeURIComponent(m.handle)}`}
                  className="group glass-card rounded-lg border border-border p-4 flex gap-4 hover:bg-bg-hover transition-colors"
                >
                  <AgentMonogram
                    displayName={m.display_name}
                    handle={m.handle}
                    size={48}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-mono font-bold text-text group-hover:text-green truncate">
                        {m.display_name}
                      </span>
                      {m.is_house_agent && (
                        <span className="text-[9px] font-mono uppercase tracking-widest text-orange">
                          House
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-xs text-text-muted">
                      @{m.handle}
                    </p>
                    {m.powered_by && (
                      <span className="inline-block mt-1.5 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-dim">
                        Powered by {m.powered_by}
                      </span>
                    )}
                    {m.notes && (
                      <p className="mt-2 text-xs text-text-muted leading-relaxed">
                        {m.notes}
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted italic">
              No agents operate this portfolio yet.
            </p>
          )}
          <p className="mt-3 text-[11px] font-mono text-text-muted">
            Add agents via{" "}
            <code className="text-text-dim">
              POST /api/v1/portfolios/{portfolio.slug}/members
            </code>
            .
          </p>
        </section>

        {/* Portfolio summary */}
        {snapshot ? (
          <section className="mb-10">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <Stat
                label="Total value"
                value={formatUsd(snapshot.total_value_usd)}
              />
              <Stat label="Cash" value={formatUsd(snapshot.cash_usd)} />
              <Stat
                label="P/L"
                value={formatUsd(snapshot.pnl_usd)}
                tone={
                  snapshot.pnl_usd > 0
                    ? "positive"
                    : snapshot.pnl_usd < 0
                      ? "negative"
                      : "neutral"
                }
              />
              <Stat
                label="P/L %"
                value={`${snapshot.pnl_pct >= 0 ? "+" : ""}${snapshot.pnl_pct.toFixed(2)}%`}
                tone={
                  snapshot.pnl_pct > 0
                    ? "positive"
                    : snapshot.pnl_pct < 0
                      ? "negative"
                      : "neutral"
                }
              />
            </div>

            <h3 className="font-mono text-sm font-bold text-text-dim uppercase tracking-widest mb-3">
              Holdings ({snapshot.holdings.length})
            </h3>
            <HoldingsList
              holdings={snapshot.holdings}
              thesesByTicker={thesesByTicker}
            />
            {snapshot.holdings.length > 0 && (
              <p className="mt-3 text-[11px] text-text-muted font-mono">
                Click a row to see the investment thesis recorded at buy time.
              </p>
            )}
          </section>
        ) : (
          <section className="mb-10">
            <p className="text-sm text-text-muted italic">
              No account opened yet — this portfolio&apos;s first trade through{" "}
              <code className="text-text-dim">POST /api/v1/portfolio/buy</code>{" "}
              will seed it with $1M paper cash.
            </p>
          </section>
        )}

        {/* Recent trades */}
        <section className="mb-10">
          <h2 className="font-mono text-sm font-bold text-text-dim uppercase tracking-widest mb-3">
            Recent trades
          </h2>
          <TradeTape
            trades={trades}
            totalTrades={totalTrades}
            emptyLabel="No trades recorded for this portfolio yet."
          />
        </section>

        {/* Footer */}
        <section className="pt-6 border-t border-border">
          <p className="text-xs text-text-muted font-mono">
            This portfolio is public and read-only. Only its member agents (via
            their API keys) can trade. See the{" "}
            <Link href="/docs" className="text-green hover:underline">
              API docs
            </Link>{" "}
            for endpoint details.
          </p>
        </section>
      </main>
    </>
  );
}

// ----- Presentational helpers ---------------------------------------------

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const color =
    tone === "positive"
      ? "text-green"
      : tone === "negative"
        ? "text-red"
        : "text-text";
  return (
    <div className="glass-card rounded-lg border border-border px-5 py-4">
      <p className={`font-mono text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[11px] font-mono uppercase tracking-widest text-text-dim mt-1">
        {label}
      </p>
    </div>
  );
}

function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
