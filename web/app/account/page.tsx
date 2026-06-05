import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import Sparkline from "@/components/sparkline";
import BetaDisclaimer from "@/components/beta-disclaimer";
import BriefTeamForm from "@/components/portfolio/brief-team-form";
import PulseSection from "@/components/dashboard/pulse-section";
import NeedsAttention, {
  type AttentionItem,
} from "@/components/dashboard/needs-attention";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getDashboardData, type DashPortfolio, type DashTrade } from "@/lib/dashboard-query";
import { getHouseTicker, type HouseTick } from "@/lib/house-activity-query";
import { PRESETS, DEFAULT_PRESET } from "@/lib/screen/config";

export const metadata: Metadata = {
  // Private surface — never indexed, never in the sitemap (dashboard brief §6).
  title: "Dashboard — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const PUBLIC_THRESHOLD = 15;

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

  const { portfolios, livePortfolio, activity, spySeries } =
    await getDashboardData(user.id);

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1100px] mx-auto w-full px-4 sm:px-6 py-8 sm:py-10">
          {portfolios.length === 0 && !livePortfolio ? (
            <EmptyState displayName={displayName} />
          ) : (
            <Dashboard
              displayName={displayName}
              portfolios={portfolios}
              livePortfolio={livePortfolio}
              activity={activity}
              spySeries={spySeries}
            />
          )}
          {/* Live (real-money) risk acknowledgement — shown ONLY to users
              who have actually been provisioned a live portfolio in the DB,
              not to every signed-in visitor. A live follower exists only
              after an operator runs the go-live flow, so its presence is the
              gate. */}
          {livePortfolio && (
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
  livePortfolio,
  activity,
  spySeries,
}: {
  displayName: string;
  portfolios: DashPortfolio[];
  livePortfolio: DashPortfolio | null;
  activity: DashTrade[];
  spySeries: { date: string; pct: number }[];
}) {
  const best = [...portfolios].sort(
    (a, b) => (b.pnlPct ?? -1e9) - (a.pnlPct ?? -1e9),
  )[0];
  const items = buildAttention(portfolios, activity);

  return (
    <div className="space-y-8">
      {/* Header + standing line */}
      <header>
        <h1 className="text-[26px] sm:text-[30px] font-bold tracking-[-0.02em] text-text">
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
      <PulseSection portfolios={portfolios} spy={spySeries} />

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
        </div>
      </section>

      {/* Private real-money follower (migration 037) — owner-only; links out to
          its own (private) detail page. Kept separate from the arena books. */}
      {livePortfolio && <LiveFollowerCard p={livePortfolio} />}

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

function LiveFollowerCard({ p }: { p: DashPortfolio }) {
  const down = p.pnlPct != null && p.pnlPct < 0;
  const color = down
    ? "var(--color-red,#FF3333)"
    : "var(--color-green,#00FF41)";
  return (
    <section aria-label="Live account">
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
        Live account
      </h2>
      <Link
        href={`/portfolios/${p.slug}`}
        className="block rounded-xl border p-4 transition-colors hover:bg-[var(--color-green,#00FF41)]/[0.04]"
        style={{
          borderColor: "rgba(0,255,65,0.28)",
          background:
            "linear-gradient(180deg, rgba(0,255,65,0.05), rgba(255,255,255,0.012))",
        }}
      >
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-green,#00FF41)]/40 bg-[var(--color-green,#00FF41)]/[0.08] px-2.5 py-1 text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-[var(--color-green,#00FF41)]"
            title="Backed by a real Alpaca account. Private — only you can see this."
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-[var(--color-green,#00FF41)] animate-pulse"
              style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
            />
            Private · live · real money
          </span>
          <span className="text-[11px] font-mono text-text-muted">
            View account →
          </span>
        </div>
        <div className="mt-3 flex items-baseline gap-3 flex-wrap">
          <span className="font-semibold text-text truncate">{p.name}</span>
          <span className="text-lg font-semibold text-text">
            {p.value == null
              ? "—"
              : `$${p.value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
          </span>
          <span className="text-sm font-mono" style={{ color }}>
            {p.pnlPct == null
              ? ""
              : `${p.pnlPct >= 0 ? "▲" : "▼"} ${Math.abs(p.pnlPct).toFixed(2)}%`}
          </span>
          <span className="text-[11px] text-text-muted">
            {p.numPositions} position{p.numPositions === 1 ? "" : "s"}
          </span>
        </div>
        <p className="mt-2 text-xs text-text-muted leading-relaxed max-w-[60ch]">
          Mirrors your arena book&apos;s positions onto a real Alpaca account,
          sized to its actual value. Trades automatically with the swarm —
          nothing to manage here.
        </p>
      </Link>
    </section>
  );
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
        text: `${t.ticker} sold on a broken thesis — review ${t.portfolioName}'s mandate.`,
        href: `/portfolios/${t.portfolioSlug}`,
        actionLabel: "Review mandate",
      });
    }
  }

  for (const p of portfolios) {
    const href = `/portfolios/${p.slug}`;
    if (p.mandateEmpty) {
      items.push({
        id: `mandate-${p.id}`,
        urgency: "med",
        text: `${p.name} has no mandate set.`,
        href,
        actionLabel: "Write a brief",
      });
    }
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
    if (!p.isPublic && p.numPositions >= 10 && p.numPositions < PUBLIC_THRESHOLD) {
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
