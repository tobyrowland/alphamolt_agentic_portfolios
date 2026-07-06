import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Nav from "@/components/nav";
import ActivityDrawer from "@/components/activity-drawer";
import PortfolioTabs from "@/components/portfolio/portfolio-tabs";
import ScreenerClient from "@/app/screener/screener-client";
import { runScreen } from "@/lib/screen/query";
import { listActiveExclusions } from "@/lib/screen/exclusions-query";
import { projectDisplayRows } from "@/lib/screen/display-rows";
import { activeRejectionsForViewer } from "@/lib/screen/rejections-query";
import {
  DEFAULT_PRESET,
  presetConfig,
  screenConfigSchema,
} from "@/lib/screen/config";
import { getPortfolioMode } from "@/lib/portfolios-query";
import {
  isViewerOwner,
  resolveVisiblePortfolio,
} from "@/lib/portfolio-visibility";

export const metadata: Metadata = {
  // Owner-only surface — never indexed.
  title: "Universe — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ slug: string }>;
}

/**
 * The Universe tab of a portfolio: the screener page, verbatim, loaded with
 * this book's saved screen (portfolios.screen_config). Owner-only — everyone
 * else is bounced to the portfolio page. Persisting a changed screen goes
 * through the screener's existing "Run this screen as a portfolio" flow,
 * which (with the pf param) applies to this book and lands back on the
 * portfolio page.
 */

// Format the screener's freshness stamp — same as web/app/screener/page.tsx.
function formatAsOf(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const d = m
    ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function PortfolioUniversePage({ params }: PageParams) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug).toLowerCase();

  const portfolio = await resolveVisiblePortfolio(slug);
  if (!portfolio) notFound();

  const isOwner = await isViewerOwner(portfolio);
  if (!isOwner) redirect(`/portfolios/${portfolio.slug}`);
  const mode = portfolio.owner_user_id
    ? await getPortfolioMode(portfolio.id, portfolio.owner_user_id)
    : "paper";
  if (mode === "live") redirect(`/portfolios/${portfolio.slug}`);

  // This book's saved screen; a legacy null config falls back to the house
  // default preset (the same one createPortfolio seeds).
  const parsed = screenConfigSchema.safeParse(portfolio.screen_config);
  const config = parsed.success ? parsed.data : presetConfig(DEFAULT_PRESET);

  // Same data path as the /screener SSR, plus this book's rejection list
  // (the page is owner-gated, so per-user data is safe to render).
  const { rejections } = await activeRejectionsForViewer(portfolio.id);
  const rejectedSet = new Set(rejections.map((r) => r.ticker.toUpperCase()));
  const [initial, exclusions] = await Promise.all([
    runScreen(config, rejectedSet),
    listActiveExclusions(),
  ]);

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1040px] mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
          {/* Breadcrumb — which book this universe belongs to (an owner can
              run several since migration 070). */}
          <nav
            aria-label="Breadcrumb"
            className="mb-3 text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted"
          >
            <Link href="/account" className="hover:text-text transition-colors">
              Portfolios
            </Link>
            <span aria-hidden className="mx-2 text-text-muted/60">
              /
            </span>
            <Link
              href={`/portfolios/${portfolio.slug}`}
              className="hover:text-text transition-colors"
            >
              {portfolio.display_name}
            </Link>
            <span aria-hidden className="mx-2 text-text-muted/60">
              /
            </span>
            <span className="text-text-dim">Universe</span>
          </nav>
          <PortfolioTabs slug={portfolio.slug} active="universe" />

          {/* Header — same as the public screener page. */}
          <header className="mb-4">
            <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">
              Stock screener
            </p>
            <h1 className="mt-1 text-[23px] font-bold tracking-[-0.02em] leading-[1.1] text-text">
              Stock Screener
            </h1>
            <p className="mt-1.5 font-mono text-[11px] text-text-muted">
              All US-listed equities (incl. ADRs), ranked by a composite you
              control · a research tool, not a recommendation.
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              {initial.data_asof && (
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                  Last refreshed {formatAsOf(initial.data_asof)}
                </p>
              )}
              <ActivityDrawer
                label="Activity log"
                title="Screener activity"
                subtitle="Background data refreshes that shape these rankings."
                endpoint="/api/screen/activity"
                storageKey="alphamolt:activity:screener"
              />
            </div>
          </header>

          <ScreenerClient
            initialConfig={config}
            initialData={projectDisplayRows(initial)}
            sectors={initial.sectors}
            industries={initial.industries}
            exclusions={exclusions.map((e) => e.ticker)}
            rejections={rejections.map((r) => ({
              ticker: r.ticker,
              rejected_at: r.rejected_at,
            }))}
            portfolioContext={{
              id: portfolio.id,
              slug: portfolio.slug,
              name: portfolio.display_name,
            }}
          />
        </div>
      </main>
    </>
  );
}
