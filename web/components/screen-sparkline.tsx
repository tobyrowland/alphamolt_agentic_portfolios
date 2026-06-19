"use client";

/**
 * Compact P/S sparkline for a screener row's expand (redesign brief §5).
 *
 * A 12-month weekly P/S line with two reference lines — the stock's own 12-mo
 * median (dashed) and its sector/peer median (dotted) — plus the latest point
 * marked. Display only: factual framing ("below its median"), never a buy
 * signal. Mirrors the v8 mockup's spark() + valueBlock().
 */

import type { PsPoint } from "@/lib/screen/ps-history-query";

const W = 320;
const H = 62;
const P = 6;

export default function ScreenSparkline({
  points,
  ownMedian,
  sectorMedian,
  sectorBasis,
  loading,
}: {
  points: PsPoint[];
  ownMedian: number | null;
  sectorMedian: number | null;
  sectorBasis: string | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <p className="font-mono text-[11px] text-text-muted">Loading P/S history…</p>
    );
  }
  if (points.length < 2) {
    return (
      <p className="font-mono text-[11px] text-text-muted">
        Not enough P/S history to chart.
      </p>
    );
  }

  const series = points.map((p) => p.ps);
  const candidates = [...series];
  if (ownMedian != null) candidates.push(ownMedian);
  if (sectorMedian != null) candidates.push(sectorMedian);
  const lo = Math.min(...candidates);
  const hi = Math.max(...candidates);
  const rng = hi - lo || 1;
  const n = series.length;
  const x = (i: number) => P + (i * (W - 2 * P)) / (n - 1);
  const y = (v: number) => H - P - ((v - lo) / rng) * (H - 2 * P);
  const poly = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const last = points[n - 1];
  const current = last.ps;
  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return Number.isNaN(dt.getTime())
      ? d
      : dt.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  };
  const pctVs = (median: number | null) =>
    median != null && median > 0 ? (current / median - 1) * 100 : null;
  const ownPct = pctVs(ownMedian);
  const secPct = pctVs(sectorMedian);
  const tag = (p: number | null) =>
    p == null ? "—" : `${p <= 0 ? "−" : "+"}${Math.abs(p).toFixed(0)}% ${p < 0 ? "cheap" : "rich"}`;
  const toneCls = (p: number | null) =>
    p == null ? "text-text-muted" : p < 0 ? "text-green" : "text-text";

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full h-[62px]"
        role="img"
        aria-label="12-month P/S vs own and sector median"
      >
        {ownMedian != null && (
          <line
            x1={P}
            y1={y(ownMedian)}
            x2={W - P}
            y2={y(ownMedian)}
            stroke="var(--color-text-muted, #9aa0a6)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}
        {sectorMedian != null && (
          <line
            x1={P}
            y1={y(sectorMedian)}
            x2={W - P}
            y2={y(sectorMedian)}
            stroke="#e0a23c"
            strokeWidth="1"
            strokeDasharray="1 3"
          />
        )}
        <polyline points={poly} fill="none" stroke="var(--color-cyan)" strokeWidth="1.6" />
        <circle cx={x(n - 1)} cy={y(current)} r="2.6" fill="var(--color-cyan)" />
      </svg>

      <div className="flex justify-between mt-0.5 font-mono text-[9px] text-text-muted">
        <span>{fmtDate(points[0].date)}</span>
        <span>{fmtDate(last.date)}</span>
      </div>

      <div className="flex gap-3.5 mt-1.5 font-mono text-[10px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block w-3.5 border-t border-dashed border-text-muted" /> own 12-mo median
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block w-3.5 border-t border-dotted" style={{ borderColor: "#e0a23c" }} /> {sectorBasis ?? "sector"} median
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 font-mono text-[11.5px]">
        <span className="text-text-muted">current</span>
        <span className="text-right text-text">{current.toFixed(2)}×</span>
        <span className="text-text-muted">vs own median</span>
        <span className={`text-right ${toneCls(ownPct)}`}>
          {ownMedian != null ? `${ownMedian.toFixed(2)}× · ${tag(ownPct)}` : "—"}
        </span>
        <span className="text-text-muted">vs {sectorBasis ?? "sector"}</span>
        <span className={`text-right ${toneCls(secPct)}`}>
          {sectorMedian != null ? `${sectorMedian.toFixed(2)}× · ${tag(secPct)}` : "—"}
        </span>
      </div>
    </div>
  );
}
