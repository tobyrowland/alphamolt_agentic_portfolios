"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { launchPortfolio } from "@/lib/portfolios-mutations";

export default function LaunchControl({
  launchedAt,
  hasCurator,
  hasBuyer,
  publicPath,
}: {
  launchedAt: string | null;
  /** A curate-phase member (Shortlist Builder) is on the portfolio. */
  hasCurator: boolean;
  /** A trade-phase member (Buying Agent) is on the portfolio. */
  hasBuyer: boolean;
  /** Path to the portfolio's public page, surfaced as a link in the live state. */
  publicPath?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (launchedAt) {
    const since = new Date(launchedAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return (
      <div className="rounded-2xl border border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.05] px-5 py-4 sm:px-6 sm:py-5">
        <p className="text-[11px] font-mono uppercase tracking-[0.16em] text-[var(--color-green)] flex items-center gap-2">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-[var(--color-green)] animate-pulse"
            style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
          />
          Live since {since}
        </p>
        <p className="mt-2 text-sm text-text-dim leading-relaxed">
          Your portfolio is trading. Its agents rebalance the shared $1M book
          each weekly heartbeat, working to your mandate.
        </p>
        {publicPath && (
          <Link
            href={publicPath}
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-cyan)] hover:brightness-110 transition-[filter] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/40 rounded"
          >
            View public page &rarr;
          </Link>
        )}
      </div>
    );
  }

  const ready = hasCurator && hasBuyer;

  function launch() {
    setError(null);
    startTransition(async () => {
      const result = await launchPortfolio();
      if (!result.ok) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      router.refresh();
    });
  }

  if (!ready) {
    return (
      <div className="rounded-2xl border border-[var(--color-orange)]/30 bg-[var(--color-orange)]/[0.05] px-5 py-4 sm:px-6 sm:py-5">
        <p className="text-[11px] font-mono font-bold text-[var(--color-orange)] uppercase tracking-[0.14em] mb-2">
          Not ready to launch
        </p>
        <ul className="space-y-1 text-[13px] text-text-dim font-mono">
          <li className={hasCurator ? "text-text-muted" : ""}>
            {hasCurator ? "✓" : "○"} Shortlist Builder added
          </li>
          <li className={hasBuyer ? "text-text-muted" : ""}>
            {hasBuyer ? "✓" : "○"} Buying Agent added
          </li>
        </ul>
        <p className="mt-3 text-xs text-text-muted leading-relaxed">
          Add a Shortlist Builder and a Buying Agent above before going live.
        </p>
      </div>
    );
  }

  return (
    <div>
      {!confirming ? (
        <>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center px-5 py-2.5 rounded-lg bg-[var(--color-cyan)] text-bg text-sm font-semibold tracking-tight transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            style={{
              boxShadow:
                "0 10px 30px -10px rgba(0,242,255,0.5), inset 0 1px 0 rgba(255,255,255,0.45)",
            }}
          >
            Go live &rarr;
          </button>
          <p className="mt-2 text-xs text-text-muted leading-relaxed">
            Grants the portfolio $1M of paper cash; agents start trading at the
            next heartbeat.
          </p>
        </>
      ) : (
        <div className="rounded-2xl border border-[var(--color-orange)]/30 bg-[var(--color-orange)]/[0.05] px-5 py-4">
          <p className="text-xs font-mono text-[var(--color-orange)] leading-relaxed">
            Going live grants $1M and starts trading — this can&apos;t be undone.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={launch}
              disabled={pending}
              className="inline-flex items-center px-5 py-2.5 rounded-lg bg-[var(--color-cyan)] text-bg text-sm font-semibold tracking-tight transition-[filter] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              style={{
                boxShadow:
                  "0 10px 30px -10px rgba(0,242,255,0.5), inset 0 1px 0 rgba(255,255,255,0.45)",
              }}
            >
              {pending ? "Launching…" : "Confirm — go live"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="text-xs font-mono text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 rounded px-1 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 text-sm text-[var(--color-red)] font-mono border-l-2 border-[var(--color-red)] pl-3 py-1">
          {error}
        </div>
      )}
    </div>
  );
}
