"use client";

import { useState } from "react";
import type { SleevePositions } from "@/lib/live-positions-query";
import type { PositionRow } from "@/lib/live-positions";

/**
 * What one strategy holds, and what the mirror will do about each name.
 *
 * The console showed cash and nothing else, so the only way to see the actual
 * positions was to open the broker's own site — and even there, three names
 * sat unexplained: two deliberately half-size, one inherited from a funding
 * move and stranded forever below the trade threshold. They looked identical.
 *
 * So the table's job is not to list holdings (the broker does that). It is to
 * put each name in one of three states the owner can act on:
 *   ON TARGET   — nothing to do.
 *   PENDING     — the next mirror run moves it, no action needed.
 *   STRANDED    — off the paper book AND too small for the mirror to sell.
 *                 Only a `replicate` run or a manual sell clears it.
 * The last is the category that needs a human, and it is the one nothing on
 * the old console could name.
 */
export default function PositionsTable({
  positions,
  strategyName,
}: {
  positions: SleevePositions;
  strategyName: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const { rows, summary, hasPaperBook } = positions;

  if (rows.length === 0) {
    return (
      <p className="px-3 py-4 text-[13px] text-text-muted">
        {strategyName} holds no positions.
      </p>
    );
  }

  // Interesting first: anything the owner might act on, then the rest. A
  // 17-row table where the one stranded name is 11th is a table that hides it.
  const notable = rows.filter((r) => r.reason !== "on_target" && r.reason !== "within_threshold");
  const stranded = rows.filter((r) => r.offBook && r.reason !== "would_trade");
  const settled = rows.filter(
    (r) => !notable.includes(r) && !stranded.includes(r),
  );
  const ordered = [...stranded, ...notable, ...settled];
  const visible = showAll ? ordered : ordered.slice(0, 8);

  return (
    <div>
      {!hasPaperBook && (
        <p className="mb-2 rounded-lg border border-orange/40 bg-orange/[0.07] px-3 py-2 text-[12.5px] text-orange">
          {strategyName} follows no paper book, so there are no targets to
          compare against — every weight below is shown without one.
        </p>
      )}

      {summary.strandedCount > 0 && (
        <p className="mb-2 rounded-lg border border-amber-400/40 bg-amber-400/[0.07] px-3 py-2 text-[12.5px] leading-relaxed text-amber-200">
          <strong className="font-semibold">
            {summary.strandedCount === 1 ? "One name is" : `${summary.strandedCount} names are`}{" "}
            stranded
          </strong>{" "}
          — {money(summary.strandedValue)} held outside{" "}
          {strategyName}&apos;s book, but each is under the mirror&apos;s 1%
          trade threshold, so no ordinary sync will ever sell it. A{" "}
          <span className="font-mono">replicate</span> run ignores the
          threshold and clears them.
        </p>
      )}

      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-white/[0.07] text-left">
            <Th className="text-left">Name</Th>
            <Th>Value</Th>
            <Th>Weight</Th>
            <Th>Target</Th>
            <Th className="text-left pl-4">Next sync</Th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <Row key={r.ticker} r={r} hasPaperBook={hasPaperBook} />
          ))}
        </tbody>
      </table>

      {ordered.length > visible.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 text-[12.5px] text-text-muted underline hover:text-text"
        >
          Show {ordered.length - visible.length} more
        </button>
      )}
    </div>
  );
}

function Row({ r, hasPaperBook }: { r: PositionRow; hasPaperBook: boolean }) {
  return (
    <tr className="border-b border-white/[0.04] last:border-0">
      <td className="py-2 pr-2">
        <span className="font-mono font-semibold text-text">{r.ticker}</span>
        {r.offBook && (
          <span className="ml-2 rounded border border-amber-400/40 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-amber-200">
            off book
          </span>
        )}
        <span className="ml-2 font-mono text-[11px] tabular-nums text-text-muted">
          {r.quantity > 0 ? `${trim(r.quantity)} sh` : "—"}
        </span>
      </td>
      <Td>{r.quantity > 0 ? money(r.marketValue) : "—"}</Td>
      <Td>{pct(r.currentWeight)}</Td>
      <Td muted={!hasPaperBook}>{hasPaperBook ? pct(r.targetWeight) : "—"}</Td>
      <td className="py-2 pl-4">
        <Verdict r={r} hasPaperBook={hasPaperBook} />
      </td>
    </tr>
  );
}

/**
 * The one column the broker's own table cannot have: what happens next.
 *
 * Phrased as an outcome, not a status code. "Holds — 0.9% under target, inside
 * the 1% band" tells the owner both that nothing is wrong and why nothing will
 * change, which together are the whole answer to "why is this one small?".
 */
function Verdict({ r, hasPaperBook }: { r: PositionRow; hasPaperBook: boolean }) {
  if (!hasPaperBook) {
    return <span className="text-text-muted">No target set</span>;
  }
  if (r.reason === "would_trade") {
    return (
      <span className={r.action === "buy" ? "text-green" : "text-orange"}>
        {r.action === "buy" ? "Buys" : "Sells"} ~{money(r.orderValue)}
      </span>
    );
  }
  if (r.offBook) {
    return (
      <span className="text-amber-200">
        Stranded — not in the book, too small to sell
      </span>
    );
  }
  if (r.reason === "dust") {
    return <span className="text-text-muted">Holds — order would be dust</span>;
  }
  if (r.reason === "within_threshold") {
    const dir = r.drift > 0 ? "under" : "over";
    return (
      <span className="text-text-muted">
        Holds — {pct(Math.abs(r.drift))} {dir} target, inside the 1% band
      </span>
    );
  }
  return <span className="text-text-muted">On target</span>;
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`pb-1.5 font-mono text-[9.5px] font-normal uppercase tracking-[0.14em] text-text-muted ${
        className || "text-right"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  muted = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <td
      className={`py-2 text-right font-mono tabular-nums ${
        muted ? "text-text-muted" : "text-text-dim"
      }`}
    >
      {children}
    </td>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function trim(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
