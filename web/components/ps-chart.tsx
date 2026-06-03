"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

// History rows on `price_sales.history_json` are stored as
// `[date, ps_value]` tuples by price_sales_updater.py (see
// price_sales_updater.py:364). The TS type `Array<{date, ps}>` on
// lib/types.ts was aspirational — Recharts couldn't find the keys on
// the tuples, so the chart rendered axis labels only with no plotted
// series. Accept both shapes here and normalise.
type PsHistoryRow =
  | { date: string; ps: number }
  | [string, number];

interface PsDataPoint {
  date: string;
  ps: number;
}

function normalise(row: PsHistoryRow): PsDataPoint | null {
  if (Array.isArray(row)) {
    const [date, ps] = row;
    if (typeof date !== "string" || typeof ps !== "number") return null;
    return { date, ps };
  }
  if (typeof row?.date !== "string" || typeof row?.ps !== "number") return null;
  return { date: row.date, ps: row.ps };
}

export default function PsChart({ data }: { data: PsHistoryRow[] }) {
  const points = data
    .map(normalise)
    .filter((p): p is PsDataPoint => p !== null);
  const sorted = [...points].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={sorted}>
          <defs>
            <linearGradient id="psGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00FF41" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#00FF41" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "#A1A1AA", fontFamily: "monospace" }}
            tickLine={false}
            axisLine={{ stroke: "#222222" }}
            tickFormatter={(d: string) => {
              const date = new Date(d);
              return `${date.getMonth() + 1}/${String(date.getFullYear()).slice(2)}`;
            }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#A1A1AA", fontFamily: "monospace" }}
            tickLine={false}
            axisLine={{ stroke: "#222222" }}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111111",
              border: "1px solid #222222",
              borderRadius: "4px",
              fontFamily: "monospace",
              fontSize: "12px",
            }}
            labelStyle={{ color: "#D4D4D8" }}
            itemStyle={{ color: "#00FF41" }}
            formatter={(value) => [Number(value).toFixed(2), "P/S"]}
          />
          <Area
            type="monotone"
            dataKey="ps"
            stroke="#00FF41"
            strokeWidth={1.5}
            fill="url(#psGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
