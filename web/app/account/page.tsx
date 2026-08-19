import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import Sparkline from "@/components/sparkline";
import BetaDisclaimer from "@/components/beta-disclaimer";
import BriefTeamForm from "@/components/portfolio/brief-team-form";
import NewPortfolioCard from "@/components/portfolio/new-portfolio-card";
import PulseSection from "@/components/dashboard/pulse-section";
import NeedsAttention, {
  type AttentionItem,
} from "@/components/dashboard/needs-attention";
import LiveAccountHub from "@/components/account/live-account-hub";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getLiveCashOverview,
  type LiveCashSummary,
} from "@/lib/live-cash-query";
import {
  getLiveActivity,
  EMPTY_LIVE_ACTIVITY,
  type LiveActivity,
} from "@/lib/live-activity-query";
import type { StrategyMeta } from "@/components/account/strategy-row";
import {
  getDashboardData,
  type DashPortfolio,
  type DashTrade,
  type DashValuePoint,
} from "@/lib/dashboard-query";
import { getHouseTicker, type HouseTick } from "@/lib/house-activity-query";
import { PRESETS, DEFAULT_PRESET } from "@/lib/screen/config";
import { MAX_PAPER_PORTFOLIOS } from "@/lib/portfolios-query";

export const metadata: Metadata = {
  // Private surface — never indexed, never in the sitemap (dashboard brief §6).
  title: "Portfolios — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const PUBLIC_THRESHOLD = 12;

/**
 * Dashboard — the pulse + map of the account (dashboard brief). Read + route:
 * every element reports state or links to the page that owns an action. NOTHING
 * here edits config — mandate / screen / agents / knobs all live on the
 * portfolio + screener pages. Onboarding (no portfolio) falls back to the
 * brief-first first-run screen (EmptyState).
 */
export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/account");

  let displayName = user.email?.split("@")[0] ?? "there";
  try {
    const { data } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .maybeSingle();
    if (data?.display_name) displayName = data.display_name;
  } catch {
    /* ignore — greeting falls back to the email local-part */
  }

  const { portfolios, livePortfolios, activity, spyValues } =
    await getDashboardData(user.id);

  // The live control hub's data — broker cash, unallocated, every sleeve's
  // allowance (sleeves — migration 083). Only fetched when a live portfolio
  // exists; fail-open so a broker hiccup never breaks the dashboard.
  const liveAccounts =
    livePortfolios.length > 0
      ? await getLiveCashOverview(user.id).catch((err) => {
          console.error("live cash overview failed:", err);
          return [];
        })
      : [];

  // What the live account has been doing: mirror dispatches/runs from the
  // run_logs journal + the fills they produced. Same fail-open contract — a
  // missing signal costs a line in the hub, never the dashboard.
  const liveActivity =
    livePortfolios.length > 0
      ? await getLiveActivity(livePortfolios.map((p) => p.id)).catch((err) => {
          console.error("live activity read failed:", err);
          return EMPTY_LIVE_ACTIVITY;
        })
      : EMPTY_LIVE_ACTIVITY;

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1100px] mx-auto w-full px-4 sm:px-6 py-8 sm:py-10">
          {portfolios.length === 0 && livePortfolios.length === 0 ? (
            <EmptyState displayName={displayName} />
          ) : (
            <Dashboard
              displayName={displayName}
              portfolios={portfolios}
              livePortfolios={livePortfolios}
              liveAccounts={liveAccounts}
              liveActivity={liveActivity}
              activity={activity}
              spyValues={spyValues}
            />
          )}
          {/* Live (real-money) risk acknowledgement — shown ONLY to users
              who have actually been provisioned a live portfolio in the DB,
              not to every signed-in visitor. A live follower exists only
              after an operator runs the go-live flow, so its presence is the
              gate. */}
          {livePortfolios.length > 0 && (
            <div className="mt-10">
              <BetaDisclaimer />
            </div>
          )}
        </div>
      </main>
    </>
  );
}

