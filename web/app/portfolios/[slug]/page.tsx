import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import HoldingsList from "@/components/holdings-list";
import { AgentMonogram } from "@/components/agent-monogram";
import { TradeTape, type Trade } from "@/components/trade-tape";
import VisibilityToggle from "@/components/portfolio/visibility-toggle";
import SwarmConfig from "@/components/portfolio/swarm-config";
import BetaDisclaimer from "@/components/beta-disclaimer";
import {
  getPortfolio,
  getPortfolioByPortfolioId,
  type PortfolioSnapshot,
} from "@/lib/portfolio";
import {
  getHoldingsCountForPortfolio,
  getMembersForPortfolio,
  getPortfolioBySlug,
  getPortfolioMode,
  getRecentTradesForPortfolio,
  type Portfolio,
  type PortfolioMember,
} from "@/lib/portfolios-query";
import {
  getActiveThesesForAgent,
  getActiveThesesForPortfolio,
  type InvestmentThesis,
} from "@/lib/theses-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const revalidate = 300;

interface PageParams {
  params: Promise<{ slug: string }>;
}

/**
 * Fetch a portfolio by slug, applying the migration-024 visibility gate: a
 * private portfolio is visible only to its owner (the signed-in human).
 * Returns null when the portfolio is missing or hidden from the viewer. The
 * session read happens only on the private branch, so public portfolios stay
 * statically cacheable.
 */
async function resolveVisiblePortfolio(
  slug: string,
): Promise<Portfolio | null> {
  const portfolio = await getPortfolioBySlug(slug);
  if (!portfolio) return null;
  if (portfolio.is_public) return portfolio;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user && portfolio.owner_user_id && user.id === portfolio.owner_user_id) {
    return portfolio;
  }
  return null;
}

/**
 * Did the current viewer create this portfolio? Used to gate owner-only
 * controls (visibility toggle, future settings). Always returns false for
 * agent-owned legacy portfolios since they have no human owner.
 */
async function isViewerOwner(portfolio: Portfolio): Promise<boolean> {
  if (!portfolio.owner_user_id) return false;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return !!user && user.id === portfolio.owner_user_id;
}

// ----- Metadata ------------------------------------------------------------

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug).toLowerCase();

  const portfolio = await resolveVisiblePortfolio(slug);
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
  isOwner: boolean;
  /** Owner-only (migration 036). Always "paper" for non-owners — never leaked. */
  mode: "paper" | "live";
  snapshot: PortfolioSnapshot | null;
  members: PortfolioMember[];
  thesesByTicker: Record<string, InvestmentThesis>;
  trades: Trade[];
  totalTrades: number;
  holdingsCount: number;
}> {
  const portfolio = await resolveVisiblePortfolio(slug);
  if (!portfolio) {
    return {
      portfolio: null,
      isOwner: false,
      mode: "paper",
      snapshot: null,
      members: [],
      thesesByTicker: {},
      trades: [],
      totalTrades: 0,
      holdingsCount: 0,
    };
  }
  const isOwner = await isViewerOwner(portfolio);
  // `mode` is owner-only: only read (and only ever render) it for the owner,
  // so the real-money flag never reaches another viewer's browser.
  const mode =
    isOwner && portfolio.owner_user_id
      ? await getPortfolioMode(portfolio.id, portfolio.owner_user_id)
      : "paper";

  // Two snapshot paths: legacy 1:1 agent portfolios are keyed on agent_id
  // (the agent_accounts / agent_holdings tables); human-owned portfolios
  // (migration 024) are keyed on portfolio_id (portfolio_accounts /
  // portfolio_holdings, the shared-pot trading model from 025). The page
  // renders the same way for both — only the loader differs.
  //
  // Fan out the five independent reads with Promise.all. Previously
  // each await blocked the next, serialising 5x round-trips for what's
  // really one page render.
  const portfolioId = portfolio.id;
  const ownerAgentId = portfolio.owner_agent_id;
  const ownerUserId = portfolio.owner_user_id;
  const [
    snapshot,
    thesesByTicker,
    members,
    recent,
    holdingsCount,
  ] = await Promise.all([
    ownerAgentId
      ? getPortfolio(ownerAgentId).catch((err) => {
          console.error("getPortfolio failed for", slug, err);
          return null as PortfolioSnapshot | null;
        })
      : ownerUserId
        ? getPortfolioByPortfolioId(portfolioId).catch((err) => {
            console.error(
              "getPortfolioByPortfolioId failed for",
              slug,
              err,
            );
            return null as PortfolioSnapshot | null;
          })
        : Promise.resolve(null as PortfolioSnapshot | null),
    ownerAgentId
      ? getActiveThesesForAgent(ownerAgentId).catch(
          () => ({}) as Record<string, InvestmentThesis>,
        )
      : ownerUserId
        ? getActiveThesesForPortfolio(portfolioId).catch(
            () => ({}) as Record<string, InvestmentThesis>,
          )
        : Promise.resolve({} as Record<string, InvestmentThesis>),
    getMembersForPortfolio(portfolioId).catch(() => []),
    getRecentTradesForPortfolio(portfolioId).catch(
      () => ({ trades: [], totalTrades: 0 }),
    ),
    getHoldingsCountForPortfolio(portfolioId).catch(() => 0),
  ]);
  const { trades, totalTrades } = recent;

  return {
    portfolio,
    isOwner,
    mode,
    snapshot,
    members,
    thesesByTicker,
    trades,
    totalTrades,
    holdingsCount,
  };
}

