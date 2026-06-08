import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import Onboarding from "@/components/account/onboarding";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioForUser } from "@/lib/portfolios-query";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's "Portfolio" surface. The nav links here so visitors
 * have a stable entry that always resolves to whichever portfolio they own —
 * no need for the nav to fetch the slug client-side. It is also the default
 * landing for a magic-link sign-in (the auth callback's `next`).
 *
 *   * Not signed in            → /login?next=/account/portfolio
 *   * Signed in, no portfolio  → render the unconfigured onboarding in place
 *                                (the "Brief your team" first-run screen), so a
 *                                first-time user lands on the Portfolio page in
 *                                its unconfigured state rather than the dashboard
 *   * Signed in with portfolio → /portfolios/<slug>
 */
export default async function PortfolioRedirect() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/portfolio");
  }

  const portfolio = await getPortfolioForUser(user.id);
  if (portfolio) {
    redirect(`/portfolios/${portfolio.slug}`);
  }

  // No portfolio yet — show the Portfolio page in its unconfigured state
  // (the same first-run onboarding the dashboard uses) instead of bouncing
  // to /account.
  let displayName = user.email?.split("@")[0] ?? "there";
  try {
    const { data } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .maybeSingle();
    if (data?.display_name) displayName = data.display_name;
  } catch {
    /* ignore — greeting falls back to the email local-part */
  }

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1100px] mx-auto w-full px-4 sm:px-6 py-8 sm:py-10">
          <Onboarding displayName={displayName} />
        </div>
      </main>
    </>
  );
}
