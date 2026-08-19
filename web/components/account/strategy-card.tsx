"use client";

import Link from "next/link";
import type { SleeveCash } from "@/lib/live-cash-query";
import type { HubLine } from "@/lib/live-activity";
import FollowTargetPicker from "@/components/portfolio/follow-target-picker";
import SyncLiveButton from "@/components/portfolio/sync-live-button";

/**
 * One strategy running on the shared broker account, as a single object on the
 * page: its own bordered card, colour-keyed to its segment of the split bar.
 *
 * It replaces a pair of bare table rows whose boundary was a hairline — with
 * two strategies stacked, there was no visual answer to "where does one end
 * and the next begin". Everything about a strategy now lives inside its own
 * frame: what it's worth, what that's made of, which book it follows, whether
 * anything is outstanding, and the box where you set what it should run.
 */

export type StrategyMeta = {
  pnlPct: number | null;
  numPositions: number;
  followsName: string | null;
};

export default function StrategyCard({
  sleeve,
  color,
  current,
  sharePct,
  meta,
  target,
  invalid,
  disabled,
  paperOptions,
  statusLine,
  pending,
  applySlot,
  onTarget,
}: {
  sleeve: SleeveCash;
  color: string;
  current: number;
  sharePct: number;
  meta?: StrategyMeta;
  target: string;
  invalid: boolean;
  disabled: boolean;
  paperOptions: { id: string; name: string }[];
  /** The "what's happening" line about this strategy, echoed on its card. */
  statusLine?: HubLine | null;
  /** This card's target differs from what the strategy currently runs. */
  pending?: boolean;
  /**
   * The apply/confirm controls for the split, rendered directly under this
   * card's target box. Only the card the owner last typed into gets them, so
   * the commitment sits where the decision was made rather than below every
   * card — but the split it applies is still the whole account's.
   */
  applySlot?: React.ReactNode;
  onTarget: (raw: string) => void;
}) {
  const targetNum = Number(target);
  const drift =
    Number.isFinite(targetNum) && Math.abs(targetNum - current) > 1
      ? Math.round((targetNum - current) * 100) / 100
      : 0;
  const down = meta?.pnlPct != null && meta.pnlPct < 0;

  return (
    <div
      className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3"
      style={{ borderLeft: `4px solid ${color}` }}
    >
      {/* Who, and what it's worth */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Link
          href={`/portfolios/${sleeve.slug}`}
          className="flex items-baseline gap-2 text-[15px] font-semibold text-text hover:text-[var(--color-green,#00FF41)] transition-colors"
        >
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 self-center rounded-full"
            style={{ background: color }}
          />
          {sleeve.displayName}
        </Link>
        <span className="font-mono text-[15px] font-semibold text-text">
          ${fmt(current)}
        </span>
      </div>

      {/* What that's made of */}
      <p className="mt-1 text-[12px] text-text-muted">
        {sharePct.toFixed(0)}% of the account
        <Sep />
        cash to spend{" "}
        <span className="font-mono text-text-dim">${fmt(sleeve.allowance)}</span>
        <Sep />
        positions{" "}
        <span className="font-mono text-text-dim">
          ${fmt(sleeve.holdingsValue)}
        </span>
        {meta && meta.numPositions > 0 && (
          <>
            <Sep />
            {meta.numPositions} name{meta.numPositions === 1 ? "" : "s"}
          </>
        )}
        {meta?.pnlPct != null && (
          <>
            <Sep />
            <span
              className="font-mono"
              style={{
                color: down
                  ? "var(--color-red,#FF3333)"
                  : "var(--color-green,#00FF41)",
              }}
            >
              {down ? "▼" : "▲"} {Math.abs(meta.pnlPct).toFixed(2)}%
            </span>{" "}
            <span
              title="Measured against the money paid into this strategy. Deposits and transfers move that baseline, so they don't read as profit. Check it with live_cash.py --baselines."
              className="underline decoration-dotted underline-offset-2"
            >
              since it started
            </span>
          </>
        )}
      </p>

      {/* Which strategy it copies */}
      <p className="mt-1 text-[12px] text-text-muted">
        {sleeve.followsPortfolioId ? (
          <>
            Copies{" "}
            <span className="text-text-dim">
              {meta?.followsName ?? "your arena book"}
            </span>
          </>
        ) : (
          <span className="text-amber-300">
            Not linked to a strategy — it will never buy anything
          </span>
        )}
      </p>

      {/* An empty strategy says why it's empty — a bare $0 row used to read
          as a transfer that had got stuck somewhere. */}
      {!statusLine && current < 0.01 && (
        <p className="mt-2 rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-text-dim">
          {sleeve.everFunded
            ? "Nothing to spend — give it a target below and apply."
            : "Never funded — no money has moved into it. Give it a target below and apply."}
        </p>
      )}

      {/* Anything outstanding for THIS strategy */}
      {statusLine && (
        <p
          className={`mt-2 rounded-lg border px-2.5 py-1.5 text-[12px] leading-relaxed ${
            statusLine.tone === "danger"
              ? "border-[var(--color-red,#FF3333)]/45 text-[var(--color-red,#FF3333)]"
              : statusLine.tone === "warn"
                ? "border-amber-400/40 text-amber-200"
                : "border-white/10 text-text-dim"
          }`}
        >
          {statusLine.short ?? statusLine.text}
        </p>
      )}

      {/* What it should run */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] pt-2.5">
        <label
          className="text-[12px] text-text-dim"
          htmlFor={`target-${sleeve.portfolioId}`}
        >
          Should run
        </label>
        <span className="inline-flex items-baseline gap-1.5">
          {drift !== 0 && (
            <span
              className={`font-mono text-[11px] ${
                drift > 0
                  ? "text-[var(--color-green,#00FF41)]"
                  : "text-text-muted"
              }`}
            >
              {drift > 0 ? "+" : "−"}${fmt(Math.abs(drift))}
            </span>
          )}
          {pending && (
            <span className="rounded border border-amber-400/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-300">
              not applied yet
            </span>
          )}
          <span className="font-mono text-text">$</span>
          <input
            id={`target-${sleeve.portfolioId}`}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={target}
            onChange={(e) => onTarget(e.target.value)}
            disabled={disabled}
            className={`w-32 rounded-lg border bg-transparent px-2 py-1 text-right text-sm font-mono text-text focus:outline-none disabled:opacity-50 ${
              invalid
                ? "border-[var(--color-red,#FF3333)]/60"
                : "border-white/[0.12] focus:border-[var(--color-green,#00FF41)]/50"
            }`}
          />
        </span>
      </div>

      {applySlot}

      {/* Real-order controls, out of the way until wanted. Both keep their own
          two-step confirms. */}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-wide text-text-muted hover:text-text">
          Manage — sync now, change which strategy it copies
        </summary>
        <div className="mt-1.5 rounded-lg border border-white/[0.08] px-3 py-2">
          <SyncLiveButton portfolioId={sleeve.portfolioId} />
          {paperOptions.length > 0 && (
            <FollowTargetPicker
              portfolioId={sleeve.portfolioId}
              currentId={sleeve.followsPortfolioId}
              options={paperOptions}
            />
          )}
        </div>
      </details>
    </div>
  );
}

function Sep() {
  return <span className="mx-1.5 text-text-muted/60">·</span>;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
