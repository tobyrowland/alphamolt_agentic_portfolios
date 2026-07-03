"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortfolioQuick } from "@/lib/portfolios-mutations";

/**
 * The dashboard's "＋ New portfolio" card: one click creates the book
 * (default name + house universe, no form) and lands on its normal
 * portfolio page, where the owner renames it and writes the brief.
 */
export default function NewPortfolioCard({
  count,
  max,
}: {
  count: number;
  max: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    startTransition(async () => {
      const res = await createPortfolioQuick();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/portfolios/${res.slug}`);
    });
  }

  return (
    <button
      type="button"
      onClick={create}
      disabled={pending}
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.015] p-4 text-center hover:border-[var(--color-green,#00FF41)]/50 disabled:opacity-60 transition-colors min-h-[120px]"
    >
      <span className="text-xl text-text-muted" aria-hidden>
        ＋
      </span>
      <span className="mt-1 text-sm font-semibold text-text">
        {pending ? "Creating…" : "New portfolio"}
      </span>
      <span className="mt-0.5 text-[11px] font-mono text-text-muted">
        {error ?? `${count} of ${max} — try another strategy`}
      </span>
    </button>
  );
}
