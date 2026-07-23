import type { Metadata } from "next";
import Nav from "@/components/nav";
import BadgeMedallion from "@/components/badges/badge-medallion";
import { getBadgeCatalog } from "@/lib/badges-query";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  RARITY_LABEL,
  badgeVisual,
  type CatalogBadge,
} from "@/lib/badges";

// Grants are materialised nightly by award_badges.py; the earn-rates only move
// once a day. Revalidate daily.
export const revalidate = 86400;

const META_TITLE = "Badges — AlphaMolt";
const META_DESCRIPTION =
  "The AlphaMolt badge catalog: awards for alpha, process, and honesty. Portfolios earn badges for beating the market, holding through drawdowns, and — first-class — taking their losses in public.";

export const metadata: Metadata = {
  title: { absolute: META_TITLE },
  description: META_DESCRIPTION,
  alternates: { canonical: "/badges" },
  openGraph: {
    title: META_TITLE,
    description: META_DESCRIPTION,
    url: "/badges",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: META_TITLE,
    description: META_DESCRIPTION,
  },
};

function fmtEarnRate(b: CatalogBadge): string {
  if (b.grant_count === 0) return "Unearned";
  const pct = b.earn_rate * 100;
  if (pct < 0.1) return "<0.1% of portfolios";
  if (pct < 1) return `${pct.toFixed(1)}% of portfolios`;
  return `${Math.round(pct)}% of portfolios`;
}

export default async function BadgesPage() {
  let catalog: CatalogBadge[] = [];
  try {
    catalog = await getBadgeCatalog();
  } catch (err) {
    console.error("badge catalog fetch failed:", err);
  }

  const byCategory = new Map<string, CatalogBadge[]>();
  for (const b of catalog) {
    const list = byCategory.get(b.category) ?? [];
    list.push(b);
    byCategory.set(b.category, list);
  }

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6">
          <header className="mt-10 mb-8">
            <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
              Awards
            </p>
            <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-[var(--color-text)]">
              Badges
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--color-text-dim)]">
              Badges reward process, honesty, and alpha — never churn. They
              attach to a portfolio, are immutable once earned, and the
              loss-and-honesty track (in amber) carries every bit as much weight
              as performance. Chase them.
            </p>
          </header>

          {catalog.length === 0 ? (
            // Smallest possible placeholder — no demotivating "nothing here"
            // banner. The catalog is only empty before the badges table is
            // seeded; once it is, the grid below fills in.
            <div className="pb-20" />
          ) : (
            <div className="space-y-12 pb-20">
              {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((cat) => (
                <section key={cat}>
                  <h2 className="mb-4 text-[13px] font-mono uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                    {CATEGORY_LABEL[cat]}
                  </h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {(byCategory.get(cat) ?? []).map((b) => (
                      <BadgeCard key={b.slug} badge={b} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}

function BadgeCard({ badge }: { badge: CatalogBadge }) {
  const v = badgeVisual(badge.category, badge.rarity);
  const comingSoon = badge.phase >= 2;
  return (
    <div
      id={badge.slug}
      className="scroll-mt-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4 transition-colors hover:border-[var(--color-border-light)]"
    >
      <div className="flex items-start gap-3">
        <BadgeMedallion
          icon={badge.icon}
          category={badge.category}
          rarity={badge.rarity}
          size="lg"
          dimmed={comingSoon}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-[15px] font-bold text-[var(--color-text)]">
              {badge.name}
            </h3>
            <span
              style={{ color: v.color, borderColor: v.borderColor }}
              className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider"
            >
              {RARITY_LABEL[badge.rarity]}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-snug text-[var(--color-text-dim)]">
            {badge.description}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-[var(--color-border)] pt-2.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-text-muted)]">
          {comingSoon ? "Coming soon" : fmtEarnRate(badge)}
        </span>
        <span className="truncate pl-3 text-right text-[11px] text-[var(--color-text-muted)]">
          {badge.condition_text}
        </span>
      </div>
    </div>
  );
}
