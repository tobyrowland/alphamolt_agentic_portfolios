"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  removeFromWatchlist,
  type ActionResult,
} from "@/lib/watchlist-mutations";
import type { WatchlistItem } from "@/lib/watchlist-query";

export default function WatchlistManager({
  portfolioId,
  items,
}: {
  portfolioId: string;
  items: WatchlistItem[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // Holds the ticker currently mid-remove. Drives per-row disabled state.
  const [pending, setPending] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function runAction(
    key: string,
    fn: () => Promise<ActionResult>,
  ) {
    setError(null);
    setPending(key);
    startTransition(async () => {
      const result = await fn();
      setPending(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="text-sm text-[var(--color-red)] font-mono border-l-2 border-[var(--color-red)] pl-3 py-1">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8">
          <p className="text-sm text-text-muted leading-relaxed">
            Your watchlist is empty. The Shortlist Builder agent on this
            portfolio will populate the list — once it has, the Buying Agent
            trades from it.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <div className="px-5 py-3 border-b border-white/[0.06]">
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
              {items.length} {items.length === 1 ? "equity" : "equities"}
            </p>
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {items.map((it) => (
              <li
                key={it.ticker}
                className="flex items-start justify-between gap-3 px-5 py-4 hover:bg-white/[0.025] transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/company/${encodeURIComponent(it.ticker)}`}
                      className="font-mono text-sm font-bold text-text hover:text-[var(--color-cyan)] hover:underline decoration-1 underline-offset-[3px] transition-colors"
                    >
                      {it.ticker}
                    </Link>
                    {it.company_name && (
                      <span className="text-xs text-text-muted truncate max-w-[280px]">
                        {it.company_name}
                      </span>
                    )}
                    <SourceBadge source={it.source} />
                    {it.status && (
                      <span className="text-[10px] font-mono text-text-muted">
                        {it.status}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-text-muted">
                    {it.sector && <span>{it.sector}</span>}
                    {it.composite_score != null && (
                      <span>Score {it.composite_score.toFixed(1)}</span>
                    )}
                    {it.price != null && (
                      <span>
                        $
                        {it.price.toLocaleString("en-US", {
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    )}
                  </div>
                  {it.rationale && (
                    <p className="mt-1.5 text-sm text-text-dim leading-relaxed">
                      {it.rationale}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    runAction(it.ticker, () =>
                      removeFromWatchlist({ portfolioId, ticker: it.ticker }),
                    )
                  }
                  disabled={pending === it.ticker}
                  aria-label={`Remove ${it.ticker} from watchlist`}
                  className="shrink-0 text-text-muted hover:text-[var(--color-red)] disabled:opacity-50 text-lg leading-none px-1 transition-colors"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SourceBadge({ source }: { source: "user" | "agent" }) {
  const label = source === "agent" ? "Agent" : "You";
  return (
    <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-text-muted border border-white/10 rounded px-1 py-0.5">
      {label}
    </span>
  );
}
