"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setWeeklyReviewEmails } from "@/lib/weekly-review-mutations";

/**
 * The opt-in switch for the weekly portfolio review email (migration 092).
 *
 * Deliberately a small card on the dashboard rather than a settings page:
 * the invitation email links straight here (`/account#weekly-review`), and
 * turning it on is the second confirmation of a double opt-in — the user is
 * signed in via a magic link to the same address the invitation went to.
 *
 * `enabled === null` means the flag could not be read (the column is not
 * there yet): the switch is shown disabled with an honest note rather than
 * a control that would fail on click.
 */
export default function WeeklyReviewCard({
  enabled,
  hasPositions,
}: {
  enabled: boolean | null;
  hasPositions: boolean;
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

  const options: { value: boolean; label: string }[] = [
    { value: true, label: "On" },
    { value: false, label: "Off" },
  ];

  return (
    <section
      id="weekly-review"
      aria-label="Weekly review email"
      className="rounded-xl border border-white/10 bg-white/[0.02] p-4 scroll-mt-24"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-[60ch]">
          <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim">
            Weekly review
          </h2>
          <p className="mt-2 text-sm text-text">
            Every Sunday evening, a model that isn&apos;t one of your agents
            reads your whole book and emails you a short review: a chart
            against the S&amp;P 500, the week&apos;s trades, what it thinks is
            wrong, and what to change before Monday&apos;s rebalance.
          </p>
          {enabled === null ? (
            <p className="mt-2 text-[12px] text-text-muted">
              Not available yet — check back shortly.
            </p>
          ) : !hasPositions ? (
            <p className="mt-2 text-[12px] text-text-muted">
              Sends once one of your portfolios holds a position.
            </p>
          ) : null}
          {error && (
            <p className="mt-2 text-[12px] text-[var(--color-red,#FF3333)]">
              {error}
            </p>
          )}
        </div>
        <span
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.14em]"
          title="Email me the weekly review of my portfolios"
        >
          <span className="text-text-muted">Email</span>
          <span aria-hidden className="text-text-muted/60">
            ·
          </span>
          <span
            role="group"
            aria-label="Weekly review email"
            className="inline-flex items-center gap-0.5"
          >
            {options.map((opt) => {
              const active = enabled === opt.value;
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => set(opt.value)}
                  disabled={pending || enabled === null}
                  aria-pressed={active}
                  className={`rounded px-1.5 py-0.5 transition-colors disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 ${
                    active
                      ? "text-[var(--color-green)]"
                      : "text-text-muted hover:text-text disabled:opacity-50"
                  }`}
                >
                  {pending && !active ? "…" : opt.label}
                </button>
              );
            })}
          </span>
        </span>
      </div>
    </section>
  );
}
