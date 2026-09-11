import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Nav from "@/components/nav";
import BetaDisclaimer from "@/components/beta-disclaimer";
import LiveAccountHub from "@/components/account/live-account-hub";
import PositionsTable from "@/components/account/positions-table";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getLiveAccess } from "@/lib/live-access";
import { getLiveCashOverview } from "@/lib/live-cash-query";
import { getLiveActivity, EMPTY_LIVE_ACTIVITY } from "@/lib/live-activity-query";
import { getLivePositions } from "@/lib/live-positions-query";
import { getDashboardData } from "@/lib/dashboard-query";
import type { StrategyMeta } from "@/components/account/strategy-row";

export const metadata: Metadata = {
  // Real-money surface: never indexed, never in the sitemap.
  title: "Live — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The live console — real money, its own page.
 *
 * It used to be a section near the bottom of /account, sharing that page's
 * 1100px column with five other sections. That was the wrong home twice over:
 * it is the one surface that spends real money, and it needs room for things
 * /account has no business carrying — every position, its weight against the
 * paper book's target, and what the next sync will do about it.
 *
 * Access is the OR of an operator grant and owning a live portfolio
 * (web/lib/live-access.ts). A visitor without it gets `notFound()` rather than
 * a redirect or a "no access" screen: there is no reason to disclose that the
 * page exists, and a 404 is the only answer that discloses nothing.
 */
export default async function LivePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/live");

  if (!(await getLiveAccess(user.id))) notFound();

  const { portfolios, livePortfolios } = await getDashboardData(user.id);

  // Fail-open, as on /account: a broker hiccup costs a figure, never the page.
  const accounts = await getLiveCashOverview(user.id).catch((err) => {
    console.error("live: cash overview failed:", err);
    return [];
  });
  const activity =
    livePortfolios.length > 0
      ? await getLiveActivity(livePortfolios.map((p) => p.id)).catch((err) => {
          console.error("live: activity read failed:", err);
          return EMPTY_LIVE_ACTIVITY;
        })
      : EMPTY_LIVE_ACTIVITY;

  const sleeves = accounts.flatMap((a) =>
    a.sleeves.map((s) => ({
      portfolioId: s.portfolioId,
      followsPortfolioId: s.followsPortfolioId,
      allowance: s.allowance,
    })),
  );
  const positions = await getLivePositions(sleeves).catch((err) => {
    console.error("live: positions read failed:", err);
    return new Map();
  });

  const liveMeta: Record<string, StrategyMeta> = {};
  for (const p of livePortfolios) {
    liveMeta[p.id] = {
      pnlPct: p.pnlPct,
      numPositions: p.numPositions,
      followsName: p.followsName,
    };
  }

  const pricedAt = [...positions.values()][0]?.pricedAt ?? null;

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1280px] mx-auto w-full px-4 sm:px-6 py-8 sm:py-10 space-y-8">
          <header>
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Live
              </p>
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-green,#00FF41)]/40 bg-[var(--color-green,#00FF41)]/[0.08] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-green,#00FF41)]"
                title="Backed by a real broker account. Private — only you can see this."
              >
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-[var(--color-green,#00FF41)] animate-pulse"
                  style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
                />
                Private · real money
              </span>
            </div>
            <h1 className="mt-1 text-[26px] sm:text-[30px] font-bold tracking-[-0.02em] text-text">
              Real-money account
            </h1>
            <p className="mt-1 max-w-[70ch] text-sm text-text-muted">
              Your strategies share one broker account. This page is where the
              money is split between them, what each one holds, and what the
              next sync will do.{" "}
              <Link href="/account" className="text-text-dim underline hover:text-text">
                Your paper portfolios
              </Link>{" "}
              are where the agents actually decide.
            </p>
          </header>

          {accounts.length === 0 ? (
            <NoAccountYet />
          ) : (
            <>
              <LiveAccountHub
                accounts={accounts}
                paperOptions={portfolios.map((p) => ({ id: p.id, name: p.name }))}
                liveMeta={liveMeta}
                activity={activity}
              />

              <section aria-label="Positions" className="space-y-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text-dim">
                    Positions
                  </h2>
                  {/* The marks are close-to-close: the 15-minute intraday
                      refresh is paused (EOD-first price policy), so these
                      figures WILL differ from the broker's live screen during
                      the session. Saying so is cheaper than the alternative,
                      which is the owner reconciling two numbers by hand. */}
                  <p className="text-[11.5px] text-text-muted">
                    Marked at the last close
                    {pricedAt ? ` (${new Date(pricedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })})` : ""}
                    , so these differ from your broker&apos;s live prices during
                    market hours.
                  </p>
                </div>
                {accounts.flatMap((a) =>
                  a.sleeves.map((s) => {
                    const p = positions.get(s.portfolioId);
                    if (!p) return null;
                    return (
                      <div
                        key={s.portfolioId}
                        className="rounded-xl border border-border bg-bg-card px-4 py-3.5"
                      >
                        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                          <h3 className="text-[14px] font-semibold text-text">
                            {s.displayName}
                          </h3>
                          <p className="font-mono text-[11.5px] tabular-nums text-text-muted">
                            {p.summary.count} position
                            {p.summary.count === 1 ? "" : "s"}
                            {p.summary.wouldTrade > 0 &&
                              ` · ${p.summary.wouldTrade} to trade next sync`}
                          </p>
                        </div>
                        <PositionsTable
                          positions={p}
                          strategyName={s.displayName}
                        />
                      </div>
                    );
                  }),
                )}
              </section>
            </>
          )}

          <BetaDisclaimer />
        </div>
      </main>
    </>
  );
}

/**
 * Granted access, but nothing provisioned yet — the `live_access` flag's whole
 * reason for existing, so it must land somewhere better than an empty page.
 */
function NoAccountYet() {
  return (
    <div className="rounded-xl border border-border bg-bg-card px-5 py-6">
      <h2 className="text-[15px] font-semibold text-text">
        No real-money account connected yet
      </h2>
      <p className="mt-1.5 max-w-[65ch] text-sm text-text-muted">
        Going live is operator-run: a follower is created against your broker
        account and seeded from its real balance, then it copies one of your
        paper books. Until that happens there is nothing here to show.
      </p>
      <Link
        href="/account"
        className="mt-4 inline-block text-[13px] text-text-dim underline hover:text-text"
      >
        Back to your portfolios
      </Link>
    </div>
  );
}
