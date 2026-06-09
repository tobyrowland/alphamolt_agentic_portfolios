"use client";

import { useMemo, useState } from "react";
import PulseChart from "@/components/dashboard/pulse-chart";
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

/** Sum each date's raw value across portfolios (the "All" total-value series). */
function aggregateValues(portfolios: DashPortfolio[]): DashValuePoint[] {
  const byDate = new Map<string, number>();
  for (const p of portfolios) {
    for (const pt of p.valueSeries) {
      byDate.set(pt.date, (byDate.get(pt.date) ?? 0) + pt.value);
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, value]) => ({ date, value }));
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

  const current = useMemo(() => {
    const rawValues =
      sel === "all"
        ? aggregateValues(portfolios)
        : (portfolios.find((x) => x.id === sel) ?? portfolios[0])?.valueSeries ??
          [];
    const name =
      sel === "all"
        ? "All portfolios"
        : (portfolios.find((x) => x.id === sel) ?? portfolios[0])?.name ??
          "Portfolio";
    const value =
      sel === "all"
        ? portfolios.reduce((s, p) => s + (p.value ?? 0), 0)
        : (portfolios.find((x) => x.id === sel) ?? portfolios[0])?.value ?? null;
    const series = periodSeries(rawValues, cutoff);
    const periodPct = series.length ? series[series.length - 1].pct : null;
    return { name, value, periodPct, series };
  }, [sel, portfolios, cutoff]);

  const spySeries = useMemo(
    () => periodSeries(spyValues, cutoff),
    [spyValues, cutoff],
  );

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";
  const spyFinal = spySeries.length ? spySeries[spySeries.length - 1].pct : 0;
  const youFinal = current.series.length
    ? current.series[current.series.length - 1].pct
    : 0;
  const vsSpy = youFinal - spyFinal;

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
      {/* Per-portfolio selector (when the user runs more than one book). */}
      {multi && (
        <div className="flex items-center gap-1 flex-wrap mb-3">
          <SwitchChip active={sel === "all"} onClick={() => setSel("all")} label="All" />
          {portfolios.map((p) => (
            <SwitchChip
              key={p.id}
              active={sel === p.id}
              onClick={() => setSel(p.id)}
              label={p.name}
            />
          ))}
        </div>
      )}
      <PulseChart portfolio={current.series} spy={spySeries} />
      <p className="sr-only">
        {current.name} is {fmtPct(current.periodPct)} over the selected period
        ({periodLabel}), {vsSpy >= 0 ? "ahead of" : "behind"} the S&amp;P 500 by{" "}
        {Math.abs(vsSpy).toFixed(2)} percentage points.
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
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`font-mono text-[11px] rounded-md px-2.5 py-1 border transition-colors ${
        active
          ? "text-[var(--color-green,#00FF41)] border-[var(--color-green,#00FF41)]/50 bg-[var(--color-green,#00FF41)]/10"
          : "text-text-muted border-white/10 hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}
