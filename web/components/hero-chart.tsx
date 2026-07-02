"use client";

/**
 * Homepage hero chart — "Alpha-Pulse".
 *
 * Renders the last 30 days of total_value_usd for the top 4 agents plus
 * normalised SPY/URTH curves. One agent is "spotlit" at a time (cyan
 * stroke + drop-shadow glow); the others render dimmed. Clicking a
 * model chip rotates the spotlight; clicking a benchmark chip toggles
 * its visibility. Tooltip surfaces the spotlit agent's value at the
 * hovered day plus its % change vs day 1.
 *
 * Recharts handles draw-in via its built-in left-to-right animation —
 * `animationDuration` on each `<Line>` is tuned (see DRAW_MS below) to
 * read as "drawing in" without delaying perceived page completion.
 * Skips Framer Motion entirely so we stay under the 100KB JS budget.
 */

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HeroChartData, HeroChartSeries } from "@/lib/hero-chart-query";

// Recharts v3 omits `payload` from the public `TooltipProps` type (it's
// read from an internal context and injected via cloneElement at render
// time). We define a minimal local shape for the fields we actually
// consume — keeps the build green regardless of upstream type changes.
interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number | string | Array<number | string>;
  name?: string;
}
interface InjectedTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
}

// Spec colours from the brief, tuned for legibility against #0A0A0A.
const HERO_CYAN = "#00F2FF";
const AGENT_DIM = "rgba(160, 210, 230, 0.55)";
const BENCH_COLORS: Record<string, string> = {
  "SPY.US": "#FF4B4B",
  "URTH.US": "#888888",
};

// Draw-in animation. The brief asked for 2s but real-user feedback was
// that the long sweep delayed perceived page completion; 600ms still
// reads as "drawing in" without holding the eye hostage.
const DRAW_MS = 600;

// Round a raw [lo, hi] data range out to clean, evenly-spaced gridlines so
// the Y axis reads as $0.80M / $0.90M / $1.00M … rather than the irregular
// values Recharts derives from a padded data domain. Steps climb a fixed
// ladder of "nice" dollar amounts; bounds floor/ceil onto the chosen step,
// which also gives the top line headroom without clipping.
function niceAxis(lo: number, hi: number): {
  yMin: number;
  yMax: number;
  ticks: number[];
} {
  const span = hi - lo || Math.max(Math.abs(hi), 1) * 0.1;
  const STEPS = [
    10_000, 20_000, 25_000, 50_000, 100_000, 200_000, 250_000, 500_000,
    1_000_000, 2_000_000,
  ];
  const step = STEPS.find((s) => s >= span / 4) ?? STEPS[STEPS.length - 1];
  const yMin = Math.floor(lo / step) * step;
  const yMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = yMin; v <= yMax + step * 0.5; v += step) ticks.push(v);
  return { yMin, yMax, ticks };
}

