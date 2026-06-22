"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "@/lib/activity-query";

/**
 * The "Activity" slide-over (faith-in-the-system brief). A trigger button +
 * a right-hand drawer that lists what happened when — reused by both the
 * screener (pipeline refreshes) and the portfolio (team decisions + fills).
 *
 * It fetches its feed from `endpoint` once on mount (cheap, after paint, so
 * the ISR-cached SSR page is untouched) and tracks a "new since you last
 * looked" count in localStorage keyed by `storageKey`: the newest event's
 * timestamp the viewer has already seen. Opening the drawer marks everything
 * as seen.
 */
export default function ActivityDrawer({
  label,
  title,
  subtitle,
  endpoint,
  storageKey,
}: {
  /** Trigger button text. */
  label: string;
  /** Drawer heading. */
  title: string;
  /** Optional one-line explainer under the heading. */
  subtitle?: string;
  /** API route returning `{ events: ActivityEvent[] }`. */
  endpoint: string;
  /** localStorage key holding the newest-seen ISO timestamp. */
  storageKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const fetched = useRef(false);

  // Fetch once on mount and compute the "new" badge against the last-seen mark.
  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(endpoint, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { events?: ActivityEvent[] };
        if (cancelled) return;
        const list = json.events ?? [];
        setEvents(list);
        const newest = list[0]?.at ?? null;
        const seen = readSeen(storageKey);
        if (seen == null) {
          // First ever visit: establish a silent baseline so we don't flag the
          // entire backlog as "new".
          if (newest) writeSeen(storageKey, newest);
          setNewCount(0);
        } else {
          setNewCount(
            list.filter((e) => Date.parse(e.at) > Date.parse(seen)).length,
          );
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, storageKey]);

  const markSeen = useCallback(() => {
    const newest = events?.[0]?.at;
    if (newest) writeSeen(storageKey, newest);
    setNewCount(0);
  }, [events, storageKey]);

  const openDrawer = useCallback(() => {
    setOpen(true);
    markSeen();
  }, [markSeen]);

  // Esc to close + lock body scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={openDrawer}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted hover:text-text hover:border-white/20 transition-colors"
        title="See what's happened in the background"
      >
        <ClockGlyph />
        {label}
        {newCount > 0 && (
          <span
            className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-cyan)] px-1 text-[10px] font-bold text-black"
            aria-label={`${newCount} new`}
          >
            {newCount > 99 ? "99+" : newCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-[fadeIn_120ms_ease-out]"
            onClick={() => setOpen(false)}
          />
          {/* Panel */}
          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-[#0b0d10] border-l border-white/10 shadow-2xl flex flex-col animate-[slideIn_160ms_ease-out]">
            <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/10">
              <div>
                <h2 className="text-[13px] font-mono font-bold uppercase tracking-[0.14em] text-text">
                  {title}
                </h2>
                {subtitle && (
                  <p className="mt-1 text-[11px] font-mono text-text-muted leading-relaxed">
                    {subtitle}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="shrink-0 rounded-md p-1 text-text-muted hover:text-text hover:bg-white/10 transition-colors"
              >
                <CloseGlyph />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto">
              {error ? (
                <p className="px-5 py-6 text-sm text-text-muted">
                  Couldn&apos;t load activity right now.
                </p>
              ) : events == null ? (
                <p className="px-5 py-6 text-sm text-text-muted">Loading…</p>
              ) : events.length === 0 ? (
                <p className="px-5 py-6 text-sm text-text-muted">
                  No activity recorded yet — background jobs run on a daily and
                  weekly cadence, so check back soon.
                </p>
              ) : (
                <ul className="divide-y divide-white/[0.06]">
                  {events.map((e) => (
                    <EventRow key={e.id} event={e} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{keyframes}</style>
    </>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const stripe = toneColor(event.tone);
  return (
    <li className="pl-4 pr-5 py-3 flex flex-col gap-1" style={{ borderLeft: `3px solid ${stripe}` }}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-[0.1em]"
          style={{ color: stripe, backgroundColor: `${stripe}1a` }}
        >
          {event.tag}
        </span>
        <span className="text-sm font-semibold text-text">{event.title}</span>
        <span className="ml-auto text-[11px] font-mono text-text-muted whitespace-nowrap">
          {formatRelative(event.at)}
        </span>
      </div>
      {event.detail && (
        <p className="text-xs text-text-muted leading-relaxed">{event.detail}</p>
      )}
    </li>
  );
}

function toneColor(tone: ActivityEvent["tone"]): string {
  switch (tone) {
    case "positive":
      return "var(--color-green)";
    case "negative":
      return "var(--color-red)";
    case "info":
      return "var(--color-cyan)";
    default:
      return "rgba(255,255,255,0.28)";
  }
}

function readSeen(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSeen(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.max(0, Math.floor(diffMs / (1000 * 60)));
  return `${mins}m ago`;
}

const keyframes = `
@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }
`;

function ClockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
