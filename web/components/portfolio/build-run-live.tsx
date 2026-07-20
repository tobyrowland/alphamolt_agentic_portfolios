"use client";

/**
 * Live "build run" panel — the party around a Run-now dispatch.
 *
 * When a member card dispatches a run (team-builder emits
 * `alphamolt:run-dispatched`), this panel wakes up and turns the wait into a
 * show: an elapsed clock against the ~5-min typical runtime, a rotating
 * status line while the workflow spins up, then the agent's actual decisions
 * streaming in one by one (PASS / BUY / SELL, straight from the activity
 * feed), bought tickers popping in as chips, and a confetti finale when the
 * run journal lands — at which point the page refreshes so the real holdings
 * list picks up the new positions.
 *
 * No new backend: it polls the existing owner-gated
 * `/api/portfolios/<slug>/activity` route (heartbeats + trades + the private
 * pass list) every few seconds and shows only events that weren't in the feed
 * when the run started. Everything rendered is a real recorded decision — the
 * only theatre is the warm-up chatter, which is generic by design (the
 * workflow hasn't produced anything to report yet).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface ActivityEvent {
  id: string;
  at: string;
  tag: string; // "RAN" | "BUY" | "SELL" | "PASS" | "ERROR"
  tone: "positive" | "negative" | "neutral" | "info";
  title: string;
  detail?: string;
}

interface RunSession {
  startedAt: number; // Date.now() at dispatch
  expect: number; // how many member runs (RAN/ERROR journals) end the party
  agentName: string;
}

const POLL_MS = 4000;
const TYPICAL_MS = 5 * 60_000; // the honest "typically ~5 min" yardstick
const TIMEOUT_MS = 12 * 60_000; // stop polling — point at the Activity log
const STORAGE_PREFIX = "alphamolt-run-party:";
/** Resume-after-reload has no baseline snapshot — fall back to a timestamp
 *  cut with a buffer for client-vs-DB clock skew. */
const RESUME_SKEW_MS = 60_000;

export const RUN_DISPATCHED_EVENT = "alphamolt:run-dispatched";

/** Warm-up chatter — rotates until the first real event lands. Generic on
 *  purpose: the workflow is queueing/booting and hasn't recorded anything. */
const WARMUP_LINES = [
  "Dispatching the workflow to GitHub Actions…",
  "Booting the run — pulling your saved universe…",
  "Re-ranking candidates on today's facts…",
  "Warming up the model…",
  "Reading research cards for the top names…",
  "Weighing candidates against the brief…",
  "Checking recent developments on the shortlist…",
  "Crunching conviction scores…",
];

const CONFETTI_COLORS = ["#00FF41", "#00F2FF", "#FFD700", "#FF9900", "#EDEDED"];
const CONFETTI_COUNT = 36;

function storageKey(portfolioId: string): string {
  return `${STORAGE_PREFIX}${portfolioId}`;
}

/** Called by the dispatching button: persists the session (so a reload
 *  resumes the party) and wakes any mounted panel in this tab. */
export function announceRunDispatched(
  portfolioId: string,
  agentName: string,
  expect = 1,
): void {
  const session: RunSession = { startedAt: Date.now(), expect, agentName };
  try {
    sessionStorage.setItem(storageKey(portfolioId), JSON.stringify(session));
  } catch {
    // storage full/blocked — the event alone still starts the party
  }
  window.dispatchEvent(
    new CustomEvent(RUN_DISPATCHED_EVENT, {
      detail: { portfolioId, ...session },
    }),
  );
}

