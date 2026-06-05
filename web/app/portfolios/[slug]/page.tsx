import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import HoldingsList from "@/components/holdings-list";
import { AgentMonogram } from "@/components/agent-monogram";
import { TradeTape, type Trade } from "@/components/trade-tape";
import VisibilityToggle from "@/components/portfolio/visibility-toggle";
import SwarmConfig, {
  type AgentCatalogEntry,
} from "@/components/portfolio/swarm-config";
import PortfolioSignpost from "@/components/portfolio/portfolio-signpost";
import {
  listPublicAgents,
  getAgentReturns30d,
  getAgentTradeStats,
} from "@/lib/agents-query";
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
import { b64urlEncode } from "@/lib/screen/config";

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
  /** Registry of hireable agents + 30d track record — owner-only (the swarm
   *  picker). Empty for non-owners. */
  catalog: AgentCatalogEntry[];
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
      catalog: [],
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

  // Agent catalog for the owner's swarm picker: every hireable agent + its 30d
  // track record. Owner-only — skipped entirely for non-owners.
  let catalog: AgentCatalogEntry[] = [];
  if (isOwner) {
    const [agents, returns] = await Promise.all([
      listPublicAgents(1000, true).catch(() => []),
      getAgentReturns30d().catch(() => new Map<string, number | null>()),
    ]);
    // Trade-tape stats (win %, 30d sells) keyed by agent id — a second pass so
    // we only query trades for the hireable set.
    const tradeStats = await getAgentTradeStats(
      agents.map((a) => a.id),
    ).catch(() => new Map());
    catalog = agents.map((a) => {
      const ts = tradeStats.get(a.id);
      return {
        handle: a.handle,
        displayName: a.display_name,
        poweredBy: a.powered_by,
        isHouse: a.is_house_agent,
        strategy: a.strategy,
        return30d: returns.get(a.handle) ?? null,
        winPct: ts?.winPct ?? null,
        sells30d: ts?.sells30d ?? 0,
      };
    });
  }

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
    catalog,
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
    catalog,
  } = await getPortfolioPageData(slug);
  if (!portfolio) notFound();

  const created = new Date(portfolio.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  // The page-top signpost only makes sense for the human-owned (shared-pot)
  // portfolios that actually run a swarm; legacy 1:1 agent portfolios skip it.
  const isSwarmPortfolio = portfolio.owner_user_id !== null;
  const bookCount = snapshot?.holdings.length ?? holdingsCount;
  const candidateCount =
    typeof portfolio.screen_config?.topN === "number"
      ? (portfolio.screen_config.topN as number)
      : 40;
  // SCREEN node links to this portfolio's own compiled screen (same encoding
  // as SwarmConfig's "→ your screen" link), or the bare screener as fallback.
  const screenHref = portfolio.screen_config
    ? `/screener?config=${b64urlEncode(JSON.stringify(portfolio.screen_config))}`
    : "/screener";

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          {/* Header — identity + status on the left, performance at a glance on
              the right (brief §1: perf belongs in the header, not stranded below
              the config). */}
          <header className="mb-10 sm:mb-12 flex flex-wrap items-start justify-between gap-4">
            <div>
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
            </div>

            {/* Performance strip — value, P/L %, holdings at a glance. */}
            {snapshot && (
              <div className="flex gap-5 sm:gap-7 text-right">
                <HeaderStat label="Value" value={formatUsd(snapshot.total_value_usd)} />
                <HeaderStat
                  label="P/L"
                  value={`${snapshot.pnl_pct >= 0 ? "+" : ""}${snapshot.pnl_pct.toFixed(2)}%`}
                  tone={snapshot.pnl_pct > 0 ? "positive" : snapshot.pnl_pct < 0 ? "negative" : "neutral"}
                />
                <HeaderStat label="Holdings" value={String(bookCount)} />
              </div>
            )}
          </header>

          {/* Page-top wayfinder: slim, balanced two-node signpost mirroring the
              screener (Screen → top N → this portfolio). No nested loop — the
              swarm engine loop lives lower, above the roster. */}
          {isSwarmPortfolio && (
            <PortfolioSignpost candidates={candidateCount} screenHref={screenHref} />
          )}

          {/* Config-in-place for the owner (portfolio brief): mandate +
              building blocks + the swarm roster + draft toggle. Non-owners see
              the read-only mandate + agents below. */}
          {isOwner ? (
            <section id="roster" className="mb-12 sm:mb-14 scroll-mt-20">
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
                  strategy: m.strategy,
                  role: m.role,
                  remit: m.remit,
                  config: m.config,
                }))}
                catalog={catalog}
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
          <section id="roster" className="mb-12 sm:mb-14 scroll-mt-20">
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

          {/* Holdings — the perf summary now lives in the header (brief §1), so
              this section is just the book itself. */}
          {snapshot ? (
            <section id="holdings" className="mb-12 sm:mb-14 scroll-mt-20">
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

// Compact at-a-glance stat for the header perf strip (brief §1).
function HeaderStat({
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
    <div className="min-w-0">
      <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-dim">
        {label}
      </p>
      <p className={`font-mono text-base sm:text-lg font-bold tabular-nums ${color} mt-0.5`}>
        {value}
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
