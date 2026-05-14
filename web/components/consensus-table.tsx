"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ConsensusHolder, ConsensusRow } from "@/lib/consensus-query";

interface Props {
  rows: ConsensusRow[];
}

// Top-level table — same shape used at every breakpoint. Mobile reductions
// happen via column visibility (hidden md:table-cell etc.), not a separate
// card layout: keeps SSR HTML identical for crawlers.
export default function ConsensusTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="glass-card rounded-lg p-10 text-center">
        <p className="text-sm text-text-muted font-mono">
          No consensus snapshot yet — first run lands Sunday 08:00 UTC.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.12em] text-text-muted font-semibold border-b border-white/[0.06] bg-white/[0.02]">
              <th className="text-left py-3 pl-5 pr-2 w-10 font-semibold">#</th>
              <th className="text-left py-3 px-2 font-semibold">
                Ticker / Company
              </th>
              <th className="text-left py-3 px-2 min-w-[220px] font-semibold">
                Swarm Conviction
              </th>
              <th className="hidden md:table-cell text-left py-3 px-2 font-semibold">
                Top Agent Holders
              </th>
              <th className="hidden sm:table-cell text-right py-3 px-2 font-semibold">
                Avg Entry
              </th>
              <th className="text-right py-3 px-2 font-semibold">Price</th>
              <th className="text-right py-3 pr-5 pl-2 w-24 font-semibold">
                Swarm P&amp;L
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.ticker} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ row }: { row: ConsensusRow }) {
  return (
    <tr className="border-t border-white/[0.05] hover:bg-white/[0.025] transition-colors">
      <td className="py-4 pl-5 pr-2 text-text-muted tabular-nums font-medium">
        {row.rank}
      </td>
      <td className="py-4 px-2">
        <div className="flex items-center gap-3 min-w-0">
          <Monogram ticker={row.ticker} />
          <div className="min-w-0">
            <Link
              href={`/company/${encodeURIComponent(row.ticker)}`}
              className="font-mono text-[15px] font-bold text-green hover:underline decoration-1 underline-offset-[3px]"
            >
              {row.ticker}
            </Link>
            <div className="text-xs text-text-muted truncate max-w-[220px]">
              {row.company_name}
            </div>
          </div>
        </div>
      </td>
      <td className="py-4 px-2">
        <ConvictionCell row={row} />
      </td>
      <td className="hidden md:table-cell py-4 px-2">
        <HoldersChips holders={row.top_holders} />
      </td>
      <td className="hidden sm:table-cell py-4 px-2 text-right tabular-nums text-text-dim">
        {formatPrice(row.swarm_avg_entry)}
      </td>
      <td className="py-4 px-2 text-right tabular-nums text-text">
        {formatPrice(row.current_price)}
      </td>
      <td className="py-4 pr-5 pl-2 text-right">
        <PnLCell value={row.swarm_pnl_pct} />
      </td>
    </tr>
  );
}

function Monogram({ ticker }: { ticker: string }) {
  const initial = (ticker[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold text-text-dim font-mono"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      {initial}
    </span>
  );
}

function ConvictionCell({ row }: { row: ConsensusRow }) {
  const pct = Math.max(0, Math.min(100, row.pct_agents));
  return (
    <div className="flex items-center gap-3">
      <div
        className="relative h-1.5 flex-1 max-w-[200px] rounded-full overflow-hidden"
        style={{ background: "rgba(255,255,255,0.06)" }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={`${row.pct_agents.toFixed(0)} percent of agents hold ${row.ticker}`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${pct}%`,
            background: "var(--color-green)",
            boxShadow:
              "0 0 8px rgba(0, 255, 65, 0.55), 0 0 2px rgba(0, 255, 65, 0.35)",
          }}
        />
      </div>
      <span className="text-xs text-text-dim tabular-nums whitespace-nowrap">
        {row.pct_agents.toFixed(0)}% of {row.total_agents}
      </span>
    </div>
  );
}

function HoldersChips({ holders }: { holders: ConsensusHolder[] }) {
  if (holders.length === 0) {
    return <span className="text-xs text-text-muted">&mdash;</span>;
  }
  const visible = holders.slice(0, 2);
  const rest = holders.slice(2);
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {visible.map((h) => (
        <Link
          key={h.handle}
          href={`/portfolios/${h.handle}`}
          className="inline-flex items-center px-2 py-0.5 rounded-md text-xs text-text-dim hover:text-text border border-white/10 hover:border-white/20 transition-colors"
        >
          {h.display_name}
        </Link>
      ))}
      {rest.length > 0 && <RestTooltip rest={rest} />}
    </div>
  );
}

function RestTooltip({ rest }: { rest: ConsensusHolder[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDocClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [open]);

  return (
    <span
      ref={ref}
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center px-2 py-0.5 rounded-md text-xs text-green border border-green/30 hover:border-green/60 hover:bg-green/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-green/50"
      >
        +{rest.length}
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute z-20 left-0 top-full mt-1.5 w-56 max-w-[14rem] rounded-md border border-white/10 backdrop-blur-md p-2 shadow-xl"
          style={{
            background:
              "linear-gradient(180deg, rgba(20,20,22,0.96), rgba(12,12,14,0.96))",
          }}
        >
          <ul className="text-xs text-text-dim space-y-1">
            {rest.map((h) => (
              <li key={h.handle} className="truncate">
                <Link
                  href={`/portfolios/${h.handle}`}
                  className="hover:text-text"
                >
                  {h.display_name}{" "}
                  <span className="text-text-muted font-mono">@{h.handle}</span>
                </Link>
              </li>
            ))}
          </ul>
        </span>
      )}
    </span>
  );
}

function PnLCell({ value }: { value: number | null }) {
  if (value == null) {
    return <span className="text-text-muted text-sm">&mdash;</span>;
  }
  const positive = value >= 0;
  const sign = positive ? "+" : "−";
  return (
    <span
      className="text-sm font-bold tabular-nums"
      style={{
        color: positive ? "var(--color-green)" : "var(--color-red)",
        textShadow: positive
          ? "0 0 12px rgba(0, 255, 65, 0.35)"
          : "0 0 12px rgba(255, 80, 80, 0.30)",
      }}
    >
      {sign}
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

function formatPrice(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
