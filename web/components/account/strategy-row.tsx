"use client";

import { useState } from "react";
import Link from "next/link";
import type { SleeveCash } from "@/lib/live-cash-query";
import type { HubLine } from "@/lib/live-activity";
import type { SleeveImpact } from "@/lib/sleeve-funding";
import FollowTargetPicker from "@/components/portfolio/follow-target-picker";
import SyncLiveButton from "@/components/portfolio/sync-live-button";

/**
 * One strategy on the shared broker account, as a row on a ledger rather than
 * a card in a stack.
 *
 * The card it replaces carried five facts on one middot-separated line, which
 * on a phone wrapped into a ribbon nobody could read, and repeated whatever
 * the status panel already said a few pixels above. Here the facts are
 * COLUMNS — aligned, tabular, comparable down the account — and everything
 * that isn't needed at a glance (sync, re-pointing, cash moves) is behind one
 * explicit disclosure per row.
 *
 * The only editable thing on the row is the share this strategy should run,
 * as a percentage. Dollars are the consequence and are shown as one, in the
 * impact line under the row.
 */

export type StrategyMeta = {
  pnlPct: number | null;
  numPositions: number;
  followsName: string | null;
};

/** Shared with RowHeader so the columns line up down the account. */
const COLS =
  "grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_7rem_6.5rem_5.5rem_8.5rem_1.5rem] sm:items-center";

export function RowHeader() {
  return (
    <li
      aria-hidden
      className={`${COLS} hidden border-b border-white/[0.07] px-3 pb-1.5 sm:grid`}
    >
      <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-text-muted">
        Strategy
      </span>
      {["Worth", "Cash", "P&L", "Should run"].map((h) => (
        <span
          key={h}
          className="text-right font-mono text-[9.5px] uppercase tracking-[0.14em] text-text-muted"
        >
          {h}
        </span>
      ))}
      <span />
    </li>
  );
}

