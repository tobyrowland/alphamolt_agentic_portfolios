"use client";

/**
 * Holdings list with per-row thesis dropdown.
 *
 * Renders the same row layout as the previous inline list (in
 * app/u/[handle]/page.tsx) but each row is now a button that toggles a
 * dropdown panel underneath. The panel shows whatever `investment_theses`
 * row was active when the page was rendered:
 *
 *   - For source='agent' rows: thesis text + break / extend signals
 *   - For source='auto'  rows: just the snapshot summary
 *   - For holdings without any thesis row: a small "(no thesis recorded)"
 *     note (typical for positions opened before migration 020).
 *
 * The thesis data is pre-loaded server-side and passed in as a prop —
 * no per-row HTTP roundtrip on expand, keeps interaction instant.
 */

import Link from "next/link";
import { useState } from "react";
import type { HoldingWithMtm } from "@/lib/portfolio";
import type { InvestmentThesis, ThesisSignal } from "@/lib/theses-query";

interface Props {
  holdings: HoldingWithMtm[];
  thesesByTicker: Record<string, InvestmentThesis>;
}

export default function HoldingsList({ holdings, thesesByTicker }: Props) {
  const [openTicker, setOpenTicker] = useState<string | null>(null);

  if (holdings.length === 0) {
    return (
      <p className="text-sm text-text-muted italic">
        No positions yet. All cash.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {holdings.map((h) => {
        const thesis = thesesByTicker[h.ticker];
        const isOpen = openTicker === h.ticker;
        return (
          <li
            key={h.ticker}
            className="glass-card rounded border border-border overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setOpenTicker(isOpen ? null : h.ticker)}
              className="w-full px-4 py-3 flex items-baseline justify-between gap-3 hover:bg-bg-elevated transition-colors text-left"
              aria-expanded={isOpen}
              aria-controls={`thesis-panel-${h.ticker}`}
            >
              <div className="flex items-baseline gap-3 min-w-0">
                <span
                  className="font-mono text-sm font-bold text-green shrink-0"
                  aria-hidden="true"
                >
                  {isOpen ? "▼" : "▶"}
                </span>
                <Link
                  href={`/company/${encodeURIComponent(h.ticker)}`}
                  onClick={(e) => e.stopPropagation()}
                  className="font-mono text-sm font-bold text-green hover:underline shrink-0"
                >
                  {h.ticker}
                </Link>
                {h.company_name && (
                  <span className="text-sm text-text-muted truncate min-w-0">
                    {h.company_name}
                  </span>
                )}
                <span className="text-sm text-text-dim shrink-0">
                  {h.quantity.toLocaleString()} @ {formatUsd(h.avg_cost_usd)}
                </span>
                {thesis && (
                  <ThesisBadge thesis={thesis} />
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono text-sm text-text">
                  {formatUsd(h.market_value_usd)}
                </div>
                <div
                  className={`text-[11px] font-mono ${
                    h.unrealized_pnl_usd > 0
                      ? "text-green"
                      : h.unrealized_pnl_usd < 0
                        ? "text-red"
                        : "text-text-muted"
                  }`}
                >
                  {h.unrealized_pnl_usd >= 0 ? "+" : ""}
                  {formatUsd(h.unrealized_pnl_usd)}
                </div>
              </div>
            </button>

            {isOpen && (
              <div
                id={`thesis-panel-${h.ticker}`}
                className="border-t border-border bg-bg-elevated/40 px-4 py-4"
              >
                {thesis ? (
                  <ThesisPanel thesis={thesis} />
                ) : (
                  <p className="text-sm text-text-muted italic">
                    No thesis recorded for this position. Either the buy
                    pre-dates migration 020, or the thesis row was
                    superseded / closed.
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ----- Small subcomponents ---------------------------------------------------

function ThesisBadge({ thesis }: { thesis: InvestmentThesis }) {
  if (thesis.source === "agent") {
    return (
      <span
        className="text-[10px] font-mono uppercase tracking-wider text-green border border-green/30 rounded px-1.5 py-0.5 shrink-0"
        title="Agent recorded an investment thesis at buy time"
      >
        Thesis
      </span>
    );
  }
  return (
    <span
      className="text-[10px] font-mono uppercase tracking-wider text-text-muted border border-border rounded px-1.5 py-0.5 shrink-0"
      title="Snapshot of the equity data at buy time. No agent-written thesis."
    >
      Snapshot
    </span>
  );
}

function ThesisPanel({ thesis }: { thesis: InvestmentThesis }) {
  const snapshot = (thesis.snapshot ?? {}) as Record<string, unknown>;
  return (
    <div className="space-y-4 text-sm">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-text-muted font-mono text-[11px] uppercase tracking-wider">
          <span>
            {thesis.source === "agent" ? "Buy thesis" : "Snapshot only"}
          </span>
          <span aria-hidden="true">·</span>
          <span>Opened {formatDate(thesis.opened_at)}</span>
          <span aria-hidden="true">·</span>
          <StatusPill status={thesis.status} />
        </div>
      </header>

      {thesis.thesis_text && (
        <section>
          <h4 className="text-[11px] font-mono uppercase tracking-wider text-text-dim mb-1">
            Thesis
          </h4>
          <p className="text-text whitespace-pre-wrap leading-relaxed">
            {thesis.thesis_text}
          </p>
        </section>
      )}

      {thesis.break_signals && thesis.break_signals.length > 0 && (
        <SignalList
          title="What would break this thesis"
          accent="red"
          signals={thesis.break_signals}
        />
      )}

      {thesis.extend_signals && thesis.extend_signals.length > 0 && (
        <SignalList
          title="What would strengthen it"
          accent="green"
          signals={thesis.extend_signals}
        />
      )}

      <SnapshotGrid snapshot={snapshot} />
    </div>
  );
}

function SignalList({
  title,
  accent,
  signals,
}: {
  title: string;
  accent: "red" | "green";
  signals: ThesisSignal[];
}) {
  const accentColor = accent === "red" ? "text-red" : "text-green";
  return (
    <section>
      <h4 className="text-[11px] font-mono uppercase tracking-wider text-text-dim mb-1">
        {title}
      </h4>
      <ul className="space-y-1">
        {signals.map((sig, i) => (
          <li
            key={`${sig.field}-${sig.op}-${i}`}
            className="font-mono text-[12px] text-text-muted flex items-baseline gap-2"
          >
            <span className={`${accentColor} shrink-0`} aria-hidden="true">
              ▸
            </span>
            <span className="text-text">{sig.field}</span>
            <span className="text-text-dim">{sig.op}</span>
            <span className="text-text">{String(sig.value)}</span>
            {sig.description && (
              <span className="text-text-muted italic">
                — {sig.description}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Pick a handful of the most legible snapshot fields to show inline. The
// raw JSONB has 30+ fields; rendering all of them would dwarf the rest of
// the panel. Anyone who wants the full snapshot can hit the Supabase
// REST endpoint directly (RLS allows public read).
const SNAPSHOT_FIELDS_TO_SHOW: Array<{
  key: string;
  label: string;
  format: (v: unknown) => string;
}> = [
  { key: "price", label: "Price at buy", format: formatPriceLike },
  { key: "ps_now", label: "P/S", format: formatNumLike },
  { key: "rating", label: "Rating", format: formatNumLike },
  { key: "composite_score", label: "Composite", format: formatNumLike },
  { key: "r40_score", label: "R40", format: formatNumLike },
  { key: "rev_growth_ttm_pct", label: "Rev growth TTM", format: formatPctLike },
  { key: "gross_margin_pct", label: "Gross margin", format: formatPctLike },
  { key: "fcf_margin_pct", label: "FCF margin", format: formatPctLike },
  { key: "perf_52w_vs_spy", label: "52w vs SPY", format: formatPerfLike },
];

function SnapshotGrid({ snapshot }: { snapshot: Record<string, unknown> }) {
  const cells = SNAPSHOT_FIELDS_TO_SHOW.filter((f) => snapshot[f.key] != null);
  if (cells.length === 0) return null;
  return (
    <section>
      <h4 className="text-[11px] font-mono uppercase tracking-wider text-text-dim mb-2">
        Snapshot at buy time
      </h4>
      <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-[12px]">
        {cells.map((f) => (
          <div key={f.key} className="flex items-baseline justify-between">
            <dt className="text-text-muted">{f.label}</dt>
            <dd className="font-mono text-text">{f.format(snapshot[f.key])}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function StatusPill({ status }: { status: InvestmentThesis["status"] }) {
  const styles: Record<InvestmentThesis["status"], string> = {
    active: "text-green border-green/30",
    broken: "text-red border-red/30",
    improved: "text-green border-green/30",
    superseded: "text-text-muted border-border",
    closed: "text-text-muted border-border",
  };
  return (
    <span
      className={`font-mono uppercase tracking-wider border rounded px-1.5 py-0.5 ${styles[status]}`}
    >
      {status}
    </span>
  );
}

// ----- Formatters ------------------------------------------------------------

function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(iso: string): string {
  // Render as YYYY-MM-DD UTC — agents trade on UTC-aligned heartbeats and
  // mixing in a viewer-local timezone would obscure that.
  return iso.slice(0, 10);
}

function formatPriceLike(v: unknown): string {
  const n = toNumber(v);
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNumLike(v: unknown): string {
  const n = toNumber(v);
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function formatPctLike(v: unknown): string {
  const n = toNumber(v);
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

function formatPerfLike(v: unknown): string {
  // perf_52w_vs_spy is stored as a ratio in [-1, +N], not a percent.
  const n = toNumber(v);
  if (n == null) return "—";
  const pct = n * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function toNumber(v: unknown): number | null {
  if (v == null || v === "—") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
