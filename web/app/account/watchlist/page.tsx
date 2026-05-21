import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioForUser } from "@/lib/portfolios-query";
import { getWatchlistForPortfolio } from "@/lib/watchlist-query";
import WatchlistManager from "@/components/portfolio/watchlist-manager";

export const metadata: Metadata = {
  title: "Watchlist — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/watchlist");
  }

  const portfolio = await getPortfolioForUser(user.id);
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

          {portfolio ? (
            <div className="max-w-[840px]">
              <WatchlistManager items={items} />
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
