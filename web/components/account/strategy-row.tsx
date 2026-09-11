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
 * The row reports; it does not move money. Every money movement is one verb
 * in the account-level move box, because moving between strategies and moving
 * to and from the unassigned pot are the same act — see web/lib/money-move.ts.
 *
 * What was here before:
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
      {["Worth", "Cash", "P&L", ""].map((h) => (
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
  meta,
  statusLine,
  disabled,
  paperOptions,
}: {
  sleeve: SleeveCash;
  color: string;
  /** What it runs today: allowance + holdings. */
  current: number;
  sharePct: number;
  meta?: StrategyMeta;
  /** The timeline's line about this strategy — reduced here to a health dot. */
  statusLine?: HubLine | null;
  disabled: boolean;
  paperOptions: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const down = meta?.pnlPct != null && meta.pnlPct < 0;

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

        <div className="flex items-center justify-end gap-2">
          {/* The verb that actually places orders belongs where it can be
              seen. It stays two-step and amber; only its resting state is a
              chip. */}
          <SyncLiveButton portfolioId={sleeve.portfolioId} compact />
          {/* With Sync on the row, the drawer holds only the book this
              strategy copies — so when there is no other book to pick, an
              expander would open an empty box. */}
          {paperOptions.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} controls for ${sleeve.displayName}`}
            className="rounded px-1.5 py-1 font-mono text-[11px] text-text-muted transition-colors hover:text-text"
          >
            {open ? "▾" : "▸"}
          </button>
          )}
        </div>
      </div>

      {/* Everything that isn't needed at a glance. */}
      {open && paperOptions.length > 0 && (
        <div className="mt-2 rounded-lg border border-white/[0.08] px-3 py-1 pb-3">
          <FollowTargetPicker
            portfolioId={sleeve.portfolioId}
            currentId={sleeve.followsPortfolioId}
            options={paperOptions}
          />
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

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
