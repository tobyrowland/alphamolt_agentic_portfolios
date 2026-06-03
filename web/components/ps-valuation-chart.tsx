/**
 * P/S valuation chart — the anchor graphic (brief §6). A weekly
 * price-to-sales line from `price_sales.history_json`, with:
 *   - a dashed 12-month median reference line (median_12m)
 *   - the current point marked (ps_now)
 *   - 52-week high / low context labels
 *
 * Factual framing only — states "above/below its 12-month median", never
 * frames a zone as a buy signal (brief §6, §0.A). Server component:
 * pure inline SVG, so the chart ships in the initial HTML (SSR / good
 * CWV) instead of hydrating client-side. Space is reserved via an
 * aspect-ratio box to avoid layout shift.
 */

import type { PriceSales } from "@/lib/types";

interface Point {
  date: string;
  ps: number;
}

function normalise(
  history: PriceSales["history_json"] | null | undefined,
): Point[] {
  if (!Array.isArray(history)) return [];
  const out: Point[] = [];
  for (const row of history) {
    if (Array.isArray(row)) {
      const [date, ps] = row;
      if (typeof date === "string" && typeof ps === "number") out.push({ date, ps });
    } else if (row && typeof row.date === "string" && typeof row.ps === "number") {
      out.push({ date: row.date, ps: row.ps });
    }
  }
  return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function fmtMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${mon} '${String(d.getUTCFullYear()).slice(2)}`;
}

const W = 620;
const H = 240;
const PAD = { left: 46, right: 72, top: 18, bottom: 28 };

export default function PsValuationChart({
  priceSales,
  psNow,
}: {
  priceSales: PriceSales;
  psNow: number | null;
}) {
  const points = normalise(priceSales.history_json);
  const median = priceSales.median_12m;
  const high = priceSales.high_52w;
  const low = priceSales.low_52w;

  if (points.length < 2) {
    return (
      <p className="text-sm text-text-muted">
        Not enough price-to-sales history to chart yet.
      </p>
    );
  }

  // y-domain spans the series plus the median + current marker, padded.
  const psValues = points.map((p) => p.ps);
  const candidates = [...psValues];
  if (median != null) candidates.push(median);
  if (psNow != null) candidates.push(psNow);
  let yMin = Math.min(...candidates);
  let yMax = Math.max(...candidates);
  if (yMax === yMin) yMax = yMin + 1;
  const padY = (yMax - yMin) * 0.08;
  yMin -= padY;
  yMax += padY;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i / (points.length - 1)) * plotW;
  const y = (v: number) =>
    PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  const linePoints = points.map((p, i) => `${x(i).toFixed(1)},${y(p.ps).toFixed(1)}`).join(" ");

  // High / low markers within the series.
  let hiIdx = 0;
  let loIdx = 0;
  points.forEach((p, i) => {
    if (p.ps > points[hiIdx].ps) hiIdx = i;
    if (p.ps < points[loIdx].ps) loIdx = i;
  });

  const lastIdx = points.length - 1;
  const currentPs = psNow ?? points[lastIdx].ps;
  const curX = x(lastIdx);
  const curY = y(currentPs);

  const medY = median != null ? y(median) : null;

  // x-axis: first / mid / last date.
  const midIdx = Math.floor(lastIdx / 2);

  const aboveBelow =
    median != null && median > 0
      ? currentPs >= median
        ? "above"
        : "below"
      : null;
  const pctVsMedian =
    median != null && median > 0
      ? Math.abs(Math.round(((currentPs - median) / median) * 100))
      : null;

  const ariaLabel =
    `${priceSales.ticker} price-to-sales over the last year: ` +
    `ranged ${low?.toFixed(2) ?? "?"}× to ${high?.toFixed(2) ?? "?"}×, ` +
    `currently ${currentPs.toFixed(2)}×` +
    (median != null
      ? `, ${pctVsMedian}% ${aboveBelow} its ${median.toFixed(2)}× twelve-month median.`
      : ".");

  return (
    <div style={{ aspectRatio: `${W} / ${H}` }} className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* 12-month median reference line (dashed, neutral) */}
        {medY != null && (
          <>
            <line
              x1={PAD.left}
              y1={medY}
              x2={W - PAD.right}
              y2={medY}
              stroke="#5e696f"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            <text
              x={W - PAD.right + 4}
              y={medY + 3.5}
              fontSize={11}
              fill="#A1A1AA"
              fontFamily="monospace"
            >
              {median!.toFixed(2)} med
            </text>
          </>
        )}

        {/* P/S line */}
        <polyline
          fill="none"
          stroke="#7f9aa2"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={linePoints}
        />

        {/* 52w high / low context markers */}
        <circle cx={x(hiIdx)} cy={y(points[hiIdx].ps)} r={3} fill="#5e696f" />
        <text
          x={x(hiIdx) + 6}
          y={y(points[hiIdx].ps) - 4}
          fontSize={10.5}
          fill="#A1A1AA"
          fontFamily="monospace"
        >
          {points[hiIdx].ps.toFixed(2)}× high
        </text>
        <circle cx={x(loIdx)} cy={y(points[loIdx].ps)} r={3} fill="#5e696f" />
        <text
          x={x(loIdx) + 6}
          y={y(points[loIdx].ps) + 12}
          fontSize={10.5}
          fill="#A1A1AA"
          fontFamily="monospace"
        >
          {points[loIdx].ps.toFixed(2)}× low
        </text>

        {/* current marker (cyan, neutral accent) */}
        <circle cx={curX} cy={curY} r={4.5} fill="#00F2FF" />
        <text
          x={curX - 6}
          y={curY - 8}
          fontSize={10.5}
          fill="#00F2FF"
          fontFamily="monospace"
          textAnchor="end"
        >
          {currentPs.toFixed(2)}× now
        </text>

        {/* x-axis date labels */}
        <text x={PAD.left} y={H - 8} fontSize={10.5} fill="#5e696f" fontFamily="monospace">
          {fmtMonth(points[0].date)}
        </text>
        <text
          x={x(midIdx)}
          y={H - 8}
          fontSize={10.5}
          fill="#5e696f"
          fontFamily="monospace"
          textAnchor="middle"
        >
          {fmtMonth(points[midIdx].date)}
        </text>
        <text
          x={W - PAD.right}
          y={H - 8}
          fontSize={10.5}
          fill="#5e696f"
          fontFamily="monospace"
          textAnchor="end"
        >
          {fmtMonth(points[lastIdx].date)}
        </text>
      </svg>
    </div>
  );
}
