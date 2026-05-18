"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  addToWatchlist,
  removeFromWatchlist,
  type ActionResult,
} from "@/lib/watchlist-mutations";
import type { WatchlistItem } from "@/lib/watchlist-query";

const ADD_KEY = "__add__";

export default function WatchlistManager({
  items,
}: {
  items: WatchlistItem[];
}) {
  const router = useRouter();
  const [ticker, setTicker] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Holds the key currently mid-action: ADD_KEY for the add form, or a
  // ticker for a remove. Drives per-control disabled state.
  const [pending, setPending] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function runAction(
    key: string,
    fn: () => Promise<ActionResult>,
    onOk?: () => void,
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
      onOk?.();
      router.refresh();
    });
  }

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim()) return;
    runAction(
      ADD_KEY,
      () => addToWatchlist({ ticker, rationale: note }),
      () => {
        setTicker("");
        setNote("");
      },
    );
  }

  return (
    <div className="space-y-5">
      <form
        onSubmit={onAdd}
        className="glass-card rounded-lg border border-border p-5"
      >
        <p className="text-xs font-mono uppercase tracking-widest text-text-dim mb-3">
          Add an equity
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="Ticker"
            aria-label="Ticker symbol"
            maxLength={12}
            className="sm:w-32 bg-bg border border-border rounded px-3 py-2 font-mono text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note — why you're watching it (optional)"
            aria-label="Note"
            maxLength={280}
            className="flex-1 bg-bg border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
          />
          <button
            type="submit"
            disabled={pending === ADD_KEY || !ticker.trim()}
            className="shrink-0 px-4 py-2 font-mono text-[11px] uppercase tracking-widest rounded border border-green/40 text-green hover:bg-green/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending === ADD_KEY ? "…" : "Add"}
          </button>
        </div>
      </form>

      {error && (
        <div className="text-sm text-red font-mono border-l-2 border-red pl-3 py-1">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="glass-card rounded-lg border border-border p-6">
          <p className="text-sm text-text-dim leading-relaxed">
            Your watchlist is empty. Add equities above to build a shortlist —
            agents on this portfolio will be able to populate the list and
            trade from it.
          </p>
        </div>
      ) : (
        <div className="glass-card rounded-lg border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-xs font-mono uppercase tracking-widest text-text-dim">
              {items.length} {items.length === 1 ? "equity" : "equities"}
            </p>
          </div>
          <ul className="divide-y divide-border">
            {items.map((it) => (
              <li
                key={it.ticker}
                className="flex items-start justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/company/${encodeURIComponent(it.ticker)}`}
                      className="font-mono text-sm font-bold text-green hover:underline decoration-1 underline-offset-[3px]"
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
                      removeFromWatchlist({ ticker: it.ticker }),
                    )
                  }
                  disabled={pending === it.ticker}
                  aria-label={`Remove ${it.ticker} from watchlist`}
                  className="shrink-0 text-text-muted hover:text-red disabled:opacity-50 text-lg leading-none px-1"
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
    <span className="text-[9px] font-mono uppercase tracking-widest text-text-muted border border-border rounded px-1 py-0.5">
      {label}
    </span>
  );
}
