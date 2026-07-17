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
import { useCallback, useRef, useState } from "react";
import type { HoldingWithMtm } from "@/lib/portfolio";
import type { PricePoint } from "@/lib/price-history-query";
import type { InvestmentThesis, ThesisSignal } from "@/lib/theses-query";
import PriceSinceBuySparkline from "@/components/price-since-buy-sparkline";
import SellHoldingButton from "@/components/portfolio/sell-holding-button";

interface Props {
  /** Threaded to SellHoldingButton when canSell is true. Allowed null
   *  for public viewers — the button doesn't render and the prop is unused. */
  portfolioId?: string;
  holdings: HoldingWithMtm[];
  thesesByTicker: Record<string, InvestmentThesis>;
  /** Held tickers' live values keyed by SIGNAL field names (theses-query
   *  getCurrentSignalFacts) — powers the per-signal current-vs-threshold
   *  gauges. Optional: absent values just render the plain text rows. */
  currentByTicker?: Record<string, Record<string, number>>;
  /** Render the per-row "Sell" button. Owner-only on the portfolio
   *  detail page. Default false so public viewers see no sell control. */
  canSell?: boolean;
}

export default function HoldingsList({
  portfolioId,
  holdings,
  thesesByTicker,
  currentByTicker = {},
  canSell = false,
}: Props) {
  const [openTicker, setOpenTicker] = useState<string | null>(null);
  // Lazy per-ticker price history for the "price since buy" sparkline —
  // fetched once on first expand (the ps-history pattern from the screener).
  const [priceHistory, setPriceHistory] = useState<
    Record<string, PricePoint[] | "loading">
  >({});
  const priceRequested = useRef(new Set<string>());
  const loadPriceHistory = useCallback((ticker: string, since: string | null) => {
    const t = ticker.toUpperCase();
    if (priceRequested.current.has(t)) return;
    priceRequested.current.add(t);
    setPriceHistory((prev) => ({ ...prev, [t]: "loading" }));
    (async () => {
      try {
        const qs = new URLSearchParams({ ticker: t });
        if (since) qs.set("since", since);
        const res = await fetch(`/api/portfolio/price-history?${qs}`, {
          cache: "force-cache",
        });
        const json = res.ok
          ? ((await res.json()) as { history?: PricePoint[] })
          : null;
        setPriceHistory((prev) => ({ ...prev, [t]: json?.history ?? [] }));
      } catch {
        setPriceHistory((prev) => ({ ...prev, [t]: [] }));
      }
    })();
  }, []);

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
        // Chart window: from ~3 months before the buy for context; without a
        // recorded thesis, the trailing year (the route's default).
        const buyDate = thesis?.opened_at?.slice(0, 10) ?? null;
        const chartSince = buyDate
          ? new Date(new Date(`${buyDate}T00:00:00Z`).getTime() - 90 * 86400000)
              .toISOString()
              .slice(0, 10)
          : null;
        return (
          <li
            key={h.ticker}
            className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden"
          >
            <button
              type="button"
              onClick={() => {
                if (!isOpen) loadPriceHistory(h.ticker, chartSince);
                setOpenTicker(isOpen ? null : h.ticker);
              }}
              className="w-full px-3 sm:px-4 py-3 hover:bg-white/[0.04] transition-colors text-left"
              aria-expanded={isOpen}
              aria-controls={`thesis-panel-${h.ticker}`}
            >
              {/* Two-row stacked layout on mobile; collapses to a single
                  horizontal row at sm+ so wider viewports see the same
                  dense tape as before. */}
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                {/* Row 1 / left block — ticker, company name, badge */}
                <div className="flex items-baseline gap-2 sm:gap-3 min-w-0">
                  <span
                    className="font-mono text-sm font-bold text-text-muted shrink-0"
                    aria-hidden="true"
                  >
                    {isOpen ? "▼" : "▶"}
                  </span>
                  <Link
                    href={`/company/${encodeURIComponent(h.ticker)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-sm font-bold text-text hover:text-[var(--color-cyan)] hover:underline decoration-1 underline-offset-[3px] shrink-0 transition-colors"
                  >
                    {h.ticker}
                  </Link>
                  {h.company_name && (
                    <span className="text-sm text-text-muted truncate min-w-0">
                      {h.company_name}
                    </span>
                  )}
                  {thesis && <ThesisBadge thesis={thesis} />}
                </div>

                {/* Row 2 / right block — qty @ price and market value / P&L.
                    On mobile we put the cost basis on the left and the
                    market value on the right of the second row. */}
                <div className="flex items-baseline justify-between gap-3 sm:gap-3 sm:items-baseline">
                  <span className="text-[12px] sm:text-sm text-text-dim font-mono sm:order-first">
                    {h.quantity.toLocaleString()} @ {formatUsd(h.avg_cost_usd)}
                  </span>
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
                </div>
              </div>
            </button>

            {isOpen && (
              <div
                id={`thesis-panel-${h.ticker}`}
                className="border-t border-white/[0.06] bg-white/[0.015] px-4 py-4 space-y-4"
              >
                <section className="max-w-[420px]">
                  <h4 className="text-[11px] font-mono uppercase tracking-wider text-text-dim mb-1.5">
                    {buyDate ? "Price since buy" : "Price — last 12 months"}
                  </h4>
                  <PriceSinceBuySparkline
                    points={
                      priceHistory[h.ticker] === "loading" ||
                      priceHistory[h.ticker] == null
                        ? []
                        : (priceHistory[h.ticker] as PricePoint[])
                    }
                    costBasis={h.avg_cost_usd}
                    buyDate={buyDate}
                    loading={
                      priceHistory[h.ticker] === "loading" ||
                      priceHistory[h.ticker] == null
                    }
                  />
                </section>
                {thesis ? (
                  <ThesisPanel
                    thesis={thesis}
                    current={currentByTicker[h.ticker] ?? {}}
                  />
                ) : (
                  <p className="text-sm text-text-muted italic">
                    No thesis recorded for this position. Either the buy
                    pre-dates migration 020, or the thesis row was
                    superseded / closed.
                  </p>
                )}
                {canSell && portfolioId && (
                  <div className="pt-3 border-t border-white/[0.06] flex items-start justify-between gap-3 flex-wrap">
                    <p className="text-[11px] font-mono text-text-muted leading-relaxed max-w-[480px]">
                      Manual sell of the full position at the latest price.
                      Once sold, the buyer agent won&apos;t reconsider this
                      ticker for 90 days.
                    </p>
                    <SellHoldingButton
                      portfolioId={portfolioId}
                      ticker={h.ticker}
                      quantity={h.quantity}
                      marketValueUsd={h.market_value_usd}
                    />
                  </div>
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
      className="text-[10px] font-mono uppercase tracking-wider text-text-muted border border-white/10 rounded px-1.5 py-0.5 shrink-0"
      title="Snapshot of the equity data at buy time. No agent-written thesis."
    >
      Snapshot
    </span>
  );
}

function ThesisPanel({
  thesis,
  current,
}: {
  thesis: InvestmentThesis;
  current: Record<string, number>;
}) {
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
          current={current}
        />
      )}

      {thesis.extend_signals && thesis.extend_signals.length > 0 && (
        <SignalList
          title="What would strengthen it"
          accent="green"
          signals={thesis.extend_signals}
          current={current}
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
  current,
}: {
  title: string;
  accent: "red" | "green";
  signals: ThesisSignal[];
  current: Record<string, number>;
}) {
  const accentColor = accent === "red" ? "text-red" : "text-green";
  return (
    <section>
      <h4 className="text-[11px] font-mono uppercase tracking-wider text-text-dim mb-1">
        {title}
      </h4>
      <ul className="space-y-1.5">
        {signals.map((sig, i) => (
          <li
            key={`${sig.field}-${sig.op}-${i}`}
            className="font-mono text-[12px] text-text-muted"
          >
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className={`${accentColor} shrink-0`} aria-hidden="true">
                ▸
              </span>
              <span className="text-text">{sig.field}</span>
              <span className="text-text-dim">{sig.op}</span>
              <span className="text-text">{String(sig.value)}</span>
              <SignalGauge sig={sig} current={current} accent={accent} />
            </div>
            {sig.description && (
              <div className="pl-4 text-text-muted italic text-[11.5px]">
                {sig.description}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ----- Signal gauge ----------------------------------------------------------
// "Where does the name sit today vs this trip-wire?" — a compact track with
// the threshold at center and a dot for the current value. For a break signal
// the condition being true is bad (red); for an extend signal it's good
// (green). "Near" = within 25% of the gauge span on the safe side (amber).

const GAUGE_OPS: Record<string, (cur: number, thr: number) => boolean> = {
  "<": (c, t) => c < t,
  "<=": (c, t) => c <= t,
  ">": (c, t) => c > t,
  ">=": (c, t) => c >= t,
};

/** Unit suffix for a signal field, for the "now" readout. */
function signalUnit(field: string): string {
  if (field.endsWith("_pct")) return "%";
  if (field === "ps_now") return "×";
  return "";
}

function SignalGauge({
  sig,
  current,
  accent,
}: {
  sig: ThesisSignal;
  current: Record<string, number>;
  accent: "red" | "green";
}) {
  const cur = current[sig.field];
  const thr = toNumber(sig.value);
  const cmp = GAUGE_OPS[sig.op];
  // Only mapped fields with a live value and a directional op get a gauge;
  // anything else (change_pct ops, ==, unmapped fields) keeps the plain row.
  if (cur == null || thr == null || !cmp) return null;

  const met = cmp(cur, thr);
  // Scale: threshold at center, span wide enough that typical values sit
  // inside the track (± max(60% of |threshold|, 5 units)).
  const span = Math.max(Math.abs(thr) * 0.6, 5);
  const pos = Math.min(0.95, Math.max(0.05, 0.5 + (cur - thr) / (2 * span)));
  // Which side of the threshold trips the condition (for tinting the track).
  const tripsBelow = sig.op === "<" || sig.op === "<=";
  const near = !met && Math.abs(cur - thr) <= span * 0.25;

  // Dot + label tone. Break met = red (tripped); extend met = green (met);
  // near = amber warning that the trip-wire is close.
  const tone = met
    ? accent === "red"
      ? "var(--color-red, #ff3333)"
      : "var(--color-green, #00ff88)"
    : near
      ? "#f5a623"
      : "rgba(255,255,255,0.55)";
  const label = met ? (accent === "red" ? "tripped" : "met") : near ? "close" : "now";
  const unit = signalUnit(sig.field);

  return (
    <span
      className="inline-flex items-center gap-1.5 ml-auto shrink-0"
      title={`Current ${sig.field}: ${cur}${unit} · trips when ${sig.op} ${sig.value}${unit}`}
    >
      <span
        aria-hidden="true"
        className="relative inline-block h-[5px] w-24 rounded-full overflow-hidden bg-white/[0.08]"
      >
        {/* Trip side of the track, softly tinted toward the accent. */}
        <span
          className="absolute inset-y-0"
          style={{
            [tripsBelow ? "left" : "right"]: 0,
            width: "50%",
            background:
              accent === "red"
                ? "rgba(255,51,51,0.18)"
                : "rgba(0,255,136,0.15)",
          }}
        />
        {/* Threshold tick at center. */}
        <span
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
          style={{ background: "rgba(255,255,255,0.45)" }}
        />
        {/* Current-value dot. */}
        <span
          className="absolute top-1/2 h-[9px] w-[9px] -translate-y-1/2 -translate-x-1/2 rounded-full border border-black/60"
          style={{ left: `${pos * 100}%`, background: tone }}
        />
      </span>
      <span
        className="text-[10.5px] tabular-nums whitespace-nowrap"
        style={{ color: tone }}
      >
        {label} {formatSignalValue(cur)}
        {unit}
      </span>
    </span>
  );
}

function formatSignalValue(n: number): string {
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
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
    superseded: "text-text-muted border-white/10",
    closed: "text-text-muted border-white/10",
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
