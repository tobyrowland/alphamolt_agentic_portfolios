import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPaperPortfoliosForUser } from "@/lib/portfolios-query";

export const metadata: Metadata = {
  title: "Apply screen — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Which portfolio gets this screen? Landed on from /screener/run when the
 * owner has several paper portfolios (migration 070). Each pick goes back
 * through the run route with an explicit `pf`, which applies the config and
 * redirects to that portfolio's page.
 */
export default async function ChoosePortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ config?: string }>;
}) {
  const { config } = await searchParams;
  const encoded = config ?? "";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(
      `/login?next=${encodeURIComponent(`/screener/run?config=${encoded}`)}`,
    );
  }

  const portfolios = await getPaperPortfoliosForUser(user.id);
  if (portfolios.length === 0) {
    redirect(`/account?from=screen&config=${encoded}`);
  }
  if (portfolios.length === 1) {
    redirect(`/screener/run?config=${encoded}&pf=${portfolios[0].id}`);
  }

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[720px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          <h1 className="text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text">
            Apply this screen to…
          </h1>
          <p className="mt-3 text-base text-text-muted leading-relaxed">
            You run several portfolios. Pick which one gets this screen as its
            selection recipe — its buyers will trade the ranked top&nbsp;N.
          </p>

          <ul className="mt-8 space-y-3">
            {portfolios.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/screener/run?config=${encoded}&pf=${p.id}`}
                  className="block rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4 hover:border-[var(--color-cyan)]/50 transition-colors"
                >
                  <span className="font-bold text-text">{p.display_name}</span>
                  {p.description && (
                    <span className="block mt-1 text-sm text-text-muted leading-relaxed line-clamp-2">
                      {p.description}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>

          <p className="mt-8 text-sm text-text-muted">
            Or{" "}
            <Link
              href="/account"
              className="text-[var(--color-cyan)] hover:brightness-110 transition-[filter]"
            >
              create a new portfolio
            </Link>{" "}
            and set this screen there.
          </p>
        </div>
      </main>
    </>
  );
}