export default function HeroChart({ data }: { data: HeroChartData }) {
  const agents = useMemo(
    () => data.series.filter((s) => s.type === "agent"),
    [data.series],
  );
  const benchmarks = useMemo(
    () => data.series.filter((s) => s.type === "benchmark"),
    [data.series],
  );

  const [hero, setHero] = useState<string | null>(agents[0]?.key ?? null);
  const [hiddenBenchmarks, setHiddenBenchmarks] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleBenchmark = (key: string) => {
    setHiddenBenchmarks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Y-axis bounds across every visible series so the lines fill the frame.
  const { yMin, yMax, yTicks } = useMemo(() => {
    const visible: HeroChartSeries[] = [
      ...agents,
      ...benchmarks.filter((b) => !hiddenBenchmarks.has(b.key)),
    ];
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of data.points) {
      for (const s of visible) {
        const v = p[s.key];
        if (typeof v === "number") {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = data.startingValue * 0.95;
      hi = data.startingValue * 1.05;
    }
    const nice = niceAxis(lo, hi);
    return { yMin: nice.yMin, yMax: nice.yMax, yTicks: nice.ticks };
  }, [data.points, data.startingValue, agents, benchmarks, hiddenBenchmarks]);

  // Empty state: no agents or no points yet (fresh DB, before
  // portfolio_valuation.py has ever run). Fall back to a quiet placeholder
  // so the page still renders.
  if (agents.length === 0 || data.points.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-sm text-text-muted font-mono"
      >
        Waiting on the first portfolio snapshot — agents will appear here
        once portfolio_valuation.py runs.
      </div>
    );
  }

  const ariaLabel = `30-day equity curves for ${agents.length} AI agents (${agents
    .map((a) => a.label)
    .join(", ")}) compared with ${benchmarks
    .map((b) => b.label)
    .join(" and ")} benchmarks. All start at $1,000,000.`;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="rounded-2xl overflow-hidden border border-white/10 bg-white/[0.02]"
    >
      <Header
        agents={agents}
        benchmarks={benchmarks}
        hero={hero}
        hiddenBenchmarks={hiddenBenchmarks}
        onPickAgent={setHero}
        onToggleBenchmark={toggleBenchmark}
      />

      <div className="h-[300px] sm:h-[360px] w-full px-2 sm:px-4 pb-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data.points}
            margin={{ top: 12, right: 24, bottom: 8, left: 8 }}
          >
            <CartesianGrid
              stroke="rgba(255,255,255,0.06)"
              strokeDasharray="2 4"
              vertical={false}
            />
            <XAxis
              dataKey="day"
              tick={{
                fontSize: 10,
                fill: "#A1A1AA",
                fontFamily: "var(--font-jetbrains-mono), monospace",
              }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.10)" }}
              tickFormatter={(d: number) => `D${d}`}
              interval={4}
            />
            <YAxis
              tick={{
                fontSize: 10,
                fill: "#A1A1AA",
                fontFamily: "var(--font-jetbrains-mono), monospace",
              }}
              tickLine={false}
              axisLine={false}
              domain={[yMin, yMax]}
              ticks={yTicks}
              width={56}
              tickFormatter={(v: number) =>
                `$${(v / 1_000_000).toFixed(2)}M`
              }
            />
            <Tooltip
              cursor={{
                stroke: "rgba(255,255,255,0.15)",
                strokeDasharray: "3 3",
              }}
              content={
                <HeroTooltip
                  hero={hero}
                  series={data.series}
                  startingValue={data.startingValue}
                />
              }
            />

            {/* Render order = z-order. Benchmarks under, dim agents above,
                spotlit agent on top so the glow isn't masked. */}
            {benchmarks.map((b) =>
              hiddenBenchmarks.has(b.key) ? null : (
                <Line
                  key={b.key}
                  type="monotone"
                  dataKey={b.key}
                  stroke={BENCH_COLORS[b.key] ?? "#888888"}
                  strokeWidth={1.25}
                  strokeOpacity={0.85}
                  dot={false}
                  activeDot={false}
                  isAnimationActive
                  animationDuration={DRAW_MS}
                  animationEasing="ease-out"
                />
              ),
            )}
            {agents
              .filter((a) => a.key !== hero)
              .map((a) => (
                <Line
                  key={a.key}
                  type="monotone"
                  dataKey={a.key}
                  stroke={AGENT_DIM}
                  strokeWidth={1.25}
                  dot={false}
                  activeDot={{ r: 3, fill: AGENT_DIM, stroke: "none" }}
                  isAnimationActive
                  animationDuration={DRAW_MS}
                  animationEasing="ease-out"
                />
              ))}
            {hero && (
              <Line
                key={hero}
                type="monotone"
                dataKey={hero}
                stroke={HERO_CYAN}
                strokeWidth={2.25}
                dot={false}
                activeDot={{
                  r: 4.5,
                  fill: HERO_CYAN,
                  stroke: "#050505",
                  strokeWidth: 2,
                }}
                isAnimationActive
                animationDuration={DRAW_MS}
                animationEasing="ease-out"
                style={{ filter: "drop-shadow(0 0 6px #00F2FF)" }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <Footer
        points={data.points}
        hero={hero}
        startingValue={data.startingValue}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header: model selector + benchmark toggles
// ---------------------------------------------------------------------------

function Header({
  agents,
  benchmarks,
  hero,
  hiddenBenchmarks,
  onPickAgent,
  onToggleBenchmark,
}: {
  agents: HeroChartSeries[];
  benchmarks: HeroChartSeries[];
  hero: string | null;
  hiddenBenchmarks: Set<string>;
  onPickAgent: (key: string) => void;
  onToggleBenchmark: (key: string) => void;
}) {
  return (
    <div className="px-4 pt-4 pb-3 border-b border-white/[0.06] flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="w-1.5 h-1.5 rounded-full bg-[var(--color-green)]"
            style={{ boxShadow: "0 0 6px rgba(0,255,65,0.6)" }}
          />
          <span className="text-[11px] uppercase tracking-[0.14em] text-text-muted font-mono">
            Swarm Explorer · 30-day live
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted font-mono mr-1">
          Swarm:
        </span>
        {agents.map((a) => {
          const active = a.key === hero;
          return (
            <button
              key={a.key}
              type="button"
              onClick={() => onPickAgent(a.key)}
              className={`text-xs font-mono rounded-md px-2.5 py-1 border transition-colors ${
                active
                  ? "border-[#00F2FF]/60 text-[#00F2FF] bg-[#00F2FF]/[0.07]"
                  : "border-white/10 text-text-dim hover:text-text hover:border-white/20"
              }`}
              style={
                active
                  ? { boxShadow: "0 0 12px rgba(0,242,255,0.25)" }
                  : undefined
              }
            >
              {a.label}
            </button>
          );
        })}
        {benchmarks.length > 0 && (
          <span className="text-[10px] uppercase tracking-wider text-text-muted font-mono mx-1 ml-3">
            Benchmarks:
          </span>
        )}
        {benchmarks.map((b) => {
          const visible = !hiddenBenchmarks.has(b.key);
          const color = BENCH_COLORS[b.key] ?? "#888888";
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => onToggleBenchmark(b.key)}
              aria-pressed={visible}
              className={`text-xs font-mono rounded-md px-2.5 py-1 border transition-colors inline-flex items-center gap-1.5 ${
                visible
                  ? "border-white/10 text-text-dim"
                  : "border-white/[0.06] text-text-muted line-through"
              }`}
            >
              <span
                aria-hidden
                className="w-2 h-2 rounded-sm"
                style={{
                  background: visible ? color : "transparent",
                  border: `1px solid ${color}`,
                }}
              />
              {b.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer: latest value + delta vs day 1 for the spotlit agent
// ---------------------------------------------------------------------------

function Footer({
  points,
  hero,
  startingValue,
}: {
  points: HeroChartData["points"];
  hero: string | null;
  startingValue: number;
}) {
  if (!hero || points.length === 0) return null;
  const lastValue = (() => {
    for (let i = points.length - 1; i >= 0; i--) {
      const v = points[i][hero];
      if (typeof v === "number") return v;
    }
    return null;
  })();
  if (lastValue == null) return null;
  const change = ((lastValue - startingValue) / startingValue) * 100;
  const positive = change >= 0;

  return (
    <div className="px-4 py-3 border-t border-white/[0.06] flex flex-wrap items-baseline justify-between gap-2">
      <div className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
        Latest mark-to-market
      </div>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-base font-bold text-text">
          $
          {lastValue.toLocaleString("en-US", {
            maximumFractionDigits: 0,
          })}
        </span>
        <span
          className="font-mono text-xs font-bold"
          style={{ color: positive ? "#00F2FF" : "#FF4B4B" }}
        >
          {positive ? "+" : ""}
          {change.toFixed(2)}%{" "}
          <span className="text-text-muted font-normal">vs D1</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip: portfolio value + delta vs day 1 for the spotlit series
// ---------------------------------------------------------------------------

function HeroTooltip({
  active,
  payload,
  label,
  hero,
  series,
  startingValue,
}: InjectedTooltipProps & {
  hero: string | null;
  series: HeroChartSeries[];
  startingValue: number;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const heroRow = hero
    ? payload.find((p) => p.dataKey === hero)
    : payload[0];
  if (!heroRow || typeof heroRow.value !== "number") return null;

  const heroSeries = series.find((s) => s.key === heroRow.dataKey);
  const value = heroRow.value;
  const change = ((value - startingValue) / startingValue) * 100;
  const positive = change >= 0;

  return (
    <div
      className="rounded-md font-mono text-xs px-3 py-2 backdrop-blur-md"
      style={{
        background: "rgba(10,10,10,0.92)",
        border: "1px solid rgba(0,242,255,0.35)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(0,242,255,0.18)",
      }}
    >
      <p className="text-text-muted">Day {label}</p>
      <p className="text-[#00F2FF] font-bold mt-0.5">
        {heroSeries?.label ?? heroRow.dataKey}
      </p>
      <p className="text-text mt-1">
        $
        {value.toLocaleString("en-US", {
          maximumFractionDigits: 0,
        })}
      </p>
      <p style={{ color: positive ? "#00F2FF" : "#FF4B4B" }}>
        {positive ? "+" : ""}
        {change.toFixed(2)}% vs D1
      </p>
    </div>
  );
}
