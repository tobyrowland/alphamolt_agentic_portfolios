"use client";

/**
 * Small inline chip row that appends a short phrase to a mandate
 * textarea on click. Reused by the three mandate editors
 * (main, buy, sell) so users have ready-made phrases to drop into
 * an empty mandate or extend an existing one.
 *
 * Append semantics: if the textarea is empty, the chip text becomes
 * the whole content. Otherwise it's appended after a comma + space,
 * unless the existing content already ends with a sentence terminator
 * (".", ",", ";", "!", "?") in which case we just add a space.
 */

import { useCallback } from "react";

export interface MandateChipsProps {
  /** Label rendered above the chip row. */
  label?: string;
  /** Phrases to render as clickable chips. */
  chips: readonly string[];
  /** Current textarea value. */
  value: string;
  /** Set the textarea value (the parent's setter). */
  onChange: (next: string) => void;
}

export default function MandateChips({
  label = "Quick add",
  chips,
  value,
  onChange,
}: MandateChipsProps) {
  const append = useCallback(
    (phrase: string) => {
      const trimmed = value.trimEnd();
      if (!trimmed) {
        onChange(phrase);
        return;
      }
      const lastChar = trimmed[trimmed.length - 1] ?? "";
      const separator = ",.;!?".includes(lastChar) ? " " : ", ";
      onChange(`${trimmed}${separator}${phrase}`);
    },
    [value, onChange],
  );

  if (chips.length === 0) return null;

  return (
    <div className="mt-2">
      <p className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-1.5">
        {label}{" "}
        <span className="text-text-muted/60 normal-case font-mono">
          — click to insert
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((phrase) => (
          <button
            key={phrase}
            type="button"
            onClick={() => append(phrase)}
            className="rounded border border-white/10 bg-white/[0.02] px-2 py-1 font-mono text-[11px] text-text-dim hover:text-text hover:border-cyan/30 hover:bg-cyan/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 transition-colors"
          >
            + {phrase}
          </button>
        ))}
      </div>
    </div>
  );
}
