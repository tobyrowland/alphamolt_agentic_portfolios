import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPaperPortfoliosForUser } from "@/lib/portfolios-query";
import { getWatchlistForPortfolio } from "@/lib/watchlist-query";
import WatchlistManager from "@/components/portfolio/watchlist-manager";

export const metadata: Metadata = {
  title: "Watchlist — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ pf?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/watchlist");
  }

  // A user may own several paper portfolios (migration 070): `?pf=<id>`
  // picks one, defaulting to the primary (oldest).
  const { pf } = await searchParams;
  const portfolios = await getPaperPortfoliosForUser(user.id);
  const portfolio = portfolios.find((p) => p.id === pf) ?? portfolios[0] ?? null;
  const items = portfolio ? await getWatchlistForPortfolio(portfolio.id) : [];

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          <header className="mb-10 sm:mb-12 max-w-[720px]">
            <nav
              aria-label="Breadcrumb"
              className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted"
            >
              <Link
                href="/account"
                className="hover:text-text transition-colors"
              >
                Dashboard
              </Link>
              <span aria-hidden className="mx-2 text-text-muted/60">
                /
              </span>
              <span className="text-text-dim">Watchlist</span>
            </nav>
            <h1 className="mt-3 text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text">
              Watchlist
            </h1>
            <p className="mt-3 text-base text-text-muted leading-relaxed">
              A shortlist of equities for{" "}
              {portfolio ? (
                <span className="text-text">{portfolio.display_name}</span>
              ) : (
                "your portfolio"
              )}
              . Curate it here — agents on this portfolio can populate the
              list and trade from it.
            </p>
          </header>

          {portfolio && portfolios.length > 1 && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              {portfolios.map((p) => (
                <Link
                  key={p.id}
                  href={`/account/watchlist?pf=${p.id}`}
                  aria-current={p.id === portfolio.id ? "page" : undefined}
                  className={`px-2.5 py-1 rounded font-mono text-[11px] uppercase tracking-widest border transition-colors ${
                    p.id === portfolio.id
                      ? "border-[var(--color-cyan)]/60 text-[var(--color-cyan)]"
                      : "border-white/10 text-text-muted hover:text-text"
                  }`}
                >
                  {p.display_name}
                </Link>
              ))}
            </div>
          )}

          {portfolio ? (
            <div className="max-w-[840px]">
              <WatchlistManager portfolioId={portfolio.id} items={items} />
            </div>
          ) : (
            <div className="max-w-[720px] rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8">
              <p className="text-sm text-text-muted leading-relaxed">
                You don&apos;t have a portfolio yet.{" "}
                <Link
                  href="/account"
                  className="text-[var(--color-cyan)] hover:brightness-110 transition-[filter]"
                >
                  Create one first &rarr;
                </Link>
              </p>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
