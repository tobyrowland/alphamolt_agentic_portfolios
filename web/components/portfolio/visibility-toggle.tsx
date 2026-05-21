"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPortfolioVisibility } from "@/lib/portfolios-mutations";

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
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-sm text-text">
            {isPublic ? "Public" : "Private"}
          </p>
          <p className="text-xs text-text-muted mt-1 leading-relaxed">
            {isPublic
              ? "Anyone can view this portfolio at its public URL."
              : "Only you can view this portfolio. It's hidden from its public URL and the portfolio API."}
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          className="shrink-0 px-3 py-1.5 font-mono text-xs uppercase tracking-widest rounded border border-white/10 text-text-dim hover:text-text hover:border-text/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? "…" : isPublic ? "Make private" : "Make public"}
        </button>
      </div>
      {error && (
        <div className="mt-3 text-sm text-red font-mono border-l-2 border-red pl-3 py-1">
          {error}
        </div>
      )}
    </div>
  );
}
