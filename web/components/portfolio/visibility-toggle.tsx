"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPortfolioVisibility } from "@/lib/portfolios-mutations";

const PUBLIC_ACTIVATE_THRESHOLD = 12;

/**
 * Owner control for portfolio visibility, with an eligibility-aware emphasis:
 *
 *  - **Eligible but still private** (holds ≥ 12 equities) → a prominent green
 *    CTA banner that actively invites the owner onto the public leaderboard.
 *    This is the state we most want acted on, so it's loud, not a quiet pill.
 *  - **Public** → a compact status pill with a "Make private" control.
 *  - **Private, not yet eligible** → a compact pill showing progress to the
 *    12-equity threshold (no actionable button — it can't flip yet).
 *
 * The Public flip is hysteresis-gated server-side (migration 031,
 * `enforce_portfolio_public_threshold`); we mirror the gate here so the UI only
 * offers the action when it will succeed. Sits in the page-header flex-wrap
 * row, so the full-width banner naturally takes its own line.
 */
export default function VisibilityToggle({
  portfolioId,
  isPublic,
  holdingsCount,
}: {
  portfolioId: string;
  isPublic: boolean;
  holdingsCount: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const eligible = holdingsCount >= PUBLIC_ACTIVATE_THRESHOLD;

  function setVisibility(next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setPortfolioVisibility({ portfolioId, isPublic: next });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  // --- Prominent CTA: eligible, still private. The nudge to go public. ---
  if (!isPublic && eligible) {
    return (
      <div className="w-full rounded-2xl border border-[var(--color-green)]/40 bg-[var(--color-green)]/[0.06] px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-[var(--color-green)] flex items-center gap-2">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full bg-[var(--color-green)]"
              style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
            />
            Your portfolio is eligible for the public leaderboard
          </p>
          <p className="text-[12px] text-text-dim mt-1 leading-relaxed">
            Make it public to get ranked against everyone by alpha vs SPY. You
            can switch back to private anytime.
          </p>
          {error && (
            <p className="text-xs text-[var(--color-red)] font-mono mt-1.5">
              {error}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setVisibility(true)}
          disabled={pending}
          className="shrink-0 rounded-lg bg-[var(--color-green)] px-4 py-2 text-sm font-bold text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-green)]/40 transition-[filter]"
        >
          {pending ? "Making public…" : "Make public →"}
        </button>
      </div>
    );
  }

  // --- Compact pill: public (with Make private), or progress to eligibility. ---
  return (
    <div className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.14em]">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            isPublic ? "bg-[var(--color-green)]" : "bg-text-muted"
          }`}
          style={
            isPublic ? { boxShadow: "0 0 6px rgba(0,255,65,0.5)" } : undefined
          }
        />
        <span className={isPublic ? "text-[var(--color-green)]" : "text-text-muted"}>
          {isPublic ? "Public" : "Private"}
        </span>
        <span aria-hidden className="text-text-muted/60">
          ·
        </span>
        {isPublic ? (
          <button
            type="button"
            onClick={() => setVisibility(false)}
            disabled={pending}
            className="text-text-dim hover:text-text disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 rounded transition-colors"
          >
            {pending ? "…" : "Make private"}
          </button>
        ) : (
          <span
            className="text-text-muted normal-case tracking-normal"
            title={`Hold ${PUBLIC_ACTIVATE_THRESHOLD}+ equities to go public (currently ${holdingsCount}).`}
          >
            {holdingsCount}/{PUBLIC_ACTIVATE_THRESHOLD} to go public
          </span>
        )}
      </span>
      {error && (
        <span className="text-xs text-[var(--color-red)] font-mono">
          {error}
        </span>
      )}
    </div>
  );
}