// ----- Page ---------------------------------------------------------------

export default async function PortfolioPage({ params }: PageParams) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug).toLowerCase();

  const {
    portfolio,
    isOwner,
    mode,
    snapshot,
    members,
    thesesByTicker,
    trades,
    totalTrades,
    holdingsCount,
  } = await getPortfolioPageData(slug);
  if (!portfolio) notFound();

  const created = new Date(portfolio.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          {/* Header */}
          <header className="mb-10 sm:mb-12">
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
              Portfolio
            </p>
            <div className="mt-2 flex items-baseline gap-3 flex-wrap">
              <h1 className="text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text">
                {portfolio.display_name}
              </h1>
              <code className="text-sm font-mono text-text-muted">
                /{portfolio.slug}
              </code>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
                Created {created}
              </p>
              {isOwner && (
                <VisibilityToggle
                  portfolioId={portfolio.id}
                  isPublic={portfolio.is_public}
                  holdingsCount={holdingsCount}
                />
              )}
              {/* Owner-only real-money marker (migration 036). Rendered only
                  when the viewer is the owner AND mode is live, so the flag
                  never reaches another viewer. To everyone else this
                  portfolio is indistinguishable from a paper one. */}
              {isOwner && mode === "live" && (
                <>
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-green)]/40 bg-[var(--color-green)]/[0.08] px-2.5 py-1 text-[11px] font-mono font-bold uppercase tracking-[0.12em] text-[var(--color-green)]"
                    title="This portfolio is backed by a real Alpaca account. Only you can see this."
                  >
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 rounded-full bg-[var(--color-green)] animate-pulse"
                      style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
                    />
                    Live · real money
                  </span>
                  {/* Risk acknowledgement — only on this owner-only live surface. */}
                  <BetaDisclaimer />
                </>
              )}
            </div>
          </header>

          {/* Config-in-place for the owner (portfolio brief): mandate +
              building blocks + the swarm roster + draft toggle. Non-owners see
              the read-only mandate + agents below. */}
          {isOwner ? (
            <section className="mb-12 sm:mb-14">
              <SwarmConfig
                portfolioId={portfolio.id}
                slug={portfolio.slug}
                name={portfolio.display_name}
                mandate={portfolio.description ?? ""}
                members={members.map((m) => ({
                  agent_id: m.agent_id,
                  handle: m.handle,
                  display_name: m.display_name,
                  powered_by: m.powered_by,
                  role: m.role,
                  remit: m.remit,
                  config: m.config,
                }))}
                screenConfig={portfolio.screen_config}
                draftEnabled={!!portfolio.draft_config}
              />
            </section>
          ) : (
          <>
          {/* Mandate — the brief agents work to */}
          <section className="mb-12 sm:mb-14">
            <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-1.5">
              Mandate
            </h2>
            <p className="text-xs text-text-muted mb-3">
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
          <section className="mb-12 sm:mb-14">
            <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
              Agents ({members.length})
            </h2>
            {members.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {members.map((m) => (
                  <Link
                    key={m.agent_id}
                    href={`/agents/${encodeURIComponent(m.handle)}`}
                    className="group rounded-2xl border border-white/10 bg-white/[0.02] p-4 flex gap-4 hover:bg-white/[0.04] transition-colors"
                  >
                    <AgentMonogram
                      displayName={m.display_name}
                      handle={m.handle}
                      size={48}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-semibold text-text group-hover:text-[var(--color-cyan)] transition-colors truncate">
                          {m.display_name}
                        </span>
                        {m.is_house_agent && (
                          <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-[var(--color-orange)]">
                            House
                          </span>
                        )}
                      </div>
                      <p className="font-mono text-xs text-text-muted">
                        @{m.handle}
                      </p>
                      {m.powered_by && (
                        <span className="inline-block mt-1.5 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-text-dim">
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
          </>
          )}

          {/* Portfolio summary */}
          {snapshot ? (
            <section className="mb-12 sm:mb-14">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-6">
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

              <h3 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
                Holdings ({snapshot.holdings.length})
              </h3>
              <HoldingsList
                portfolioId={portfolio.id}
                holdings={snapshot.holdings}
                thesesByTicker={thesesByTicker}
                canSell={isOwner}
              />
              {snapshot.holdings.length > 0 && (
                <p className="mt-3 text-[11px] text-text-muted font-mono">
                  Click a row to see the investment thesis recorded at buy time.
                </p>
              )}
            </section>
          ) : portfolio.owner_agent_id === null ? (
            <section className="mb-12 sm:mb-14">
              <p className="text-sm text-text-muted italic">
                No account yet — the portfolio_accounts row should exist after
                migration 031. Re-run portfolio_valuation.py or report this.
              </p>
            </section>
          ) : (
            <section className="mb-12 sm:mb-14">
              <p className="text-sm text-text-muted italic">
                No account opened yet — this portfolio&apos;s first trade
                through{" "}
                <code className="text-text-dim">
                  POST /api/v1/portfolio/buy
                </code>{" "}
                will seed it with $1M paper cash.
              </p>
            </section>
          )}

          {/* Recent trades */}
          <section className="mb-12 sm:mb-14">
            <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
              Recent trades
            </h2>
            <TradeTape
              trades={trades}
              totalTrades={totalTrades}
              emptyLabel="No trades recorded for this portfolio yet."
            />
          </section>

          {/* Footer */}
          <section className="pt-6 border-t border-white/10">
            <p className="text-xs text-text-muted font-mono">
              This page is read-only — the portfolio is traded by its member
              agents, not from here. See the{" "}
              <Link
                href="/docs"
                className="text-[var(--color-cyan)] hover:brightness-110 transition-[filter]"
              >
                docs
              </Link>{" "}
              for how portfolios and agents work.
            </p>
          </section>
        </div>
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
      ? "text-[var(--color-green)]"
      : tone === "negative"
        ? "text-[var(--color-red)]"
        : "text-text";
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-3 sm:px-5 sm:py-4 min-w-0">
      <p
        className={`font-mono text-lg sm:text-2xl font-bold tabular-nums ${color} truncate`}
      >
        {value}
      </p>
      <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-dim mt-1 truncate">
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
