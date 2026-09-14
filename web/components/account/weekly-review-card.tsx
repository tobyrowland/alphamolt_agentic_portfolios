"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setWeeklyReviewEmails } from "@/lib/weekly-review-mutations";

/**
 * The standing control for the weekly portfolio review email (migration 092),
 * at the bottom of the dashboard — and the landing spot for the invitation
 * email's link when the top-of-page prompt is not showing.
 *
 * It is an ACTION when the review is off, not a setting: one big button,
 * because a click-through from an email that lands on an On/Off pill reads as
 * "configure something" rather than "do this". When it is on, it drops to a
 * quiet confirmation with a small way out. `enabled === null` means the flag
 * could not be read (the column is not there yet): an honest note, no button
 * that would fail on click.
 *
 * `anchor` puts `id="weekly-review"` here — the invitation email links to
 * that fragment — only when the page's prompt is not carrying it, so the id
 * is never on two elements.
 */
export default function WeeklyReviewCard({
  enabled,
  hasPositions,
  anchor = true,
}: {
  enabled: boolean | null;
  hasPositions: boolean;
  anchor?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function set(next: boolean) {
    if (enabled === null || next === enabled || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await setWeeklyReviewEmails(next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const on = enabled === true;

  return (
    <section
      id={anchor ? "weekly-review" : undefined}
      aria-label="Weekly review email"
      className={`rounded-xl border p-4 sm:p-5 scroll-mt-24 ${
        on
          ? "border-white/10 bg-white/[0.02]"
          : "border-[var(--color-green,#00FF41)]/30 bg-[var(--color-green,#00FF41)]/[0.04]"
      }`}
    >
      <h2
        className={`text-[11px] font-mono font-bold uppercase tracking-[0.14em] ${
          on ? "text-text-dim" : "text-[var(--color-green,#00FF41)]"
        }`}
      >
        Weekly review
      </h2>

      {on ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text">
            <span className="text-[var(--color-green,#00FF41)]" aria-hidden>
              ✓{" "}
            </span>
            You&apos;re getting the weekly review, every Sunday evening.
            {!hasPositions && (
              <span className="block text-[12px] text-text-muted mt-0.5">
                It starts once one of your portfolios holds a position.
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => set(false)}
            disabled={pending}
            className="text-[12px] font-mono uppercase tracking-widest text-text-muted hover:text-text disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? "…" : "Turn off"}
          </button>
        </div>
      ) : (
        <>
          <p className="mt-2 text-[15px] text-text max-w-[60ch]">
            Every Sunday evening, a model that isn&apos;t one of your agents
            reads your whole book and emails you a short critique: a chart
            against the S&amp;P 500, the week&apos;s trades, what it thinks is
            wrong, and what to change before Monday&apos;s rebalance.
          </p>
          {enabled === null ? (
            <p className="mt-3 text-[12px] text-text-muted">
              Not available yet — check back shortly.
            </p>
          ) : (
            <div className="mt-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <button
                type="button"
                onClick={() => set(true)}
                disabled={pending}
                className="px-6 py-3 bg-[var(--color-green,#00FF41)]/10 border border-[var(--color-green,#00FF41)]/40 text-[var(--color-green,#00FF41)] font-mono text-sm uppercase tracking-widest rounded hover:bg-[var(--color-green,#00FF41)]/20 hover:border-[var(--color-green,#00FF41)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {pending ? "Saving…" : "Email me the weekly review →"}
              </button>
              <span className="text-[12px] text-text-muted">
                One click. The same switch turns it off.
                {!hasPositions && " Starts once a portfolio holds a position."}
              </span>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="mt-2 text-[12px] text-[var(--color-red,#FF3333)]">{error}</p>
      )}
    </section>
  );
}
