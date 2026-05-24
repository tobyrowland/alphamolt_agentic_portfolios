import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioForUser } from "@/lib/portfolios-query";
import CreatePortfolioForm from "@/components/portfolio/create-portfolio-form";

export const metadata: Metadata = {
  title: "Your account — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const PUBLIC_ACTIVATE_THRESHOLD = 15;

/**
 * Dashboard / onboarding gate. Three branches:
 *
 *   * Not signed in → /login
 *   * Signed in, portfolio exists → /portfolios/<slug>
 *     (the portfolio detail page IS the dashboard for the owner)
 *   * Signed in, no portfolio yet → render the onboarding form here so
 *     the user can create one
 *
 * Mandate / agent / visibility editing lives on /account/settings.
 */
export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account");
  }

  let portfolio: { slug: string } | null = null;
  try {
    const p = await getPortfolioForUser(user.id);
    portfolio = p ? { slug: p.slug } : null;
  } catch {
    portfolio = null;
  }

  if (portfolio) {
    redirect(`/portfolios/${portfolio.slug}`);
  }

  // No portfolio yet — onboarding.
  let profile: { email: string | null; display_name: string | null } | null =
    null;
  try {
    const { data } = await supabase
      .from("profiles")
      .select("email, display_name")
      .eq("id", user.id)
      .maybeSingle();
    profile = data ?? null;
  } catch {
    profile = null;
  }
  const email = profile?.email ?? user.email ?? "";
  const displayName = profile?.display_name || email.split("@")[0] || "there";

  return (
    <>
      <Nav />
      <main className="flex-1 w-full relative">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[440px] -z-10 opacity-80"
          style={{
            background:
              "radial-gradient(60% 65% at 16% 8%, rgba(0,255,65,0.05), transparent 70%), radial-gradient(48% 55% at 86% 4%, rgba(0,242,255,0.06), transparent 70%)",
          }}
        />
        <div className="max-w-[640px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          <SectionBadge>Get started</SectionBadge>
          <h1 className="mt-4 text-[28px] sm:text-[34px] font-bold tracking-[-0.025em] text-text leading-[1.1]">
            Welcome, {displayName}.
          </h1>
          <p className="mt-3 text-base text-text-muted leading-relaxed">
            Create your portfolio: give it a name and write the mandate your
            team of AI agents will trade a $1M paper account to. It starts
            Private — flip it to Public once it holds{" "}
            {PUBLIC_ACTIVATE_THRESHOLD}+ equities.
          </p>
          <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
            <CreatePortfolioForm />
          </div>
          <form
            action="/auth/signout"
            method="post"
            className="flex items-center justify-between gap-3 pt-6"
          >
            <span className="text-[11px] font-mono text-text-muted truncate">
              Signed in as {email}
            </span>
            <button
              type="submit"
              className="text-[11px] font-mono text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 rounded px-1"
            >
              Sign out →
            </button>
          </form>
        </div>
      </main>
    </>
  );
}

function SectionBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-cyan)]/25 bg-[var(--color-cyan)]/[0.07] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-cyan)]">
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-[var(--color-cyan)]"
        style={{ boxShadow: "0 0 6px rgba(0,242,255,0.8)" }}
      />
      {children}
    </span>
  );
}
