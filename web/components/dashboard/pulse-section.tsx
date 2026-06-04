"use client";

import { useMemo, useState } from "react";
import PulseChart from "@/components/dashboard/pulse-chart";
import type { DashPortfolio, DashSeriesPoint } from "@/lib/dashboard-query";

function fmtUsd(v: number | null): string {
  if (v == null) return "—";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** Average the per-portfolio normalised % series by date (an "All" proxy). */
function aggregate(portfolios: DashPortfolio[]): DashSeriesPoint[] {
  const byDate = new Map<string, { sum: number; n: number }>();
  for (const p of portfolios) {
    for (const pt of p.series) {
      const e = byDate.get(pt.date) ?? { sum: 0, n: 0 };
      e.sum += pt.pct;
      e.n += 1;
      byDate.set(pt.date, e);
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, e]) => ({ date, pct: e.sum / e.n }));
}

export default function PulseSection({
  portfolios,
  spy,
}: {
  portfolios: DashPortfolio[];
  spy: DashSeriesPoint[];
}) {
  const multi = portfolios.length > 1;
  const [sel, setSel] = useState<string>(multi ? "all" : portfolios[0]?.id ?? "all");

  const current = useMemo(() => {
    if (sel === "all") {
      const series = aggregate(portfolios);
      const value = portfolios.reduce((s, p) => s + (p.value ?? 0), 0);
      const pnlPct = series.length ? series[series.length - 1].pct : null;
      return { name: "All portfolios", value, pnlPct, series };
    }
    const p = portfolios.find((x) => x.id === sel) ?? portfolios[0];
    return { name: p.name, value: p.value, pnlPct: p.pnlPct, series: p.series };
  }, [sel, portfolios]);

  const spyFinal = spy.length ? spy[spy.length - 1].pct : 0;
  const youFinal = current.series.length ? current.series[current.series.length - 1].pct : 0;
  const vsSpy = youFinal - spyFinal;

  return (
    <section aria-label="Performance pulse" className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="flex gap-6">
          <Stat label="Total value" value={fmtUsd(current.value)} />
          <Stat label="P/L" value={fmtPct(current.pnlPct)} tone={current.pnlPct} />
          <Stat label="vs SPY (30d)" value={fmtPct(vsSpy)} tone={vsSpy} />
        </div>
        {multi && (
          <div className="flex items-center gap-1 flex-wrap">
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
      </div>
      <PulseChart portfolio={current.series} spy={spy} />
      <p className="sr-only">
        {current.name} is {fmtPct(current.pnlPct)} over the last 30 days,{" "}
        {vsSpy >= 0 ? "ahead of" : "behind"} the S&amp;P 500 by{" "}
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
