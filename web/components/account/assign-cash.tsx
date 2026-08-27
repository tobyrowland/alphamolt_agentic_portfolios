"use client";

import { useState } from "react";

/**
 * Assign unassigned account cash to a strategy — beside the figure it spends.
 *
 * The pot is a property of the ACCOUNT: one balance, shown once, at the top of
 * the hub. The only way to draw on it, though, was the Credit box inside a
 * strategy card, two disclosures down — so the owner read "unassigned
 * $12,149.18", found no way to act on it there, and asked where the money was.
 *
 * Putting the control beside the number also fixes the arithmetic problem with
 * the alternative. Repeating the pot's balance inside every strategy card shows
 * one quantity N times and still hides the action; a single account-level
 * control names the destination instead, which is the thing that actually
 * varies.
 *
 * "Assign", not "Credit": the figure it draws down is called "unassigned", and
 * two words for one operation is what sent the owner looking in the first
 * place. The per-strategy Debit stays where it is — returning money is a
 * property of the strategy holding it, not of the pot.
 */
export default function AssignCash({
  unallocated,
  strategies,
  disabled,
  onAssign,
}: {
  unallocated: number | null;
  strategies: { portfolioId: string; displayName: string }[];
  disabled: boolean;
  onAssign: (portfolioId: string, amount: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(strategies[0]?.portfolioId ?? "");
  const [raw, setRaw] = useState("");

  // Nothing to draw on, or nowhere to put it: render no affordance rather than
  // a control that can only refuse.
  if (unallocated == null || unallocated <= 0 || strategies.length === 0) {
    return null;
  }

  const amount = Number(raw);
  const valid = Number.isFinite(amount) && amount > 0 && amount <= unallocated;
  const over = Number.isFinite(amount) && amount > unallocated;

  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-2 align-baseline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        className="rounded border border-white/[0.18] px-2 py-0.5 font-sans text-[11.5px] font-medium text-text-dim transition-colors hover:border-white/35 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        {open ? "Cancel" : "Assign"}
      </button>

      {open && (
        <form
          className="inline-flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onAssign(target, amount);
            setRaw("");
            setOpen(false);
          }}
        >
          <input
            type="number"
            min="0.01"
            max={unallocated}
            step="0.01"
            inputMode="decimal"
            placeholder="0.00"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            disabled={disabled}
            aria-label="Amount to assign"
            className="w-24 rounded border border-white/[0.12] bg-transparent px-2 py-0.5 font-mono text-[12px] tabular-nums text-text placeholder:text-text-muted focus:border-white/35 focus:outline-none"
          />
          <span className="font-sans text-[11.5px] text-text-muted">to</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={disabled}
            aria-label="Strategy to assign to"
            className="rounded border border-white/[0.12] bg-transparent px-2 py-0.5 font-sans text-[11.5px] text-text focus:border-white/35 focus:outline-none"
          >
            {strategies.map((s) => (
              <option key={s.portfolioId} value={s.portfolioId} className="bg-black">
                {s.displayName}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={disabled || !valid}
            className="rounded border border-white/[0.18] px-2 py-0.5 font-sans text-[11.5px] font-medium text-text-dim transition-colors hover:border-white/35 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            Confirm
          </button>
          {/* Stated before submitting: the server refuses an over-large credit,
              and a refusal after typing is worse than a ceiling shown up front. */}
          {over && (
            <span className="font-sans text-[11px] text-[var(--color-orange)]">
              more than is unassigned
            </span>
          )}
        </form>
      )}
    </span>
  );
}
