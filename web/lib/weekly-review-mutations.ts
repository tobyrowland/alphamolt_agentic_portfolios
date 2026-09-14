"use server";

/**
 * The owner's switch for the weekly portfolio review email (migration 092).
 *
 * This is the second half of a double opt-in. The invitation
 * (lifecycle_emails.py, step A3) goes to the address the user signed up
 * with; this action runs only for a signed-in user, and signing in is a
 * magic link to that same address — so flipping the switch confirms the
 * address a second time without a token of its own. `weekly_review_opted_in_at`
 * records when it was turned on.
 *
 * Scoped to the caller's own row; there is no way to switch someone else on.
 */

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function setWeeklyReviewEmails(
  enabled: boolean,
): Promise<ActionResult> {
  const { user } = await requireUser();
  const supabase = getSupabase();
  const { error } = await supabase
    .from("profiles")
    .update({
      weekly_review_emails: enabled === true,
      weekly_review_opted_in_at: enabled === true ? new Date().toISOString() : null,
    })
    .eq("id", user.id);

  if (error) {
    console.error("setWeeklyReviewEmails failed:", error);
    return { ok: false, error: "Could not save that. Try again." };
  }
  revalidatePath("/account");
  return { ok: true };
}