export default function StrategyRow({
  sleeve,
  color,
  current,
  sharePct,
  targetPct,
  targetUsd,
  impact,
  pending,
  meta,
  statusLine,
  disabled,
  editable,
  paperOptions,
  onPct,
  onDebit,
}: {
  sleeve: SleeveCash;
  color: string;
  /** What it runs today: allowance + holdings. */
  current: number;
  sharePct: number;
  /** The proportion it SHOULD run, as a percentage string being edited. */
  targetPct: string;
  targetUsd: number;
  /** What applying would move, split into cash and share records. */
  impact: SleeveImpact | null;
  pending: boolean;
  meta?: StrategyMeta;
  /**
   * Can this share actually be changed? False for a sole strategy on the
   * account: it runs 100% by definition, so a stepper there is a control that
   * silently refuses every input.
   */
  editable: boolean;
  /** The timeline's line about this strategy — reduced here to a health dot. */
  statusLine?: HubLine | null;
  disabled: boolean;
  paperOptions: { id: string; name: string }[];
  onPct: (raw: string) => void;
  onDebit: (amount: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const down = meta?.pnlPct != null && meta.pnlPct < 0;
  const pct = Number(targetPct);
  const valid = Number.isFinite(pct) && pct >= 0 && pct <= 100;

  function nudge(step: number) {
    const base = valid ? pct : sharePct;
    onPct(String(Math.round(Math.min(100, Math.max(0, base + step)) * 100) / 100));
  }

  return (
    <li className="border-b border-white/[0.07] px-3 py-2.5 last:border-b-0">
      <div className={COLS}>
        {/* Identity + what it copies */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <Link
              href={`/portfolios/${sleeve.slug}`}
              className="truncate text-[14px] font-semibold text-text transition-colors hover:text-[var(--color-cyan,#00F2FF)]"
            >
              {sleeve.displayName}
            </Link>
            {statusLine && (
              <span
                title={statusLine.short ?? statusLine.text}
                aria-label={statusLine.short ?? statusLine.text}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  statusLine.tone === "danger"
                    ? "bg-[var(--color-red,#FF3333)]"
                    : statusLine.tone === "warn"
                      ? "bg-amber-400"
                      : "bg-text-muted"
                }`}
              />
            )}
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-text-muted">
            {sleeve.followsPortfolioId ? (
              <>copies {meta?.followsName ?? "your arena book"}</>
            ) : (
              <span className="text-amber-300">not linked to a strategy</span>
            )}
          </p>
        </div>

        <Cell label="Worth">
          <span className="font-mono text-[14px] font-semibold tabular-nums text-text">
            ${fmt(current)}
          </span>
          {/* A bare $0 reads as a transfer that got stuck somewhere, so an
              empty strategy always says which kind of empty it is. The full
              sentence stays in the timeline; this is the two-word version. */}
          {current < 0.01 ? (
            <span className="ml-1.5 text-[10.5px] text-text-muted">
              {sleeve.everFunded ? "empty" : "never funded"}
            </span>
          ) : (
            <span className="ml-1.5 font-mono text-[11px] tabular-nums text-text-muted">
              {sharePct.toFixed(0)}%
            </span>
          )}
        </Cell>

        <Cell label="Cash">
          <span className="font-mono text-[13px] tabular-nums text-text-dim">
            ${fmt(sleeve.allowance)}
          </span>
        </Cell>

        <Cell label="P&L">
          {meta?.pnlPct == null ? (
            <span className="font-mono text-[13px] text-text-muted">—</span>
          ) : (
            <span
              title="Measured against the money paid into this strategy. Deposits and transfers move that baseline, so they don't read as profit. Check it with live_cash.py --baselines."
              className="inline-flex cursor-help items-baseline rounded px-1.5 py-0.5 font-mono text-[12.5px] font-semibold tabular-nums"
              style={{
                color: down ? "var(--color-red,#FF3333)" : "var(--color-green,#00FF41)",
                background: down ? "rgba(255,51,51,0.10)" : "rgba(0,255,65,0.10)",
              }}
            >
              {down ? "−" : "+"}
              {Math.abs(meta.pnlPct).toFixed(2)}%
            </span>
          )}
        </Cell>

        {/* The only control on the row: the share it should run. */}
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <span className="font-mono text-[9.5px] uppercase tracking-wider text-text-muted sm:hidden">
            Should run
          </span>
          {!editable ? (
            <span
              className="font-mono text-[13px] tabular-nums text-text-muted"
              title="The only strategy on this account runs all of it"
            >
              100%
            </span>
          ) : (
          <span className="inline-flex items-center gap-1">
            <Stepper label={`Decrease ${sleeve.displayName}`} disabled={disabled} onClick={() => nudge(-1)}>
              −
            </Stepper>
            <span className="relative">
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                inputMode="decimal"
                value={targetPct}
                onChange={(e) => onPct(e.target.value)}
                disabled={disabled}
                aria-label={`Percentage of the account ${sleeve.displayName} should run`}
                className={`w-[4.5rem] rounded border bg-transparent py-1 pl-2 pr-5 text-right font-mono text-[13px] tabular-nums text-text focus:outline-none disabled:opacity-50 ${
                  valid
                    ? "border-white/[0.12] focus:border-white/35"
                    : "border-[var(--color-red,#FF3333)]/60"
                }`}
              />
              <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-text-muted">
                %
              </span>
            </span>
            <Stepper label={`Increase ${sleeve.displayName}`} disabled={disabled} onClick={() => nudge(1)}>
              +
            </Stepper>
          </span>
          )}
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} controls for ${sleeve.displayName}`}
            className="rounded px-1.5 py-1 font-mono text-[11px] text-text-muted transition-colors hover:text-text"
          >
            {open ? "▾" : "▸"}
          </button>
        </div>
      </div>

      {/* What applying would do to THIS strategy, in dollars. */}
      {pending && impact && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-amber-200">
          <span className="font-mono tabular-nums">
            → ${fmt(targetUsd)}
          </span>
          <span className="mx-1.5 text-text-muted/60">·</span>
          <span className="font-mono tabular-nums">
            {impact.delta >= 0 ? "+" : "−"}${fmt(Math.abs(impact.delta))}
          </span>
          {Math.abs(impact.positions) > 0.005 && (
            <span className="text-text-muted">
              {" "}
              (${fmt(Math.abs(impact.cash))} cash + ${fmt(Math.abs(impact.positions))} as
              positions{impact.delta > 0 ? ", traded into its own picks on its next sync" : ""})
            </span>
          )}
        </p>
      )}
      {pending && !impact && (
        <p className="mt-1.5 font-mono text-[11.5px] tabular-nums text-text-muted">
          → ${fmt(targetUsd)}
        </p>
      )}

      {/* Everything that isn't needed at a glance. */}
      {open && (
        <div className="mt-2 rounded-lg border border-white/[0.08] px-3 py-1 pb-3">
          <SyncLiveButton portfolioId={sleeve.portfolioId} />
          {paperOptions.length > 0 && (
            <FollowTargetPicker
              portfolioId={sleeve.portfolioId}
              currentId={sleeve.followsPortfolioId}
              options={paperOptions}
            />
          )}
          <div className="mt-4 flex flex-col gap-2 border-t border-white/10 pt-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
              Return cash
            </p>
            {/* Only the outbound half lives here. Assigning FROM the pot is an
                account-level act — it belongs beside the pot's balance, which
                is shown once at the top rather than repeated in every card.
                Returning money is a property of the strategy holding it. */}
            <AmountAction
              label="Debit"
              hint="this strategy → unassigned"
              disabled={disabled}
              onSubmit={onDebit}
            />
          </div>
        </div>
      )}
    </li>
  );
}

/** A numeric cell: labelled on mobile, right-aligned under its header on desktop. */
function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:block sm:text-right">
      <span className="font-mono text-[9.5px] uppercase tracking-wider text-text-muted sm:hidden">
        {label}
      </span>
      <span>{children}</span>
    </div>
  );
}

function Stepper({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="h-6 w-6 shrink-0 rounded border border-white/[0.12] font-mono text-[13px] leading-none text-text-muted transition-colors hover:border-white/30 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function AmountAction({
  label,
  hint,
  disabled,
  onSubmit,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onSubmit: (amount: number) => void;
}) {
  const [raw, setRaw] = useState("");
  const amount = Number(raw);
  const valid = Number.isFinite(amount) && amount > 0;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit(amount);
        setRaw("");
      }}
    >
      <input
        type="number"
        min="0.01"
        step="0.01"
        inputMode="decimal"
        placeholder="0.00"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        disabled={disabled}
        className="w-28 rounded border border-white/[0.12] bg-transparent px-2.5 py-1 font-mono text-[13px] tabular-nums text-text placeholder:text-text-muted focus:border-white/35 focus:outline-none disabled:opacity-50"
        aria-label={`${label} amount`}
      />
      <button
        type="submit"
        disabled={disabled || !valid}
        className="rounded border border-white/[0.12] px-3 py-1 text-[12.5px] font-medium text-text-dim transition-colors hover:border-white/25 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
      <span className="text-[11px] text-text-muted">{hint}</span>
    </form>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
