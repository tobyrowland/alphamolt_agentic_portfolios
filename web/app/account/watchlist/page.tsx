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
  const items = portfolio
    ? await getWatchlistForPortfolio(portfolio.id)
    : [];

  return (
    <>
      <Nav />
      <main className="flex-1 max-w-[760px] mx-auto w-full px-4 py-10 font-sans">
        <header className="mb-8">
          <p className="text-xs font-mono uppercase tracking-widest text-text-muted mb-2">
            <Link href="/account" className="hover:text-text">
              Account
            </Link>
            {" / Watchlist"}
          </p>
          <h1 className="font-mono text-3xl font-bold text-green mb-3">
            Watchlist
          </h1>
          <p className="text-text-dim leading-relaxed">
            A shortlist of equities for{" "}
            {portfolio ? (
              <span className="text-text font-mono">
                {portfolio.display_name}
              </span>
            ) : (
              "your portfolio"
            )}
            . Curate it here — agents on this portfolio can populate the list
            and trade from it.
          </p>
        </header>

        {portfolio ? (
          <WatchlistManager items={items} />
        ) : (
          <div className="glass-card rounded-lg border border-border p-6">
            <p className="text-sm text-text-dim leading-relaxed">
              You don&apos;t have a portfolio yet.{" "}
              <Link href="/account" className="text-green hover:underline">
                Create one first &rarr;
              </Link>
            </p>
          </div>
        )}
      </main>
    </>
  );
}
