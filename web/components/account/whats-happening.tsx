"use client";

import { useState } from "react";
import type { HubLine, HubState, HubTone } from "@/lib/live-activity";

/**
 * "What's happening" — the panel that answers *is anything pending?* without
 * making the reader infer it from silence.
 *
 * The old hub had no notion of state over time: a dispatched sync left no
 * trace, money moves were hidden behind an "Advanced" fold, and a strategy
 * sitting at $0 looked identical whether a transfer was in flight or had never
 * been attempted. So this panel always renders, always says something, and its
 * quiet state is an explicit sentence rather than an empty space.
 *
 * All wording is decided by `buildHubState` (pure + fixture-tested); this
 * component only paints it.
 */

const TONE_STYLES: Record<HubTone, { border: string; text: string; dot: string }> =
  {
    good: {
      border: "border-[var(--color-green,#00FF41)]/30",
      text: "text-text",
      dot: "bg-[var(--color-green,#00FF41)]",
    },
    working: {
      border: "border-[var(--color-cyan,#00F2FF)]/35",
      text: "text-text",
      dot: "bg-[var(--color-cyan,#00F2FF)]",
    },
    warn: {
      border: "border-amber-400/40",
      text: "text-amber-200",
      dot: "bg-amber-400",
    },
    danger: {
      border: "border-[var(--color-red,#FF3333)]/45",
      text: "text-[var(--color-red,#FF3333)]",
      dot: "bg-[var(--color-red,#FF3333)]",
    },
    muted: {
      border: "border-white/10",
      text: "text-text-dim",
      dot: "bg-text-muted",
    },
  };

export default function WhatsHappening({
  state,
  onSync,
  syncing,
}: {
  state: HubState;
  /** Runs a sync for the strategy a line points at. */
  onSync?: (portfolioId: string) => void;
  syncing?: boolean;
}) {
  const working = state.lines.some((l) => l.tone === "working");
  return (
    <section
      aria-label="What's happening"
      aria-live="polite"
      className="mt-4 rounded-xl border border-white/10 bg-black/20 px-3.5 py-3"
    >
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            TONE_STYLES[state.tone].dot
          } ${working ? "animate-pulse" : ""}`}
        />
        <p className="text-[13px] leading-relaxed text-text">
          {state.headline}
        </p>
      </div>

      {state.lines.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1.5">
          {state.lines.map((l) => (
            <Line key={l.id} line={l} onSync={onSync} syncing={syncing} />
          ))}
        </ul>
      )}

      {state.recent.length > 0 && (
        <div className="mt-3 border-t border-white/[0.07] pt-2">
          <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">
            Already happened
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {state.recent.map((l) => (
              <li key={l.id} className="text-[12px] leading-relaxed text-text-dim">
                {l.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-2.5 text-[11px] text-text-muted">{state.nextRunLabel}</p>
    </section>
  );
}

function Line({
  line,
  onSync,
  syncing,
}: {
  line: HubLine;
  onSync?: (portfolioId: string) => void;
  syncing?: boolean;
}) {
  const style = TONE_STYLES[line.tone];
  // Two-step, like every other control that spends real money: the first
  // click only arms the confirm.
  const [confirming, setConfirming] = useState(false);
  return (
    <li
      className={`rounded-lg border ${style.border} bg-white/[0.02] px-3 py-1.5 text-[12.5px] leading-relaxed ${style.text}`}
    >
      {line.text}
      {line.offerSync && line.portfolioId && onSync && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={syncing}
          className="ml-2 whitespace-nowrap rounded border border-[var(--color-cyan,#00F2FF)]/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-cyan,#00F2FF)] transition-colors hover:bg-[var(--color-cyan,#00F2FF)]/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {syncing ? "Starting…" : "Do it now"}
        </button>
      )}
      {confirming && line.portfolioId && onSync && (
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-text-dim">
            This places real orders on your broker account.
          </span>
          <button
            type="button"
            onClick={() => {
              onSync(line.portfolioId as string);
              setConfirming(false);
            }}
            disabled={syncing}
            className="whitespace-nowrap rounded border border-[var(--color-red,#FF3333)]/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-red,#FF3333)] transition-colors hover:bg-[var(--color-red,#FF3333)]/10 disabled:opacity-40"
          >
            Yes — sync now
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="whitespace-nowrap rounded border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-muted transition-colors hover:text-text"
          >
            Cancel
          </button>
        </span>
      )}
    </li>
  );
}
