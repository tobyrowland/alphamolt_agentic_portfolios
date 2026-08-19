"use client";

import { useEffect, useRef } from "react";

/**
 * The commitment for a whole split, in one place.
 *
 * It used to render inside whichever strategy card was last typed into, which
 * was fine for two strategies and wrong for five: one decision, drawn inside
 * one of several changed things, with the other changes scrolled off screen.
 * Rebalancing an account is a single act, so it gets a single bar — pinned to
 * the bottom while the edit is live, naming the total that moves.
 *
 * The bar itself only opens the review. The dialog is where the money is
 * described leg by leg and the second, explicit confirm lives — the same
 * two-step discipline every real-money control on this page uses, even though
 * a split places no orders at all.
 */

export type MovePreview = {
  fromName: string;
  toName: string;
  amount: number;
  cash: number;
  positions: number;
};

export default function SplitCommandBar({
  moves,
  total,
  disabled,
  reviewing,
  error,
  onReview,
  onCancel,
  onReset,
  onApply,
}: {
  moves: MovePreview[];
  /** Sum of everything that moves. */
  total: number;
  disabled: boolean;
  reviewing: boolean;
  error: string | null;
  onReview: () => void;
  onCancel: () => void;
  onReset: () => void;
  onApply: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Native <dialog> gives focus trapping, Escape and inert-background for
  // free — worth more here than a hand-rolled overlay.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (reviewing && !el.open) el.showModal();
    if (!reviewing && el.open) el.close();
  }, [reviewing]);

  const strategies = new Set([
    ...moves.map((m) => m.fromName),
    ...moves.map((m) => m.toName),
  ]).size;

  return (
    <>
      <div className="sticky bottom-0 z-20 -mx-4 mt-3 border-t border-amber-400/30 bg-[#0A0A0A]/95 px-4 py-2.5 backdrop-blur-sm supports-[backdrop-filter]:bg-[#0A0A0A]/80">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-[12.5px] leading-snug text-amber-200">
            <span className="font-semibold">Not applied yet.</span>{" "}
            <span className="font-mono tabular-nums">${fmt(total)}</span> moves
            between {strategies} {strategies === 1 ? "strategy" : "strategies"}.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onReset}
              disabled={disabled}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12.5px] text-text-muted transition-colors hover:text-text disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={onReview}
              disabled={disabled}
              className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-3.5 py-1.5 text-[12.5px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {disabled ? "Applying…" : "Review & apply split"}
            </button>
          </div>
        </div>
        {error && (
          <p
            role="alert"
            className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-[var(--color-red,#FF3333)]"
          >
            {error}
          </p>
        )}
      </div>

      <dialog
        ref={dialogRef}
        onCancel={(e) => {
          e.preventDefault();
          onCancel();
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current) onCancel();
        }}
        aria-labelledby="split-review-title"
        className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-white/15 bg-[#111111] p-0 text-text backdrop:bg-black/70"
      >
        <div className="px-5 py-4">
          <h2
            id="split-review-title"
            className="text-[15px] font-semibold text-text"
          >
            Apply this split?
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {moves.map((m, i) => (
              <li key={i} className="text-[13px] leading-relaxed text-text-dim">
                <span className="font-mono font-semibold tabular-nums text-text">
                  ${fmt(m.amount)}
                </span>{" "}
                {m.fromName} <span className="text-text-muted">→</span> {m.toName}
                {m.positions > 0.005 && (
                  <span className="mt-0.5 block text-[12px] text-amber-200">
                    ${fmt(m.cash)} cash + ${fmt(m.positions)} as positions —{" "}
                    {m.toName} trades them into its own picks on its next sync.
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11.5px] leading-relaxed text-text-muted">
            This re-attributes the shared broker account&apos;s records. It
            places no orders.
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={onApply}
              disabled={disabled}
              className="rounded border border-[var(--color-red,#FF3333)]/50 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-widest text-[var(--color-red,#FF3333)] transition-colors hover:bg-[var(--color-red,#FF3333)]/10 disabled:opacity-40"
            >
              {disabled ? "Applying…" : "Yes — apply"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={disabled}
              className="rounded border border-white/15 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-widest text-text-muted transition-colors hover:text-text disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
