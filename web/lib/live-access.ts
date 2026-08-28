import { getSupabase } from "@/lib/supabase";

/**
 * Who may open the /live console (migration 089).
 *
 * The console moves real money, so it is not a page every signed-in visitor
 * should reach. Two independent grants, because neither covers the other:
 *
 *  - **Owning a live portfolio.** A follower row only exists after an operator
 *    runs the go-live flow, so holding one already proves provisioning. This
 *    is the rule that needs no administration and that covers every current
 *    user.
 *  - **`profiles.live_access`.** For the case ownership cannot serve: showing
 *    the console to someone BEFORE they are provisioned — a beta cohort, or an
 *    owner mid-onboarding whose follower row does not exist yet.
 *
 * Access is the OR of the two. The pure resolver is separated from the read so
 * the rule is testable without a database.
 */
export function hasLiveAccess(input: {
  liveAccessFlag: boolean;
  livePortfolioCount: number;
}): boolean {
  return input.liveAccessFlag || input.livePortfolioCount > 0;
}

/**
 * Resolve access for one signed-in user.
 *
 * Fails CLOSED: a database error returns false rather than opening a
 * real-money surface on a failed read. That is the opposite of the fail-open
 * contract the rest of the live hub uses, and deliberately so — there the
 * cost of failure is a missing line, here it is an unauthorised page.
 */
export async function getLiveAccess(userId: string): Promise<boolean> {
  const supabase = getSupabase();
  try {
    const [profile, live] = await Promise.all([
      supabase
        .from("profiles")
        .select("live_access")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("portfolios")
        .select("id", { count: "exact", head: true })
        .eq("owner_user_id", userId)
        .eq("mode", "live"),
    ]);
    if (profile.error) throw profile.error;
    if (live.error) throw live.error;
    return hasLiveAccess({
      liveAccessFlag: Boolean(
        (profile.data as { live_access?: boolean } | null)?.live_access,
      ),
      livePortfolioCount: live.count ?? 0,
    });
  } catch (err) {
    console.error("live-access: resolve failed, denying:", err);
    return false;
  }
}