function parseSession(raw: string | null): RunSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<RunSession>;
    if (typeof s.startedAt !== "number") return null;
    return {
      startedAt: s.startedAt,
      expect: typeof s.expect === "number" && s.expect > 0 ? s.expect : 1,
      agentName: typeof s.agentName === "string" ? s.agentName : "Your agent",
    };
  } catch {
    return null;
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "Bought NVDA" / "Sold NVDA" / "Passed on NVDA" → the ticker. */
function tickerFromTitle(title: string): string | null {
  const m = title.match(/^(?:Bought|Sold|Passed on)\s+([A-Z0-9.\-]+)$/);
  return m ? m[1] : null;
}

type Phase = "running" | "done" | "error" | "timeout";

export default function BuildRunLive({
  portfolioId,
  slug,
}: {
  portfolioId: string;
  slug: string;
}) {
  const router = useRouter();
  const [session, setSession] = useState<RunSession | null>(null);
  const [phase, setPhase] = useState<Phase>("running");
  const [events, setEvents] = useState<ActivityEvent[]>([]); // oldest → newest
  const [now, setNow] = useState(() => Date.now());
  const [warmupIdx, setWarmupIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Event ids already in the feed at dispatch time — null while the baseline
  // snapshot is still loading, or when resuming (timestamp cut instead).
  const baselineRef = useRef<Set<string> | null>(null);
  const refreshedRef = useRef(false);

  const clearSession = useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey(portfolioId));
    } catch {
      /* ignore */
    }
  }, [portfolioId]);

  // ---- activation: dispatch event (fresh) or sessionStorage (reload) ------
  useEffect(() => {
    const resumed = parseSession(
      (() => {
        try {
          return sessionStorage.getItem(storageKey(portfolioId));
        } catch {
          return null;
        }
      })(),
    );
    if (resumed && Date.now() - resumed.startedAt < TIMEOUT_MS) {
      baselineRef.current = null; // resume: no snapshot — timestamp cut
      setSession(resumed);
    } else if (resumed) {
      clearSession();
    }

    function onDispatched(e: Event) {
      const detail = (e as CustomEvent).detail as
        | (RunSession & { portfolioId?: string })
        | undefined;
      if (!detail || detail.portfolioId !== portfolioId) return;
      baselineRef.current = null;
      refreshedRef.current = false;
      setEvents([]);
      setPhase("running");
      setDismissed(false);
      setSession({
        startedAt: detail.startedAt,
        expect: detail.expect,
        agentName: detail.agentName,
      });
      // Snapshot the current feed so only genuinely new events are shown —
      // immune to client-vs-server clock skew.
      fetch(`/api/portfolios/${slug}/activity`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { events?: ActivityEvent[] } | null) => {
          baselineRef.current = new Set(
            (data?.events ?? []).map((ev) => ev.id),
          );
        })
        .catch(() => {
          baselineRef.current = new Set(); // degrade to timestamp cut below
        });
    }
    window.addEventListener(RUN_DISPATCHED_EVENT, onDispatched);
    return () => window.removeEventListener(RUN_DISPATCHED_EVENT, onDispatched);
  }, [portfolioId, slug, clearSession]);

  // ---- ticking clock + warm-up chatter ------------------------------------
  useEffect(() => {
    if (!session || phase !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [session, phase]);

  useEffect(() => {
    if (!session || phase !== "running" || events.length > 0) return;
    const id = setInterval(
      () => setWarmupIdx((i) => (i + 1) % WARMUP_LINES.length),
      5000,
    );
    return () => clearInterval(id);
  }, [session, phase, events.length]);

  // ---- poll the activity feed ---------------------------------------------
  useEffect(() => {
    if (!session || phase !== "running") return;
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      if (Date.now() - session!.startedAt > TIMEOUT_MS) {
        setPhase("timeout");
        clearSession();
        return;
      }
      try {
        const res = await fetch(`/api/portfolios/${slug}/activity`);
        if (!res.ok) return;
        const data = (await res.json()) as { events?: ActivityEvent[] };
        const all = data.events ?? [];
        const baseline = baselineRef.current;
        const fresh = all
          .filter((ev) =>
            baseline
              ? !baseline.has(ev.id)
              : Date.parse(ev.at) >= session!.startedAt - RESUME_SKEW_MS,
          )
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        if (cancelled) return;
        setEvents(fresh);

        const finished = fresh.filter(
          (ev) => ev.tag === "RAN" || ev.tag === "ERROR",
        );
        if (finished.length >= session!.expect) {
          setPhase(finished.some((ev) => ev.tag === "ERROR") ? "error" : "done");
          clearSession();
        }
      } catch {
        // transient fetch failure — next tick retries
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session, phase, slug, clearSession]);

  // ---- finale: refresh the server-rendered holdings/trades ----------------
  useEffect(() => {
    if ((phase !== "done" && phase !== "error") || refreshedRef.current) return;
    refreshedRef.current = true;
    const id = setTimeout(() => router.refresh(), 1800);
    return () => clearTimeout(id);
  }, [phase, router]);

  if (!session || dismissed) return null;

  const elapsed = now - session.startedAt;
  const buys = events.filter((e) => e.tag === "BUY");
  const sells = events.filter((e) => e.tag === "SELL");
  const passes = events.filter((e) => e.tag === "PASS");
  const boughtTickers = [
    ...new Set(buys.map((e) => tickerFromTitle(e.title)).filter(Boolean)),
  ] as string[];
  const progress =
    phase === "running"
      ? Math.min(95, (elapsed / TYPICAL_MS) * 100)
      : 100;

  const statusLine =
    phase === "done"
      ? `Run complete in ${fmtElapsed(elapsed)} — ${buys.length} buy${buys.length === 1 ? "" : "s"}, ${sells.length ? `${sells.length} sell${sells.length === 1 ? "" : "s"}, ` : ""}${passes.length} pass${passes.length === 1 ? "" : "es"}.`
      : phase === "error"
        ? "The run hit an error — details below and in the Activity log."
        : phase === "timeout"
          ? "Still running — this one's taking longer than usual. Results will land in the Activity log."
          : events.length === 0
            ? WARMUP_LINES[warmupIdx]
            : `${session.agentName} is working the book…`;

  return (
    <section
      aria-label="Live agent run"
      className="relative mb-12 sm:mb-14 rounded-2xl border border-[var(--color-cyan)]/25 bg-[var(--color-cyan)]/[0.03] overflow-hidden"
    >
      {phase === "running" && <span className="scanline absolute inset-0" aria-hidden />}
      {phase === "done" && <Confetti />}

      {/* Header: who's running + the honest clock. */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            aria-hidden
            className={`h-2.5 w-2.5 rounded-full shrink-0 ${
              phase === "running"
                ? "bg-[var(--color-cyan)] animate-pulse"
                : phase === "done"
                  ? "bg-[var(--color-green)]"
                  : "bg-[var(--color-orange)]"
            }`}
          />
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text-dim truncate">
            {phase === "done" ? "🎉 " : ""}
            {session.agentName}
            {phase === "running" ? " · live run" : phase === "done" ? " · done" : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span
            className="font-mono text-[11px] text-text-muted tabular-nums"
            title="Elapsed — a run typically takes ~5 minutes"
          >
            T+{fmtElapsed(elapsed)}
            {phase === "running" && (
              <span className="text-text-muted/60"> / ~5:00 typical</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
              if (phase !== "running") clearSession();
            }}
            aria-label="Dismiss run panel"
            className="text-text-muted hover:text-text font-mono text-xs px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Progress toward the typical runtime — capped at 95% until the run
          journal actually lands, so the bar never lies. */}
      <div className="mx-4 sm:mx-5 mt-3 h-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${
            phase === "done"
              ? "bg-[var(--color-green)]"
              : phase === "error"
                ? "bg-[var(--color-red)]"
                : "bg-[var(--color-cyan)]"
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Status line + running tallies. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 sm:px-5 mt-3">
        <p
          aria-live="polite"
          className={`text-[13px] min-w-0 ${
            phase === "done" ? "text-[var(--color-green)]" : "text-text-dim"
          }`}
        >
          {statusLine}
        </p>
        {(buys.length > 0 || passes.length > 0 || sells.length > 0) && (
          <p className="font-mono text-[11px] text-text-muted tabular-nums shrink-0">
            <span className="text-[var(--color-green)]">{buys.length} bought</span>
            {sells.length > 0 && (
              <span className="text-[var(--color-red)]"> · {sells.length} sold</span>
            )}
            <span> · {passes.length} passed</span>
          </p>
        )}
      </div>

      {/* Bought tickers pop in one by one. */}
      {boughtTickers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 sm:px-5 mt-3">
          {boughtTickers.map((t, i) => (
            <span
              key={t}
              className="run-party-chip inline-block rounded-md border border-[var(--color-green)]/40 bg-[var(--color-green)]/10 px-2 py-0.5 font-mono text-[11px] font-bold text-[var(--color-green)]"
              // Chips in the same poll batch cascade instead of popping at once.
              style={{ animationDelay: `${Math.min(i * 0.12, 1.2)}s` }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* The decision feed — real recorded events, newest last, autoscrolled. */}
      {events.length > 0 && <DecisionFeed events={events} />}

      <div className="pb-4" />
    </section>
  );
}

function DecisionFeed({ events }: { events: ActivityEvent[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const count = events.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [count]);

  return (
    <div
      className="mx-4 sm:mx-5 mt-3 max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed"
      aria-live="polite"
    >
      {events.map((e, i) => (
        <p
          key={e.id}
          className="run-party-line whitespace-nowrap overflow-hidden text-ellipsis"
          // Lines arriving in one poll batch cascade in (keys are stable, so
          // already-rendered lines never re-animate on later polls).
          style={{ animationDelay: `${(i % 12) * 0.06}s` }}
        >
          <span
            className={
              e.tag === "BUY"
                ? "text-[var(--color-green)] font-bold"
                : e.tag === "SELL"
                  ? "text-[var(--color-red)] font-bold"
                  : e.tag === "ERROR"
                    ? "text-[var(--color-red)] font-bold"
                    : e.tag === "RAN"
                      ? "text-[var(--color-cyan)] font-bold"
                      : "text-text-muted"
            }
          >
            {e.tag}
          </span>
          <span className="text-text-dim"> {e.title}</span>
          {e.detail && <span className="text-text-muted"> — {e.detail}</span>}
        </p>
      ))}
      <div ref={endRef} />
    </div>
  );
}

/** A short, tasteful CSS confetti burst for the finale. Client-only (rendered
 *  after the done transition), so Math.random can't cause an SSR mismatch. */
function Confetti() {
  const pieces = Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
    left: `${(i * 97) % 100}%`,
    delay: `${(i % 9) * 0.12}s`,
    duration: `${1.6 + ((i * 31) % 10) / 10}s`,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    tilt: ((i * 53) % 60) - 30,
  }));
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="run-party-confetti absolute top-[-8px] h-2 w-1.5 rounded-[1px]"
          style={{
            left: p.left,
            background: p.color,
            animationDelay: p.delay,
            animationDuration: p.duration,
            transform: `rotate(${p.tilt}deg)`,
          }}
        />
      ))}
    </div>
  );
}
