"use client";

import { useState } from "react";
import type { HubLine, HubState, HubTone } from "@/lib/live-activity";

/**
 * The execution spine — one place that answers "what happened, what's
 * outstanding, and when does it next run?".
 *
 * It replaces a status panel that said each of those things in a different
 * register, plus a warning block repeated on every affected strategy's card.
 * The owner was reading the same sentence three times and still had to
 * assemble the sequence themselves, because the three tenses were never
 * presented as one.
 *
 * Everything here is arranged by TIME, and every sentence still comes from
 * `buildHubState` (pure, fixture-pinned) — this component sorts and paints,
 * it never writes copy. Sorting is by `HubLine.kind`, never by matching the
 * text, so the copy contract stays free to change.
 *
 * Colour discipline: green means a gain and red means a loss or a refusal,
 * nowhere else. Outstanding work is amber, in-flight is a pulsing neutral,
 * and anything already settled is muted.
 */

const TONE: Record<HubTone, { dot: string; text: string; edge: string }> = {
  good: { dot: "bg-text-dim", text: "text-text-dim", edge: "border-white/10" },
  working: { dot: "bg-text", text: "text-text", edge: "border-white/25" },
  warn: { dot: "bg-amber-400", text: "text-amber-200", edge: "border-amber-400/40" },
  danger: {
    dot: "bg-[var(--color-red,#FF3333)]",
    text: "text-[var(--color-red,#FF3333)]",
    edge: "border-[var(--color-red,#FF3333)]/45",
  },
  muted: { dot: "bg-text-muted", text: "text-text-dim", edge: "border-white/10" },
};

export default function ExecutionTimeline({
  state,
  onSync,
  syncing,
}: {
  state: HubState;
  /** Runs a sync for the strategy a line points at. */
  onSync?: (portfolioId: string) => void;
  syncing?: boolean;
}) {
  // Past = what a run did. Present = everything still outstanding.
  const past = state.lines.filter((l) => l.kind === "run");
  const now = state.lines.filter((l) => l.kind !== "run");
  const working = now.some((l) => l.tone === "working");

  return (
    <section
      aria-label="Execution"
      aria-live="polite"
      className="mt-4 border-t border-white/[0.07] pt-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
        Execution
      </p>

      <ol className="mt-2.5 flex flex-col">
        <Step
          when="Last run"
          markerClass={past[0] ? TONE[past[0].tone].dot : "bg-white/15"}
        >
          {past.length > 0 ? (
            past.map((l) => (
              <p key={l.id} className={`text-[12.5px] leading-relaxed ${TONE[l.tone].text}`}>
                {l.text}
              </p>
            ))
          ) : (
            <p className="text-[12.5px] leading-relaxed text-text-muted">
              No run in the last 24 hours.
            </p>
          )}
          {state.recent.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {state.recent.slice(0, 4).map((l) => (
                <li key={l.id} className="text-[11.5px] leading-relaxed text-text-muted">
                  {l.text}
                </li>
              ))}
            </ul>
          )}
        </Step>

        <Step
          when="Now"
          markerClass={`${now.length > 0 ? TONE[worst(now)].dot : "bg-white/15"} ${
            working ? "animate-pulse" : ""
          }`}
        >
          {now.length === 0 ? (
            <p className="text-[12.5px] leading-relaxed text-text-dim">{state.headline}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {now.map((l) => (
                <Outstanding key={l.id} line={l} onSync={onSync} syncing={syncing} />
              ))}
            </ul>
          )}
        </Step>

        <Step when="Next run" markerClass="bg-white/15" last>
          <p className="text-[12.5px] leading-relaxed text-text-muted">
            {state.nextRunLabel.replace(/^Next scheduled run:\s*/, "")}
            <span className="mx-1.5 text-text-muted/60">·</span>
            trades whatever the swarm changed overnight
          </p>
        </Step>
      </ol>
    </section>
  );
}

/** One tense on the spine: a marker, a rule down to the next, and its content. */
function Step({
  when,
  markerClass,
  last,
  children,
}: {
  when: string;
  markerClass: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[10px_minmax(0,1fr)] gap-x-3">
      <div className="flex flex-col items-center">
        <span aria-hidden className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${markerClass}`} />
        {!last && <span aria-hidden className="w-px flex-1 bg-white/[0.09]" />}
      </div>
      <div className={last ? "pb-0.5" : "pb-3"}>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
          {when}
        </p>
        <div className="mt-1 flex flex-col gap-1">{children}</div>
      </div>
    </li>
  );
}

/**
 * An outstanding item. Where the fix is a sync, the button is right on it —
 * with the same two-step confirm every real-order control uses, because this
 * one places real orders too.
 */
function Outstanding({
  line,
  onSync,
  syncing,
}: {
  line: HubLine;
  onSync?: (portfolioId: string) => void;
  syncing?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const tone = TONE[line.tone];
  const canSync = line.offerSync && line.portfolioId && onSync;

  return (
    <li className={`rounded-md border-l-2 ${tone.edge} bg-white/[0.02] py-1 pl-2.5 pr-2`}>
      <p className={`text-[12.5px] leading-relaxed ${tone.text}`}>{line.text}</p>
      {canSync && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={syncing}
          className="mt-1 rounded border border-white/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-dim transition-colors hover:border-white/35 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          {syncing ? "Starting…" : "Sync now"}
        </button>
      )}
      {canSync && confirming && (
        <span className="mt-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-text-dim">
            This places real orders on your broker account.
          </span>
          <button
            type="button"
            onClick={() => {
              onSync?.(line.portfolioId as string);
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

const RANK: Record<HubTone, number> = {
  danger: 5,
  warn: 4,
  working: 3,
  good: 2,
  muted: 1,
};

function worst(lines: HubLine[]): HubTone {
  let out: HubTone = "muted";
  for (const l of lines) if (RANK[l.tone] > RANK[out]) out = l.tone;
  return out;
}
