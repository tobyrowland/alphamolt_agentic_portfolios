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
 *
 * Styled as a RISK control, not a primary one: it lives inside a strategy's
 * drawer, and the account page now spends green on gains and red on losses and
 * refusals, so a green "go" button here would have read as "this is the good
 * outcome" for the one control that spends real money.
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
      <p className="mt-3 text-[13px] leading-relaxed text-text-dim">
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
          className="inline-flex items-center rounded-lg border border-amber-400/50 bg-amber-400/10 px-3.5 py-1.5 text-[13px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40"
        >
          Sync now — places real orders
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
              className="inline-flex items-center rounded border border-[var(--color-red)]/50 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-widest text-[var(--color-red)] transition-colors hover:bg-[var(--color-red)]/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Starting…" : "Yes — place real orders"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="inline-flex items-center rounded border border-white/15 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-widest text-text-muted transition-colors hover:text-text disabled:opacity-50"
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
