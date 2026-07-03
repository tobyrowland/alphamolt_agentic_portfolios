import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPaperPortfoliosForUser } from "@/lib/portfolios-query";

export const dynamic = "force-dynamic";

/**
 * Server-side redirect to the signed-in user's own portfolio detail page
 * (`/portfolios/<slug>`). The nav links here so visitors have a stable
 * "Portfolio" entry that always resolves correctly — no need for the nav to
 * fetch the slug client-side.
 *
 *   * Not signed in → /login?next=/account/portfolio
 *   * Signed in, no portfolio yet → /account (where they'd create one)
 *   * Signed in with exactly one portfolio → /portfolios/<slug>
 *   * Signed in with several (migration 070) → /account (the dashboard grid
 *     is the picker)
 */
export default async function PortfolioRedirect() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/portfolio");
  }

  const portfolios = await getPaperPortfoliosForUser(user.id);
  if (portfolios.length !== 1) {
    redirect("/account");
  }

  redirect(`/portfolios/${portfolios[0].slug}`);
}
