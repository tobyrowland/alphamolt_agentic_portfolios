"use client";

import { useMemo, useState } from "react";
import PulseChart, { type PulseLine } from "@/components/dashboard/pulse-chart";
import type {
  DashPortfolio,
  DashSeriesPoint,
  DashValuePoint,
} from "@/lib/dashboard-query";

function fmtUsd(v: number | null): string {
  if (v == null) return "—";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// Period selector. Each maps to a lookback in days; `null` = all history.
const PERIODS = [
  { key: "1W", label: "1W", days: 7 },
  { key: "1M", label: "1M", days: 30 },
  { key: "3M", label: "3M", days: 90 },
  { key: "1Y", label: "1Y", days: 365 },
  { key: "ALL", label: "All", days: null },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

// One color per portfolio, assigned in stable created_at order so a line never
// changes hue when the selection or period changes. Slot 1 is the brand green
// (deliberately outside the usual even-lightness band); the rest were validated
// together for CVD separation and 3:1 contrast on the dark surface. Chips carry
// a matching dot, so identity is never color-alone.
const PORTFOLIO_COLORS = [
  "#00FF41",
  "#5aa9ff",
  "#ffb020",
  "#ff7ab0",
  "#b7a8ff",
  "#ff8a4a",
];
function colorFor(i: number): string {
  return PORTFOLIO_COLORS[Math.min(i, PORTFOLIO_COLORS.length - 1)];
}

/** Slice a raw value series to the period and re-normalise to its first point,
 *  so the % return is measured from the start of the *selected* window. */
function periodSeries(
  raw: DashValuePoint[],
  cutoff: string | null,
): DashSeriesPoint[] {
  const win = cutoff ? raw.filter((r) => r.date >= cutoff) : raw;
  if (win.length === 0) return [];
  const base = win[0].value;
  if (!base) return win.map((r) => ({ date: r.date, pct: 0 }));
  return win.map((r) => ({ date: r.date, pct: (r.value / base - 1) * 100 }));
}

/** First/last raw value inside the window — feeds the funding-adjusted "All"
 *  P/L: each book's gain is measured from its own window start, so a portfolio
 *  funded mid-window contributes its return, not its seed cash. */
function periodEndpoints(
  raw: DashValuePoint[],
  cutoff: string | null,
): { start: number; end: number } | null {
  const win = cutoff ? raw.filter((r) => r.date >= cutoff) : raw;
  if (win.length === 0) return null;
  return { start: win[0].value, end: win[win.length - 1].value };
}

export default function PulseSection({
  portfolios,
  spyValues,
}: {
  portfolios: DashPortfolio[];
  spyValues: DashValuePoint[];
}) {
  const multi = portfolios.length > 1;
  const [sel, setSel] = useState<string>(multi ? "all" : portfolios[0]?.id ?? "all");
  const [period, setPeriod] = useState<PeriodKey>("1M");

  const cutoff = useMemo(() => {
    const days = PERIODS.find((p) => p.key === period)?.days ?? null;
    return days == null
      ? null
      : new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  }, [period]);

  // One line per portfolio (the "All" view); a single selection just narrows
  // to that portfolio's line, keeping its assigned color.
  const lines = useMemo<PulseLine[]>(() => {
    const all = portfolios.map((p, i) => ({
      key: p.id,
      name: p.name,
      color: colorFor(i),
      points: periodSeries(p.valueSeries, cutoff),
    }));
    if (sel === "all") return all;
    const one = all.find((l) => l.key === sel) ?? all[0];
    return one ? [one] : [];
  }, [sel, portfolios, cutoff]);

  const current = useMemo(() => {
    if (sel === "all") {
      let start = 0;
      let end = 0;
      for (const p of portfolios) {
        const ep = periodEndpoints(p.valueSeries, cutoff);
        if (ep) {
          start += ep.start;
          end += ep.end;
        }
      }
      return {
        name: "All portfolios",
        value: portfolios.reduce((s, p) => s + (p.value ?? 0), 0),
        periodPct: start > 0 ? (end / start - 1) * 100 : null,
      };
    }
    const p = portfolios.find((x) => x.id === sel) ?? portfolios[0];
    const series = periodSeries(p?.valueSeries ?? [], cutoff);
    return {
      name: p?.name ?? "Portfolio",
      value: p?.value ?? null,
      periodPct: series.length ? series[series.length - 1].pct : null,
    };
  }, [sel, portfolios, cutoff]);

  const spySeries = useMemo(
    () => periodSeries(spyValues, cutoff),
    [spyValues, cutoff],
  );

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";
  const spyFinal = spySeries.length ? spySeries[spySeries.length - 1].pct : 0;
  const vsSpy = current.periodPct == null ? null : current.periodPct - spyFinal;

  return (
    <section
      aria-label="Performance pulse"
      className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="flex gap-6">
          <Stat label="Total value" value={fmtUsd(current.value)} />
          <Stat label={`P/L (${periodLabel})`} value={fmtPct(current.periodPct)} tone={current.periodPct} />
          <Stat label={`vs SPY (${periodLabel})`} value={fmtPct(vsSpy)} tone={vsSpy} />
        </div>
        {/* Period selector. */}
        <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Chart period">
          {PERIODS.map((p) => (
            <SwitchChip
              key={p.key}
              active={period === p.key}
              onClick={() => setPeriod(p.key)}
              label={p.label}
            />
          ))}
        </div>
      </div>
      {/* Per-portfolio selector (when the user runs more than one book). The
          chips double as the chart legend — each carries its line's color. */}
      {multi && (
        <div className="flex items-center gap-1 flex-wrap mb-3">
          <SwitchChip active={sel === "all"} onClick={() => setSel("all")} label="All" />
          {portfolios.map((p, i) => (
            <SwitchChip
              key={p.id}
              active={sel === p.id}
              onClick={() => setSel(p.id)}
              label={p.name}
              dotColor={colorFor(i)}
            />
          ))}
        </div>
      )}
      <PulseChart lines={lines} spy={spySeries} />
      <p className="sr-only">
        {sel === "all" && multi
          ? `Over the selected period (${periodLabel}): ${portfolios
              .map((p) => {
                const s = periodSeries(p.valueSeries, cutoff);
                return `${p.name} ${fmtPct(s.length ? s[s.length - 1].pct : null)}`;
              })
              .join(", ")}. The S&P 500 returned ${fmtPct(spyFinal)}.`
          : `${current.name} is ${fmtPct(current.periodPct)} over the selected period (${periodLabel}), ${
              (vsSpy ?? 0) >= 0 ? "ahead of" : "behind"
            } the S&P 500 by ${Math.abs(vsSpy ?? 0).toFixed(2)} percentage points.`}
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: number | null;
}) {
  const color =
    tone == null
      ? "text-text"
      : tone >= 0
        ? "text-[var(--color-green,#00FF41)]"
        : "text-[var(--color-red,#FF3333)]";
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
        {label}
      </div>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function SwitchChip({
  active,
  onClick,
  label,
  dotColor,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  dotColor?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`font-mono text-[11px] rounded-md px-2.5 py-1 border transition-colors inline-flex items-center gap-1.5 ${
        active
          ? "text-[var(--color-green,#00FF41)] border-[var(--color-green,#00FF41)]/50 bg-[var(--color-green,#00FF41)]/10"
          : "text-text-muted border-white/10 hover:text-text"
      }`}
    >
      {dotColor && (
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: dotColor }}
        />
      )}
      {label}
    </button>
  );
}