function Dashboard({
  displayName,
  portfolios,
  livePortfolios,
  liveAccounts,
  liveActivity,
  activity,
  spyValues,
}: {
  displayName: string;
  portfolios: DashPortfolio[];
  livePortfolios: DashPortfolio[];
  liveAccounts: LiveCashSummary[];
  liveActivity: LiveActivity;
  activity: DashTrade[];
  spyValues: DashValuePoint[];
}) {
  const best = [...portfolios].sort(
    (a, b) => (b.pnlPct ?? -1e9) - (a.pnlPct ?? -1e9),
  )[0];
  const items = buildAttention(portfolios, activity);

  return (
    <div className="space-y-8">
      {/* Header + standing line */}
      <header>
        <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
          Portfolios
        </p>
        <h1 className="mt-1 text-[26px] sm:text-[30px] font-bold tracking-[-0.02em] text-text">
          Hi {displayName}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Your agents trade while you&apos;re away. Here&apos;s how the swarm is
          doing, what it did, and what wants you.{" "}
          {best && (
            <>
              Best book:{" "}
              <span className={best.pnlPct != null && best.pnlPct < 0 ? "text-[var(--color-red,#FF3333)]" : "text-[var(--color-green,#00FF41)]"}>
                {best.name} {best.pnlPct == null ? "" : `${best.pnlPct >= 0 ? "+" : ""}${best.pnlPct.toFixed(1)}%`}
              </span>{" "}
              ·{" "}
              <Link href="/leaderboard" className="text-text-dim underline hover:text-text">
                see where you rank
              </Link>
            </>
          )}
        </p>
      </header>

      {/* Pulse */}
      <PulseSection portfolios={portfolios} spyValues={spyValues} />

      {/* Needs attention */}
      {items.length > 0 && <NeedsAttention items={items} />}

      {/* Portfolio cards */}
      <section aria-label="Your portfolios">
        <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
          Portfolios
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {portfolios.map((p) => (
            <PortfolioCard key={p.id} p={p} />
          ))}
          {portfolios.length < MAX_PAPER_PORTFOLIOS ? (
            <NewPortfolioCard
              count={portfolios.length}
              max={MAX_PAPER_PORTFOLIOS}
            />
          ) : (
            <div className="flex items-center justify-center rounded-xl border border-white/5 p-4 text-[11px] font-mono text-text-muted/70 min-h-[120px]">
              {MAX_PAPER_PORTFOLIOS} of {MAX_PAPER_PORTFOLIOS} portfolios
            </div>
          )}
        </div>
      </section>

      {/* Private real-money followers (migrations 037 + 083) — owner-only.
          ONE object per strategy: the hub's cards carry the value, P&L and
          controls that used to be split across a separate overview card and a
          table row, which made it hard to see where one strategy ended and the
          next began. Every live control lives HERE, not on the (read-only)
          live pages. */}
      {livePortfolios.length > 0 && (
        <section aria-label="Live account">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim">
              Live account
            </h2>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-green,#00FF41)]/40 bg-[var(--color-green,#00FF41)]/[0.08] px-2.5 py-1 text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-[var(--color-green,#00FF41)]"
              title="Backed by a real Alpaca account. Private — only you can see this."
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-[var(--color-green,#00FF41)] animate-pulse"
                style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
              />
              Private · real money
            </span>
          </div>
          <LiveAccountHub
            accounts={liveAccounts}
            paperOptions={portfolios.map((p) => ({ id: p.id, name: p.name }))}
            liveMeta={buildLiveMeta(livePortfolios)}
            activity={liveActivity}
          />
        </section>
      )}

      {/* Recent swarm activity */}
      <section aria-label="Recent swarm activity">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim">
            Recent swarm activity
          </h2>
          {best && (
            <Link
              href={`/portfolios/${best.slug}`}
              className="text-[11px] font-mono text-text-muted hover:text-text"
            >
              View all →
            </Link>
          )}
        </div>
        {activity.length > 0 ? (
          <ul className="divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.02]">
            {activity.slice(0, 12).map((t) => (
              <ActivityRow key={String(t.id)} t={t} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">
            No trades yet — your agents act on their next cadence.
          </p>
        )}
      </section>

      {/* Doors out */}
      <nav
        aria-label="Explore"
        className="flex flex-wrap gap-4 text-sm text-text-muted border-t border-white/10 pt-5"
      >
        <Link href="/screener" className="hover:text-text">
          Screeners →
        </Link>
        <Link href="/leaderboard" className="hover:text-text">
          Leaderboard →
        </Link>
        <Link href="/agents" className="hover:text-text">
          Agents →
        </Link>
      </nav>
    </div>
  );
}

function PortfolioCard({ p }: { p: DashPortfolio }) {
  const down = p.pnlPct != null && p.pnlPct < 0;
  const color = down ? "var(--color-red,#FF3333)" : "var(--color-green,#00FF41)";
  const status = p.isPublic
    ? "Public"
    : p.numPositions >= PUBLIC_THRESHOLD
      ? "Eligible"
      : "Private";
  return (
    <Link
      href={`/portfolios/${p.slug}`}
      className="block rounded-xl border border-white/10 bg-white/[0.02] p-4 hover:bg-white/[0.04] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-text truncate">{p.name}</span>
        <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-text-muted shrink-0">
          {status}
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-lg font-semibold text-text">
          {p.value == null ? "—" : `$${p.value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
        </span>
        <span className="text-sm font-mono" style={{ color }}>
          {p.pnlPct == null ? "" : `${p.pnlPct >= 0 ? "▲" : "▼"} ${Math.abs(p.pnlPct).toFixed(2)}%`}
        </span>
      </div>
      <div className="mt-2">
        <Sparkline
          data={p.series.map((pt, i) => ({ x: i, y: pt.pct }))}
          color={color}
        />
      </div>
      <div className="mt-1 text-[11px] text-text-muted">
        {p.numPositions} position{p.numPositions === 1 ? "" : "s"}
      </div>
    </Link>
  );
}

/**
 * Per-strategy extras for the live hub's cards. Deliberately NOT the value:
 * `DashPortfolio.value` is the daily `agent_portfolio_history` mark, while the
 * hub's split arithmetic works off live prices — showing both next to the same
 * target box would put two different "worth" figures on one card.
 */
function buildLiveMeta(
  livePortfolios: DashPortfolio[],
): Record<string, StrategyMeta> {
  const meta: Record<string, StrategyMeta> = {};
  for (const p of livePortfolios) {
    meta[p.id] = {
      pnlPct: p.pnlPct,
      numPositions: p.numPositions,
      followsName: p.followsName,
    };
  }
  return meta;
}

function ActivityRow({ t }: { t: DashTrade }) {
  const sell = t.side.toLowerCase() === "sell";
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <span
        className={`font-mono text-[10px] uppercase px-1.5 py-0.5 rounded shrink-0 ${
          sell
            ? "text-[var(--color-red,#FF3333)] border border-[var(--color-red,#FF3333)]/30"
            : "text-[var(--color-green,#00FF41)] border border-[var(--color-green,#00FF41)]/30"
        }`}
      >
        {sell ? "SELL" : "BUY"}
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-text">
          <Link href={`/company/${t.ticker}`} className="font-mono hover:text-[var(--color-green,#00FF41)]">
            {t.ticker}
          </Link>{" "}
          <span className="text-text-muted">
            ×{t.qty} @ ${t.price.toFixed(2)}
          </span>
        </span>
        {t.reason && (
          <p className="text-xs text-text-muted truncate">{t.reason}</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="text-[11px] text-text-muted">
          {t.agentName}
          {t.role ? ` · ${t.role}` : ""}
        </div>
        <Link
          href={`/portfolios/${t.portfolioSlug}`}
          className="text-[11px] font-mono text-text-muted hover:text-text"
        >
          {t.portfolioName}
        </Link>
      </div>
    </li>
  );
}

function buildAttention(
  portfolios: DashPortfolio[],
  activity: DashTrade[],
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // High: a recent thesis-break / forced sell.
  for (const t of activity) {
    if (
      t.side.toLowerCase() === "sell" &&
      t.reason &&
      /brok|thesis/i.test(t.reason)
    ) {
      items.push({
        id: `sell-${t.id}`,
        urgency: "high",
        text: `${t.ticker} sold on a broken thesis — review ${t.portfolioName}.`,
        href: `/portfolios/${t.portfolioSlug}`,
        actionLabel: "Review portfolio",
      });
    }
  }

  for (const p of portfolios) {
    const href = `/portfolios/${p.slug}`;
    // No "mandate not set" nag: since per-agent briefs (migration 046) the
    // portfolio description is an optional public blurb — agents trade to
    // their own briefs + the saved universe, so an empty one impairs nothing.
    if (!p.hasBuyer) {
      items.push({
        id: `buyer-${p.id}`,
        urgency: "med",
        text: `${p.name} has no buyer assigned.`,
        href,
        actionLabel: "Add a buyer",
      });
    }
    if (!p.hasReviewer) {
      items.push({
        id: `reviewer-${p.id}`,
        urgency: "med",
        text: `${p.name} has no reviewer assigned.`,
        href,
        actionLabel: "Add a reviewer",
      });
    }
    if (!p.isPublic && p.numPositions >= 8 && p.numPositions < PUBLIC_THRESHOLD) {
      items.push({
        id: `public-${p.id}`,
        urgency: "low",
        text: `${p.name} is ${PUBLIC_THRESHOLD - p.numPositions} holdings from going public.`,
        href,
        actionLabel: "View portfolio",
      });
    }
  }

  // Sparse: high first, capped.
  const order = { high: 0, med: 1, low: 2 } as const;
  return items.sort((a, b) => order[a.urgency] - order[b.urgency]).slice(0, 5);
}

/**
 * First-run screen (onboarding brief): brief a team that's standing by, don't
 * build a portfolio. One model statement, one ~80%-pre-filled "Brief your team"
 * card whose only required field is the mandate, and a live ticker of real
 * house activity beside it so a newcomer sees the product working. The ticker
 * is hidden entirely when the house board is quiet (never a fake board).
 */
async function EmptyState({ displayName }: { displayName: string }) {
  const ticks = await getHouseTicker(12);
  const presets = Object.values(PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
  }));
  const defaultName = `${displayName}'s Portfolio`;

  return (
    <div>
      <header className="max-w-[58ch]">
        <h1 className="text-[26px] sm:text-[32px] font-bold tracking-[-0.02em] text-text leading-[1.15]">
          Welcome, {displayName}
        </h1>
        <p className="mt-3 text-[15px] text-text border-l-2 border-[var(--color-green,#00FF41)] pl-3 leading-relaxed">
          Brief a team of AI agents. They trade your strategy on paper. The
          leaderboard ranks everyone by alpha vs SPY.
        </p>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_300px] items-start">
        <BriefTeamForm
          presets={presets}
          defaultPreset={DEFAULT_PRESET}
          defaultName={defaultName}
        />
        {ticks.length > 0 && <LiveTicker ticks={ticks} />}
      </div>
    </div>
  );
}

// Real recent house-agent trades — teaches the product in a line (brief §3).
// Only rendered when there's genuine activity to show.
function LiveTicker({ ticks }: { ticks: HouseTick[] }) {
  return (
    <aside className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2 mb-3">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-[var(--color-green,#00FF41)] animate-pulse"
          style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
        />
        <h2 className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim">
          Live · house agents
        </h2>
      </div>
      <ul className="space-y-2.5">
        {ticks.map((t) => {
          const sell = t.side.toLowerCase() === "sell";
          return (
            <li key={String(t.id)} className="text-[13px] leading-snug">
              <span className="text-text">{t.agentName}</span>{" "}
              <span
                className={
                  sell
                    ? "text-[var(--color-red,#FF3333)]"
                    : "text-[var(--color-green,#00FF41)]"
                }
              >
                {sell ? "sold" : "bought"}
              </span>{" "}
              <Link
                href={`/company/${t.ticker}`}
                className="font-mono text-text hover:text-[var(--color-green,#00FF41)]"
              >
                {t.ticker}
              </Link>
              <span className="text-text-muted"> · {ago(t.executedAt)}</span>
            </li>
          );
        })}
      </ul>
      <Link
        href="/leaderboard"
        className="mt-3 inline-block text-[11px] font-mono text-text-muted hover:text-text"
      >
        See the board →
      </Link>
    </aside>
  );
}

// Compact relative time ("2m", "3h", "5d") for the live ticker.
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
