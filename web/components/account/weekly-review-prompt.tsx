"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setWeeklyReviewEmails } from "@/lib/weekly-review-mutations";

/**
 * The weekly-review question, asked once, at the top of the dashboard
 * (migration 092).
 *
 * The address is already proven at sign-in, so a single click here is the
 * consent — no confirmation email, no second step. Two buttons, both real
 * answers: "Email me" turns it on; "No thanks" records a decision too, so
 * the prompt never comes back and the fallback invitation email is never
 * sent. The standing switch further down the page is where they change
 * their mind later. Rendered only while `weekly_review_decided_at` is NULL.
 */
export default function WeeklyReviewPrompt() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<boolean | null>(null);

  function answer(enabled: boolean) {
    if (pending) return;
    setError(null);
    setChoice(enabled);
    startTransition(async () => {
      const result = await setWeeklyReviewEmails(enabled);
      if (!result.ok) {
        setChoice(null);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section
      id="weekly-review"
      aria-label="Weekly review email"
      className="rounded-xl border border-[var(--color-green,#00FF41)]/30 bg-[var(--color-green,#00FF41)]/[0.04] p-4 sm:p-5 scroll-mt-24"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-[60ch]">
          <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--color-green,#00FF41)]">
            Weekly review
          </h2>
          <p className="mt-2 text-[15px] text-text">
            Want a second opinion on your portfolio every Sunday?
          </p>
          <p className="mt-1 text-sm text-text-muted">
            A model that isn&apos;t one of your agents reads your whole book
            and emails you a short critique: a chart against the S&amp;P 500,
            the week&apos;s trades, what it thinks is wrong, and what to change
            before Monday&apos;s rebalance. One switch to stop.
          </p>
          {error && (
            <p className="mt-2 text-[12px] text-[var(--color-red,#FF3333)]">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => answer(true)}
            disabled={pending}
            className="px-4 py-2 bg-[var(--color-green,#00FF41)]/10 border border-[var(--color-green,#00FF41)]/40 text-[var(--color-green,#00FF41)] font-mono text-[12px] uppercase tracking-widest rounded hover:bg-[var(--color-green,#00FF41)]/20 hover:border-[var(--color-green,#00FF41)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending && choice === true ? "Saving…" : "Email me the review"}
          </button>
          <button
            type="button"
            onClick={() => answer(false)}
            disabled={pending}
            className="px-3 py-2 text-[12px] font-mono uppercase tracking-widest text-text-muted hover:text-text disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending && choice === false ? "…" : "No thanks"}
          </button>
        </div>
      </div>
    </section>
  );
}
