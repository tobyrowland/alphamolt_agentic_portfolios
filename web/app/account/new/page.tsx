import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import BriefTeamForm from "@/components/portfolio/brief-team-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getPaperPortfoliosForUser,
  MAX_PAPER_PORTFOLIOS,
} from "@/lib/portfolios-query";
import { PRESETS, DEFAULT_PRESET } from "@/lib/screen/config";

export const metadata: Metadata = {
  title: "New portfolio — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Brief another team (migration 070 — up to MAX_PAPER_PORTFOLIOS paper
 * portfolios per user). Reuses the first-run BriefTeamForm; at the cap the
 * page just bounces back to the dashboard.
 */
export default async function NewPortfolioPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/account/new");

  const portfolios = await getPaperPortfoliosForUser(user.id);
  if (portfolios.length >= MAX_PAPER_PORTFOLIOS) redirect("/account");

  let displayName = user.email?.split("@")[0] ?? "there";
  try {
    const { data } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .maybeSingle();
    if (data?.display_name) displayName = data.display_name;
  } catch {
    /* ignore — the default name falls back to the email local-part */
  }

  const presets = Object.values(PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
  }));
  const n = portfolios.length + 1;

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1100px] mx-auto w-full px-4 sm:px-6 py-8 sm:py-10">
          <header className="max-w-[58ch]">
            <nav
              aria-label="Breadcrumb"
              className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted"
            >
              <Link href="/account" className="hover:text-text transition-colors">
                Dashboard
              </Link>
              <span aria-hidden className="mx-2 text-text-muted/60">
                /
              </span>
              <span className="text-text-dim">New portfolio</span>
            </nav>
            <h1 className="mt-3 text-[26px] sm:text-[32px] font-bold tracking-[-0.02em] text-text leading-[1.15]">
              Brief another team
            </h1>
            <p className="mt-3 text-[15px] text-text border-l-2 border-[var(--color-green,#00FF41)] pl-3 leading-relaxed">
              Run a different strategy side by side and see which one wins.
              Portfolio {n} of {MAX_PAPER_PORTFOLIOS}.
            </p>
          </header>

          <div className="mt-8 max-w-[680px]">
            <BriefTeamForm
              presets={presets}
              defaultPreset={DEFAULT_PRESET}
              defaultName={`${displayName}'s Portfolio ${n}`}
              redirectTo="/account"
            />
          </div>
        </div>
      </main>
    </>
  );
}
