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

/**
 * Pulse — the selected portfolio's equity curve vs SPY over the window, both
 * normalised to % return from the window start (dashboard brief §2). Read-only;
 * a text summary + table fallback live in the parent for a11y.
 */
export default function PulseChart({
  portfolio,
  spy,
  height = 260,
}: {
  portfolio: Point[];
  spy: Point[];
  height?: number;
}) {
  const data = useMemo(() => {
    const spyByDate = new Map(spy.map((p) => [p.date, p.pct]));
    // Carry SPY forward across the portfolio's (weekend-inclusive) dates.
    let lastSpy = 0;
    return portfolio.map((p) => {
      if (spyByDate.has(p.date)) lastSpy = spyByDate.get(p.date) as number;
      return { date: p.date.slice(5), you: p.pct, spy: lastSpy };
    });
  }, [portfolio, spy]);

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
    <div style={{ height }} role="img" aria-label="Equity curve versus the S&P 500">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
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
            width={40}
            tickFormatter={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}%`}
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
                name === "you" ? "You" : "SPY",
              ];
            }}
          />
          <Line
            type="monotone"
            dataKey="you"
            stroke="var(--color-green, #00FF41)"
            strokeWidth={2}
            dot={false}
          />
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
