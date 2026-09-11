/**
 * The /live access rule, with no database attached.
 *
 * Split from `live-access.ts` for one reason: that module imports the
 * Supabase service client at the top level, so the rule could not be
 * exercised without one — and the rule is the part that shipped wrong.
 * Same split as `money-move.ts` / its query module elsewhere in the app.
 */

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
 * Combine the two grants when either read may have failed.
 *
 * Split out from the database calls because the rule below is the one that
 * shipped wrong, and it is untestable while it is welded to PostgREST. The
 * grants are independent by design — one is an operator's decision, the other
 * a fact about what the user owns — so a failure to read one must not revoke
 * the other. Both reads originally sat in a single try/catch: the page was
 * merged before its migration ran, `select live_access` errored on a column
 * that did not exist, and the throw discarded the ownership answer with it.
 * Every owner of a real live account was 404'd out of their own console by the
 * absence of a flag that has nothing to do with them.
 *
 * `null` means "could not tell", and it is never read as a yes: each grant
 * still fails closed on its own, so access is only ever granted by a read that
 * succeeded and said yes. Denying when BOTH are null is a different
 * operational state from denying a user who simply has neither grant, so it is
 * logged as one.
 */
export function resolveLiveAccess(
  liveAccessFlag: boolean | null,
  livePortfolioCount: number | null,
): boolean {
  if (liveAccessFlag == null && livePortfolioCount == null) {
    console.error("live-access: both reads failed — denying.");
  }
  return hasLiveAccess({
    liveAccessFlag: liveAccessFlag ?? false,
    livePortfolioCount: livePortfolioCount ?? 0,
  });
}
