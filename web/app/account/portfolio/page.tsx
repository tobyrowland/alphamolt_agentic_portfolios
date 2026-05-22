import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioForUser } from "@/lib/portfolios-query";

export const dynamic = "force-dynamic";

/**
 * Server-side redirect to the signed-in user's own portfolio detail page
 * (`/portfolios/<slug>`). The nav links here so visitors have a stable
 * "Portfolio" entry that always resolves to whichever slug they own — no
 * need for the nav to fetch the slug client-side.
 *
 *   * Not signed in → /login?next=/account/portfolio
 *   * Signed in, no portfolio yet → /account (where they'd create one)
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
  if (!portfolio) {
    redirect("/account");
  }

  redirect(`/portfolios/${portfolio.slug}`);
}
