import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import HoldingsList from "@/components/holdings-list";
import { TradeTape, type Trade } from "@/components/trade-tape";
import VisibilityToggle from "@/components/portfolio/visibility-toggle";
import RebalanceCadenceToggle from "@/components/portfolio/rebalance-cadence-toggle";
import SyncLiveButton from "@/components/portfolio/sync-live-button";
import TeamBuilder from "@/components/portfolio/team-builder";
import TeamScheduleNote from "@/components/portfolio/team-schedule-note";
import BetaDisclaimer from "@/components/beta-disclaimer";
import ActivityDrawer from "@/components/activity-drawer";
import SectorChip from "@/components/portfolio/sector-chip";
import PortfolioTabs from "@/components/portfolio/portfolio-tabs";
import {
  getPortfolio,
  getPortfolioByPortfolioId,
  type PortfolioSnapshot,
} from "@/lib/portfolio";
import {
  getHoldingsCountForPortfolio,
  getPortfolioBySlug,
  getPortfolioMode,
  getRecentTradesForPortfolio,
  type Portfolio,
} from "@/lib/portfolios-query";
import {
  getLibraryAgents,
  getTeamForPortfolio,
  fillSentence,
  type LibraryAgent,
  type TeamAgent,
} from "@/lib/agents/library";
import {
  getActiveThesesForAgent,
  getActiveThesesForPortfolio,
  type InvestmentThesis,
} from "@/lib/theses-query";
import {
  isViewerOwner,
  resolveVisiblePortfolio,
} from "@/lib/portfolio-visibility";

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
  team: TeamAgent[];
  /** The full agent library — owner-only (only the owner can build the team). */
  library: LibraryAgent[];
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
      team: [],
      library: [],
      thesesByTicker: {},
      trades: [],
      totalTrades: 0,
      holdingsCount: 0,
    };
  }
  const isOwner = await isViewerOwner(portfolio);
  const mode =
    isOwner && portfolio.owner_user_id
      ? await getPortfolioMode(portfolio.id, portfolio.owner_user_id)
      : "paper";

  const portfolioId = portfolio.id;
  const ownerAgentId = portfolio.owner_agent_id;
  const ownerUserId = portfolio.owner_user_id;

  const [
    snapshot,
    thesesByTicker,
    team,
    library,
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
            console.error("getPortfolioByPortfolioId failed for", slug, err);
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
    getTeamForPortfolio(portfolioId).catch(() => [] as TeamAgent[]),
    isOwner
      ? getLibraryAgents().catch(() => [] as LibraryAgent[])
      : Promise.resolve([] as LibraryAgent[]),
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
    team,
    library,
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
    team,
    library,
    thesesByTicker,
    trades,
    totalTrades,
    holdingsCount,
  } = await getPortfolioPageData(slug);
  if (!portfolio) notFound();

  const bookCount = snapshot?.holdings.length ?? holdingsCount;
  const unrealized =
    snapshot?.holdings.reduce((s, h) => s + (h.unrealized_pnl_usd ?? 0), 0) ??
    snapshot?.pnl_usd ??
    0;
  // Equity (positions at market) vs cash split, and the unrealized return on
  // account equity (= total paper value).
  const totalValue = snapshot?.total_value_usd ?? 0;
  const equityValue = snapshot?.holdings_value_usd ?? 0;
  const cashValue = snapshot?.cash_usd ?? 0;
  const equityPct = totalValue > 0 ? (equityValue / totalValue) * 100 : 0;
  const pnlPct = totalValue > 0 ? (unrealized / totalValue) * 100 : 0;

  // The book — summary, team, holdings, trades (the page as it's always
  // been). The owner of a paper book also gets a Universe tab linking to
  // /portfolios/<slug>/universe (the screener page for this book).
  const portfolioContent = (
    <>
      {/* SUMMARY — paper value, unrealized P&L, holdings, team (brief §5).
          Honest: no invented alpha. */}
      {snapshot && (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-6 sm:mb-8">
          <PaperValueCard
            total={totalValue}
            equity={equityValue}
            cash={cashValue}
            equityPct={equityPct}
          />
          <SummaryCard
            label="Unrealized P&L"
            value={`${unrealized >= 0 ? "+" : "-"}$${Math.abs(unrealized).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            tone={unrealized > 0 ? "positive" : unrealized < 0 ? "negative" : "neutral"}
            sub={`${unrealized >= 0 ? "+" : "-"}${Math.abs(pnlPct).toFixed(2)}% on equity`}
          />
          <SummaryCard
            label="Holdings"
            value={String(bookCount)}
            sub="open positions"
          />
          {/* The Team card is meaningless for a live follower (it runs no
              agents of its own — the paper sibling's swarm drives it). */}
          {mode !== "live" && (
            <SummaryCard
              label="Team"
              value={`${team.length} agent${team.length === 1 ? "" : "s"}`}
              sub={
                team.length === 0 ? (
                  "none yet"
                ) : (
                  <span className="text-[var(--color-green)]">
                    <TeamScheduleNote cadence={portfolio.rebalance_cadence} />
                  </span>
                )
              }
            />
          )}
        </section>
      )}

      {/* TEAM — the build + manage surface (owner) or a read-only roster
          (visitor). A live follower has no team of its own: it mirrors the
          paper portfolio's positions, so it shows an explainer instead. */}
      {mode === "live" ? (
        <LiveFollowerNote portfolioId={portfolio.id} isOwner={isOwner} />
      ) : isOwner ? (
        <section id="team" className="mb-12 sm:mb-14 scroll-mt-20">
          <TeamBuilder
            portfolioId={portfolio.id}
            team={team}
            library={library}
          />
        </section>
      ) : (
        <ReadOnlyTeam team={team} />
      )}

      {/* Holdings */}
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
      ) : (
        <section className="mb-12 sm:mb-14">
          <p className="text-sm text-text-muted italic">
            Your agents are placing their first trades — holdings will appear
            here once they do.
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
          emptyLabel="No trades yet — your agents are warming up."
        />
      </section>
    </>
  );

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          {/* Tabs — Portfolio (this page) | Universe (the book's screener).
              Owner of a paper book only. */}
          {isOwner && mode !== "live" && (
            <PortfolioTabs slug={portfolio.slug} active="portfolio" />
          )}

          {/* Header — identity + status (brief §5). */}
          <header className="mb-8">
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
              Portfolio
            </p>
            <div className="mt-2 flex items-baseline gap-3 flex-wrap">
              <h1 className="text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text">
                {isOwner ? "Your portfolio" : portfolio.display_name}
              </h1>
              <span className="text-sm font-mono text-text-muted">
                {bookCount} holding{bookCount === 1 ? "" : "s"}
                {isOwner && mode === "paper" ? " · paper" : ""}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {/* Activity log (clickthrough drawer) — visible to anyone viewing
                  the portfolio, so the work the team does in the background is
                  legible even on the quiet days when nothing changed. */}
              <ActivityDrawer
                label="Activity"
                title="Portfolio activity"
                subtitle="What your team did and when — including the runs where it decided to hold."
                endpoint={`/api/portfolios/${portfolio.slug}/activity`}
                storageKey={`alphamolt:activity:portfolio:${portfolio.id}`}
              />
              {/* Largest sector exposure — concentration risk at a glance. */}
              {snapshot && snapshot.holdings.length > 0 && (
                <SectorChip holdings={snapshot.holdings} />
              )}
              {/* A live portfolio is a private follower of the paper book — it
                  is always private (never publishable) and has no team of its
                  own, so it shows neither the public toggle nor team controls. */}
              {isOwner && mode !== "live" && (
                <VisibilityToggle
                  portfolioId={portfolio.id}
                  isPublic={portfolio.is_public}
                  holdingsCount={holdingsCount}
                />
              )}
              {isOwner && mode !== "live" && (
                <RebalanceCadenceToggle
                  portfolioId={portfolio.id}
                  cadence={portfolio.rebalance_cadence}
                />
              )}
              {/* Owner-only real-money marker (migration 036). */}
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
                  <BetaDisclaimer />
                </>
              )}
            </div>
          </header>

          {portfolioContent}

          {/* Footer */}
          <section className="pt-6 border-t border-white/10">
            {mode === "live" ? (
              <p className="text-xs text-text-muted font-mono">
                This is your private real-money account. It mirrors your paper
                portfolio&apos;s positions — manage the strategy and team on the
                paper portfolio, and this account follows automatically.
              </p>
            ) : (
              <p className="text-xs text-text-muted font-mono">
                This page shows your live portfolio — trades are made by your
                agents, not by hand. Manage your team above, or{" "}
                <Link
                  href="/docs#build-an-agent"
                  className="text-[var(--color-cyan)] hover:brightness-110 transition-[filter]"
                >
                  build your own agent
                </Link>{" "}
                in the docs.
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

// ----- Presentational helpers ---------------------------------------------

function SummaryCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: "positive" | "negative" | "neutral";
}) {
  const color =
    tone === "positive"
      ? "text-[var(--color-green)]"
      : tone === "negative"
        ? "text-[var(--color-red)]"
        : "text-text";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5">
      <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">
        {label}
      </p>
      <p className={`font-mono text-lg sm:text-xl font-bold tabular-nums ${color} mt-0.5`}>
        {value}
      </p>
      {sub && (
        <p className="text-[11px] font-mono text-text-muted mt-0.5">{sub}</p>
      )}
    </div>
  );
}

/**
 * Paper-value card with an equity/cash split bar (component mockup) — so the
 * owner can see how much capital is invested vs sitting in cash.
 */
function PaperValueCard({
  total,
  equity,
  cash,
  equityPct,
}: {
  total: number;
  equity: number;
  cash: number;
  equityPct: number;
}) {
  const pct = Math.max(0, Math.min(100, equityPct));
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5">
      <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">
        Paper value
      </p>
      <p className="font-mono text-lg sm:text-xl font-bold tabular-nums text-text mt-0.5">
        {formatUsd(total)}
      </p>
      <div
        className="mt-2 h-1.5 w-full rounded-full bg-white/10 overflow-hidden"
        role="img"
        aria-label={`${pct.toFixed(0)}% invested in equities, the rest in cash`}
      >
        <div
          className="h-full rounded-full bg-[var(--color-green)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] font-mono text-text-muted mt-1.5 leading-relaxed">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-[2px] bg-[var(--color-green)] mr-1 align-middle"
        />
        Equity <span className="text-text">{formatUsd0(equity)}</span>
        <span className="mx-1.5 text-text-dim">·</span>
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-[2px] bg-white/30 mr-1 align-middle"
        />
        Cash <span className="text-text">{formatUsd0(cash)}</span>
      </p>
    </div>
  );
}

// A live portfolio is a private follower of the owner's paper portfolio: it
// runs no agents of its own and is never public, so instead of the team
// builder it shows a short explainer of how it's driven.
function LiveFollowerNote({
  portfolioId,
  isOwner,
}: {
  portfolioId: string;
  isOwner: boolean;
}) {
  return (
    <section id="team" className="mb-12 sm:mb-14 scroll-mt-20">
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--color-green)] mb-3">
        Real-money follower
      </h2>
      <div className="rounded-2xl border border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.04] px-4 py-4">
        <p className="text-sm text-text-dim leading-relaxed">
          This account mirrors your{" "}
          <Link
            href="/account"
            className="text-[var(--color-cyan)] hover:brightness-110 transition-[filter]"
          >
            paper portfolio
          </Link>
          : it holds the same names in the same proportions, sized to its real
          balance. There&apos;s no separate team to build here — your paper
          portfolio&apos;s agents do the deciding, and this account follows
          automatically after each rebalance.
        </p>
        {/* Manual trigger: converge the Alpaca account onto the paper book now,
            rather than waiting for the scheduled mirror. Owner-only; the action
            re-verifies ownership + live mode server-side. */}
        {isOwner && <SyncLiveButton portfolioId={portfolioId} />}
      </div>
    </section>
  );
}

// Read-only roster for a public visitor — the team that operates this
// portfolio, no controls.
function ReadOnlyTeam({ team }: { team: TeamAgent[] }) {
  return (
    <section id="team" className="mb-12 sm:mb-14 scroll-mt-20">
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--color-green)] mb-3">
        Team ({team.length})
      </h2>
      {team.length === 0 ? (
        <p className="text-sm text-text-muted italic">
          No agents operate this portfolio yet.
        </p>
      ) : (
        // Tile grid — mirrors the owner's team builder and the hireable
        // library, so the logged-out roster reads the same way.
        <div className="grid gap-3 sm:grid-cols-2">
          {team.map((a) => (
            <div
              key={a.handle}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-3"
            >
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-bold text-text">{a.displayName}</span>
                {a.poweredBy && (
                  <span className="text-[11px] font-mono text-text-muted">
                    · {a.poweredBy}
                  </span>
                )}
                {!a.enabled && (
                  <span className="text-[11px] font-mono text-text-muted">
                    (stopped)
                  </span>
                )}
              </div>
              <p
                className="text-sm text-text-dim mt-1 leading-snug line-clamp-2"
                title={fillSentence(a, a.params)}
              >
                {fillSentence(a, a.params)}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
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

/** Whole-dollar USD, e.g. "$535,140" (used in the equity/cash legend). */
function formatUsd0(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}
