"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPortfolioVisibility } from "@/lib/portfolios-mutations";

/**
 * Compact inline pill — current visibility state + a single button to
 * flip it. Designed to sit next to a page H1, not own a card. The owner
 * sees this on the portfolio detail page header.
 */
export default function VisibilityToggle({ isPublic }: { isPublic: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await setPortfolioVisibility({ isPublic: !isPublic });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

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
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          className="text-text-dim hover:text-text disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 rounded transition-colors"
        >
          {pending ? "…" : isPublic ? "Make private" : "Make public"}
        </button>
      </span>
      {error && (
        <span className="text-xs text-[var(--color-red)] font-mono">
          {error}
        </span>
      )}
    </div>
  );
}
