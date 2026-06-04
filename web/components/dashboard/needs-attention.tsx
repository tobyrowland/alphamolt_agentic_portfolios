"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export interface AttentionItem {
  id: string; // stable key for dismissal
  urgency: "high" | "med" | "low";
  text: string;
  href: string;
  actionLabel: string;
}

const STORAGE_KEY = "alphamolt:dashboard:dismissed";

const URGENCY: Record<AttentionItem["urgency"], string> = {
  high: "border-[var(--color-red,#FF3333)]/40 text-[var(--color-red,#FF3333)]",
  med: "border-[var(--color-orange,#FF9900)]/40 text-[var(--color-orange,#FF9900)]",
  low: "border-white/15 text-text-muted",
};

/**
 * Needs attention (dashboard brief §3): state-derived, sparse, one action each,
 * dismissible. The system surfaces what wants a decision — this is NOT a to-do
 * list. Dismissal is per-item, persisted client-side (this is a private page).
 */
export default function NeedsAttention({ items }: { items: AttentionItem[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setDismissed(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
  }, []);

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const visible = items.filter((i) => !dismissed.has(i.id)).slice(0, 5);
  if (visible.length === 0) return null;

  return (
    <section aria-label="Needs attention" className="space-y-2">
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim">
        Needs attention
      </h2>
      <ul className="space-y-2">
        {visible.map((i) => (
          <li
            key={i.id}
            className={`flex items-center gap-3 rounded-lg border bg-white/[0.02] px-3 py-2 ${URGENCY[i.urgency]}`}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-current shrink-0"
            />
            <span className="text-sm text-text flex-1">{i.text}</span>
            <Link
              href={i.href}
              className="text-xs font-mono underline whitespace-nowrap hover:opacity-80"
            >
              {i.actionLabel} →
            </Link>
            <button
              type="button"
              onClick={() => dismiss(i.id)}
              aria-label="Dismiss"
              className="text-text-muted hover:text-text text-xs px-1"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
