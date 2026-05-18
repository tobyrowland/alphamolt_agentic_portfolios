import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import AccountTabs from "@/components/account-tabs";
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
  const items = portfolio
    ? await getWatchlistForPortfolio(portfolio.id)
    : [];

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
          {portfolio && <AccountTabs />}

          <header className="mb-6">
            <h1 className="text-[26px] sm:text-[32px] font-bold tracking-[-0.025em] text-text leading-[1.12]">
              Watchlist
            </h1>
            <p className="mt-2 text-base text-text-muted leading-relaxed max-w-[60ch]">
              The shortlist of equities for{" "}
              {portfolio ? (
                <span className="text-text">{portfolio.display_name}</span>
              ) : (
                "your portfolio"
              )}
              . A Shortlist Builder agent curates it; the Buying Agent trades
              from it — and you can add or remove equities here yourself.
            </p>
          </header>

          {portfolio ? (
            <WatchlistManager items={items} />
          ) : (
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
              <p className="text-sm text-text-muted leading-relaxed">
                You don&apos;t have a portfolio yet.{" "}
                <Link
                  href="/account"
                  className="text-[var(--color-cyan)] hover:underline"
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
