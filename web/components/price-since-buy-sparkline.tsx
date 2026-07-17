"use client";

/**
 * "Price since buy" sparkline for a holding's thesis dropdown.
 *
 * One daily-close line with the ENTRY PRICE as a dashed reference — the chart
 * that completes the thesis story: here's what the market has done since the
 * case was recorded. A short pre-buy stretch renders dimmed for context, the
 * buy date gets a marker on the line, and the latest point is colored by
 * where price sits vs cost (the same green/red the P&L number wears).
 *
 * House sparkline conventions (screen-sparkline.tsx): compact fixed-height
 * SVG, cyan 1.6px line, dashed muted reference, date range under the plot,
 * tiny legend row. Single series ⇒ no legend box; the dashed-line key names
 * the reference.
 */

import type { PricePoint } from "@/lib/price-history-query";

const W = 320;
const H = 62;
const P = 6;

export default function PriceSinceBuySparkline({
  points,
  costBasis,
  buyDate,
  loading,
}: {
  points: PricePoint[];
  /** The position's average cost — the dashed reference line. */
  costBasis: number;
  /** Buy date (YYYY-MM-DD); marks the line and dims the pre-buy stretch.
   *  Null (no thesis recorded) ⇒ plain trailing window, no marker. */
  buyDate: string | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <p className="font-mono text-[11px] text-text-muted">Loading price history…</p>
    );
  }
  if (points.length < 2) {
    return (
      <p className="font-mono text-[11px] text-text-muted">
        Not enough price history to chart.
      </p>
    );
  }

  const closes = points.map((p) => p.close);
  const lo = Math.min(...closes, costBasis);
  const hi = Math.max(...closes, costBasis);
  const rng = hi - lo || 1;
  const n = points.length;
  const x = (i: number) => P + (i * (W - 2 * P)) / (n - 1);
  const y = (v: number) => H - P - ((v - lo) / rng) * (H - 2 * P);

  // First point on/after the buy date — the marker, and where the line
  // switches from dimmed context to full strength.
  const buyIdx = buyDate ? points.findIndex((p) => p.date >= buyDate) : -1;
  const path = (from: number, to: number) =>
    points
      .slice(from, to + 1)
      .map((p, i) => `${x(from + i).toFixed(1)},${y(p.close).toFixed(1)}`)
      .join(" ");

  const last = points[n - 1];
  const pnlPct = costBasis > 0 ? (last.close / costBasis - 1) * 100 : null;
  const up = last.close >= costBasis;
  const endTone = up ? "var(--color-green, #00ff88)" : "var(--color-red, #ff3333)";

  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return Number.isNaN(dt.getTime())
      ? d
      : dt.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  };
  const fmtUsd = (v: number) =>
    `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full h-[62px]"
        role="img"
        aria-label={`Daily closing price${buyDate ? " since buy" : ""}, latest ${fmtUsd(last.close)} vs entry ${fmtUsd(costBasis)}`}
      >
        {/* Entry price — the reference everything is read against. */}
        <line
          x1={P}
          y1={y(costBasis)}
          x2={W - P}
          y2={y(costBasis)}
          stroke="var(--color-text-muted, #9aa0a6)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        {/* Pre-buy context, dimmed. */}
        {buyIdx > 0 && (
          <polyline
            points={path(0, buyIdx)}
            fill="none"
            stroke="var(--color-cyan)"
            strokeWidth="1.6"
            opacity="0.35"
          />
        )}
        {/* The holding period. */}
        <polyline
          points={path(Math.max(buyIdx, 0), n - 1)}
          fill="none"
          stroke="var(--color-cyan)"
          strokeWidth="1.6"
        />
        {/* Buy marker. */}
        {buyIdx >= 0 && (
          <circle
            cx={x(buyIdx)}
            cy={y(points[buyIdx].close)}
            r="2.8"
            fill="var(--color-cyan)"
            stroke="rgba(0,0,0,0.6)"
            strokeWidth="1"
          />
        )}
        {/* Latest point, toned by price-vs-cost (matches the P&L number). */}
        <circle cx={x(n - 1)} cy={y(last.close)} r="2.8" fill={endTone} />
      </svg>

      <div className="flex justify-between mt-0.5 font-mono text-[9px] text-text-muted">
        <span>{fmtDate(points[0].date)}</span>
        <span>{fmtDate(last.date)}</span>
      </div>

      <div className="flex gap-3.5 mt-1.5 font-mono text-[10px] text-text-muted flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block w-3.5 border-t border-dashed border-text-muted" />
          entry {fmtUsd(costBasis)}
        </span>
        {buyIdx >= 0 && (
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-[7px] w-[7px] rounded-full"
              style={{ background: "var(--color-cyan)" }}
            />
            bought {fmtDate(points[buyIdx].date)}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5" style={{ color: endTone }}>
          <i
            className="inline-block h-[7px] w-[7px] rounded-full"
            style={{ background: endTone }}
          />
          now {fmtUsd(last.close)}
          {pnlPct != null && (
            <> ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}% vs entry)</>
          )}
        </span>
      </div>
    </div>
  );
}
