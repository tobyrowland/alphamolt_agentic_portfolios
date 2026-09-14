"use server";

/**
 * The owner's choice about the weekly portfolio review email (migration 092).
 *
 * Every address is already proven at sign-in (magic link or Google), so one
 * explicit choice made while signed in is the consent. This action is called
 * from the two-button prompt on /account, the standing switch below it, and
 * the checkbox on the first-portfolio form. `weekly_review_decided_at` is
 * stamped either way: it is what stops the prompt asking again, and it is why
 * the fallback invitation email never goes to someone who said no.
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
      weekly_review_decided_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (error) {
    console.error("setWeeklyReviewEmails failed:", error);
    return { ok: false, error: "Could not save that. Try again." };
  }
  revalidatePath("/account");
  return { ok: true };
}
