"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncLivePortfolioToAlpaca } from "@/lib/live-mirror-mutations";

/**
 * Owner control on a live portfolio: trigger a real-money mirror of the paper
 * book onto the Alpaca account (buys/sells the drifted names). Because this
 * places REAL orders, it's two-step — the first click arms a confirm, the
 * second dispatches. After dispatch it shows a "started" note (the workflow
 * runs async on GitHub Actions; fills land on the next sync/refresh).
 */
export default function SyncLiveButton({ portfolioId }: { portfolioId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function dispatch() {
    setError(null);
    startTransition(async () => {
      const result = await syncLivePortfolioToAlpaca({ portfolioId });
      if (!result.ok) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      setDone(true);
      setConfirming(false);
      router.refresh();
    });
  }

  if (done) {
    return (
      <p className="mt-3 text-[13px] text-[var(--color-green)] leading-relaxed">
        Sync started — Alpaca orders are being placed to match your paper book.
        Fills appear here after the next reconcile (give it a minute, then
        refresh).
      </p>
    );
  }

  return (
    <div className="mt-3">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex items-center rounded-lg bg-[var(--color-green)] px-4 py-2 text-sm font-bold text-black hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-green)]/40 transition-[filter]"
        >
          Sync to Alpaca →
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-text-dim leading-relaxed">
            This places <span className="text-text font-semibold">real buy &amp; sell
            orders</span> on your Alpaca account to match your paper portfolio.
            Continue?
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={dispatch}
              disabled={pending}
              className="inline-flex items-center rounded-lg bg-[var(--color-green)] px-4 py-2 text-sm font-bold text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-green)]/40 transition-[filter]"
            >
              {pending ? "Starting…" : "Yes, place real orders"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="inline-flex items-center rounded-lg border border-white/[0.12] px-4 py-2 text-sm font-medium text-text-dim hover:text-text hover:border-white/20 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-[var(--color-red)] font-mono">{error}</p>
      )}
      <p className="mt-2 text-[11px] text-text-muted leading-relaxed">
        Mirrors only the names that have drifted. Runs in the background; orders
        fill during US market hours.
      </p>
    </div>
  );
}
