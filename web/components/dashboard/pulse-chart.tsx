"use client";

import { useMemo } from "react";
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Point {
  date: string;
  pct: number;
}

export interface PulseLine {
  key: string;
  name: string;
  color: string;
  points: Point[];
}

/**
 * Pulse — one equity curve per portfolio vs SPY over the window, each
 * normalised to % return from its own first snapshot in the window (dashboard
 * brief §2). A portfolio funded mid-window simply starts its line on its
 * funding date rather than distorting the others. Read-only; a text summary +
 * table fallback live in the parent for a11y.
 */
export default function PulseChart({
  lines,
  spy,
  height = 260,
}: {
  lines: PulseLine[];
  spy: Point[];
  height?: number;
}) {
  const data = useMemo(() => {
    const dates = [
      ...new Set(lines.flatMap((l) => l.points.map((p) => p.date))),
    ].sort();
    const byLine = lines.map(
      (l) => new Map(l.points.map((p) => [p.date, p.pct])),
    );
    const spyByDate = new Map(spy.map((p) => [p.date, p.pct]));
    // Carry SPY forward across the portfolios' (weekend-inclusive) dates.
    let lastSpy = 0;
    return dates.map((date) => {
      if (spyByDate.has(date)) lastSpy = spyByDate.get(date) as number;
      const row: Record<string, string | number | undefined> = {
        date: date.slice(5),
        spy: lastSpy,
      };
      lines.forEach((l, i) => {
        row[l.key] = byLine[i].get(date);
      });
      return row;
    });
  }, [lines, spy]);

  const nameByKey = useMemo(
    () => new Map(lines.map((l) => [l.key, l.name])),
    [lines],
  );

  if (data.length < 2) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-sm text-text-muted"
      >
        Not enough history yet — your pulse appears once a few daily snapshots
        land.
      </div>
    );
  }

  return (
    <div style={{ height }} role="img" aria-label="Equity curves versus the S&P 500">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v) =>
              `${v > 0 ? "+" : ""}${
                Number.isInteger(v) || Math.abs(v) >= 3
                  ? Math.round(v)
                  : v.toFixed(1)
              }%`
            }
          />
          <Tooltip
            contentStyle={{
              background: "#0b0b0b",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value, name) => {
              const v = typeof value === "number" ? value : Number(value);
              return [
                `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`,
                name === "spy" ? "SPY" : nameByKey.get(String(name)) ?? String(name),
              ];
            }}
          />
          {lines.map((l) => (
            <Line
              key={l.key}
              type="monotone"
              dataKey={l.key}
              stroke={l.color}
              strokeWidth={2}
              dot={false}
            />
          ))}
          <Line
            type="monotone"
            dataKey="spy"
            stroke="rgba(255,255,255,0.4)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
