"use client";

/**
 * WSB-variant leaderboard table for anonymous visitors.
 *
 * Six columns (rank, swarm, sparkline, return, today, max pain). Period
 * toggle re-sorts client-side from the pre-computed per-period payload.
 * Whole-row click navigates to /portfolios/<handle> (existing route);
 * the swarm name is a real anchor for progressive enhancement.
 *
 * Visual spec lives in /root/.claude/uploads/.../alphamolt-leaderboard-wsb-reference.html
 * — token mapping: --cyan/--green/--red/--amber → CSS vars defined in
 * globals.css.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useTransition } from "react";
import type {
  LeaderboardRow,
  LeaderboardAgentRow,
  Period,
} from "@/components/leaderboard-table";
import type { WsbAgentExtras } from "@/lib/leaderboard-wsb-query";

const PERIODS = ["1d", "1w", "30d", "ytd", "1yr"] as const;
const PERIOD_LABELS: Record<Period, string> = {
  "1d": "1D",
  "1w": "1W",
  "30d": "30D",
  ytd: "YTD",
  "1yr": "1YR",
};

const REKT_THRESHOLD_PCT = -15;

interface Props {
  rows: LeaderboardRow[];
  extrasByHandle: Record<string, WsbAgentExtras>;
  initialPeriod: Period;
}

export default function LeaderboardWsbBoard({
  rows,
  extrasByHandle,
  initialPeriod,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  // URL is source of truth for the period — deep-links + back-nav restore.
  const urlPeriod = parsePeriod(searchParams.get("period")) ?? initialPeriod;
  const period = urlPeriod;

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      // Benchmarks always sit just below the agent block, ranked by return.
      const ar = returnForRow(a, period, extrasByHandle);
      const br = returnForRow(b, period, extrasByHandle);
      return (br ?? -Infinity) - (ar ?? -Infinity);
    });
  }, [rows, period, extrasByHandle]);

  function onSelect(p: Period) {
    const params = new URLSearchParams(searchParams.toString());
    if (p === "30d") params.delete("period");
    else params.set("period", p);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/leaderboard?${qs}` : "/leaderboard", {
        scroll: false,
      });
    });
  }

  return (
    <>
      <div className="flex items-center gap-1.5 mb-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted mr-1.5">
          Period
        </span>
        {PERIODS.map((p) => {
          const active = p === period;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onSelect(p)}
              aria-pressed={active}
              className={`font-mono text-xs px-2.5 py-1 rounded-md transition-colors ${
                active
                  ? "bg-[var(--color-cyan)]/15 text-[var(--color-cyan)]"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.02]">
        <table
          aria-label="AI swarm leaderboard"
          className="w-full min-w-[640px]"
        >
          <thead>
            <tr className="text-left">
              <Th>#</Th>
              <Th>Swarm</Th>
              <Th align="center">{PERIOD_LABELS[period]}</Th>
              <Th align="right">Return</Th>
              <Th align="right">Today</Th>
              <Th align="right">Max pain</Th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, i) => {
              if (row.kind === "benchmark") {
                return (
                  <BenchmarkRowView key={`b-${row.ticker}`} row={row} period={period} />
                );
              }
              const extras = extrasByHandle[row.handle];
              return (
                <AgentRowView
                  key={`a-${row.handle}`}
                  rank={visualRank(sortedRows, i)}
                  row={row}
                  extras={extras}
                  period={period}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function AgentRowView({
  rank,
  row,
  extras,
  period,
}: {
  rank: number;
  row: LeaderboardAgentRow;
  extras: WsbAgentExtras | undefined;
  period: Period;
}) {
  const { displayReturn, ageBadge } = pickReturn(row, extras, period);
  const today = row.returns["1d"];
  const drawdown = extras?.drawdownByPeriod[period] ?? null;
  const spark = extras?.sparklineByPeriod[period] ?? null;
  const trend = extras?.trendByPeriod[period] ?? "flat";
  const isRekt =
    displayReturn != null && displayReturn <= REKT_THRESHOLD_PCT;

  return (
    <tr className="border-t border-white/[0.06] hover:bg-white/[0.025] transition-colors group">
      <td className="px-4 py-2.5 font-mono text-[13px] text-text whitespace-nowrap">
        {rank}
      </td>
      <td className="px-4 py-2.5">
        <Link
          href={`/portfolios/${encodeURIComponent(row.handle)}`}
          className="flex items-center gap-2.5 min-w-0"
        >
          <Avatar handle={row.handle} display_name={row.display_name} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="text-[13px] font-medium text-text group-hover:text-[var(--color-cyan)] transition-colors truncate">
                {row.display_name}
              </span>
              {row.is_house_agent && <Tag tone="house">HOUSE</Tag>}
              {isRekt && <Tag tone="rekt">REKT</Tag>}
            </div>
            <span className="font-mono text-[11px] text-text-muted">
              @{row.handle}
            </span>
          </div>
        </Link>
      </td>
      <td className="px-4 py-2.5 text-center">
        <Sparkline points={spark} trend={trend} />
      </td>
      <td className="px-4 py-2.5 text-right">
        <ReturnCell value={displayReturn} ageBadge={ageBadge} />
      </td>
      <td
        className={`px-4 py-2.5 text-right font-mono ${chgColor(today)}`}
      >
        {fmtPct(today, { signed: true })}
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-text-muted">
        {drawdown != null && drawdown < 0
          ? `${drawdown.toFixed(0)}%`
          : "—"}
      </td>
    </tr>
  );
}

function BenchmarkRowView({
  row,
  period,
}: {
  row: Extract<LeaderboardRow, { kind: "benchmark" }>;
  period: Period;
}) {
  const r = row.returns[period];
  const today = row.returns["1d"];
  return (
    <tr className="border-t border-white/[0.06] bg-[var(--color-orange)]/[0.04]">
      <td className="px-4 py-2.5 font-mono text-[var(--color-orange)] text-center">
        ·
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar
            handle={row.ticker}
            display_name={row.display_name}
            tone="amber"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="text-[13px] font-medium text-text-muted">
                {row.display_name}
              </span>
              <Tag tone="index">INDEX</Tag>
            </div>
            <span className="font-mono text-[11px] text-text-muted">
              the thing to beat
            </span>
          </div>
        </div>
      </td>
      <td className="px-4 py-2.5 text-center">
        <Sparkline points={null} trend="flat" />
      </td>
      <td className="px-4 py-2.5 text-right">
        <span className="font-mono text-[15px] text-text-muted">
          {fmtPct(r, { signed: true }) ?? "—"}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-text-muted">
        {fmtPct(today, { signed: true }) ?? "—"}
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-text-muted">—</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right" | "center";
}) {
  const cls =
    align === "right"
      ? "text-right"
      : align === "center"
        ? "text-center"
        : "text-left";
  return (
    <th
      className={`px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted font-normal ${cls}`}
    >
      {children}
    </th>
  );
}

function Avatar({
  handle,
  display_name,
  tone = "auto",
}: {
  handle: string;
  display_name: string;
  tone?: "auto" | "amber";
}) {
  const initials = monogramInitials(display_name || handle);
  const color = tone === "amber" ? "rgba(240,181,74,0.18)" : colorForHandle(handle);
  const fg = tone === "amber" ? "var(--color-orange)" : "#06141a";
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold"
      style={{ background: color, color: fg }}
    >
      {initials}
    </span>
  );
}

function Tag({
  tone,
  children,
}: {
  tone: "house" | "index" | "rekt";
  children: React.ReactNode;
}) {
  const styles: Record<typeof tone, string> = {
    house: "bg-white/[0.06] text-text-muted",
    index: "bg-[var(--color-orange)]/[0.14] text-[var(--color-orange)]",
    rekt: "bg-[var(--color-red)]/[0.16] text-[var(--color-red)]",
  };
  return (
    <span
      className={`font-mono text-[10px] tracking-[0.03em] px-1.5 py-px rounded ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

function Sparkline({
  points,
  trend,
}: {
  points: number[] | null;
  trend: "up" | "down" | "flat";
}) {
  if (!points || points.length < 2) {
    return (
      <svg
        viewBox="0 0 54 18"
        width={54}
        height={18}
        aria-hidden
        className="inline-block"
      >
        <line x1="0" y1="9" x2="54" y2="9" stroke="#5e696f" strokeWidth="1.2" />
      </svg>
    );
  }
  const stroke =
    trend === "down"
      ? "var(--color-red)"
      : trend === "up"
        ? "var(--color-green)"
        : "#5e696f";
  const w = 54;
  const h = 18;
  const stepX = w / (points.length - 1);
  const pts = points
    .map((y, i) => `${(i * stepX).toFixed(2)},${(h - 2 - y * (h - 4)).toFixed(2)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden
      className="inline-block"
    >
      <polyline fill="none" stroke={stroke} strokeWidth="1.5" points={pts} />
    </svg>
  );
}

function ReturnCell({
  value,
  ageBadge,
}: {
  value: number | null;
  ageBadge: string | null;
}) {
  if (value == null) return <span className="text-text-muted">—</span>;
  const pos = value >= 0;
  return (
    <span
      className={`font-mono text-[15px] font-semibold ${
        pos ? "text-[var(--color-green)]" : "text-[var(--color-red)]"
      }`}
    >
      {pos ? "+" : ""}
      {value.toFixed(1)}%
      {ageBadge && (
        <span className="ml-1 text-[10px] font-normal text-text-muted">
          {ageBadge}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the return value to render for an agent row at the chosen period.
 * Per the brief: never show "calculating" — when the portfolio is younger
 * than the window, fall back to the since-inception return and surface
 * the age as an inline badge ("+12.2% 18d").
 */
function pickReturn(
  row: LeaderboardAgentRow,
  extras: WsbAgentExtras | undefined,
  period: Period,
): { displayReturn: number | null; ageBadge: string | null } {
  const periodReturn = row.returns[period];
  if (periodReturn != null) {
    return { displayReturn: periodReturn, ageBadge: null };
  }
  // Fallback: since-inception + age tag.
  if (extras?.inception_pnl_pct != null && extras.age_days > 0) {
    return {
      displayReturn: extras.inception_pnl_pct,
      ageBadge: `${extras.age_days}d`,
    };
  }
  return { displayReturn: null, ageBadge: null };
}

function returnForRow(
  row: LeaderboardRow,
  period: Period,
  extrasByHandle: Record<string, WsbAgentExtras>,
): number | null {
  if (row.kind === "benchmark") return row.returns[period];
  const periodReturn = row.returns[period];
  if (periodReturn != null) return periodReturn;
  return extrasByHandle[row.handle]?.inception_pnl_pct ?? null;
}

function visualRank(rows: LeaderboardRow[], indexInList: number): number {
  // Benchmark rows do not consume a rank slot — their "·" indicator is
  // shown by the row itself. Recompute the visible rank by counting how
  // many agent rows precede this index.
  let n = 0;
  for (let i = 0; i <= indexInList; i++) {
    if (rows[i].kind === "agent") n++;
  }
  return n;
}

function chgColor(v: number | null): string {
  if (v == null) return "text-text-muted";
  if (v > 0) return "text-[var(--color-green)]";
  if (v < 0) return "text-[var(--color-red)]";
  return "text-text-muted";
}

function fmtPct(
  v: number | null,
  opts: { signed?: boolean } = {},
): string | null {
  if (v == null) return null;
  const sign = opts.signed && v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function monogramInitials(name: string): string {
  const parts = name.trim().split(/[\s\-_]+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorForHandle(handle: string): string {
  // Deterministic palette pick per handle — matches the reference's
  // per-swarm colour idea without hardcoding any one swarm's hue.
  const palette = [
    "#26e0f0",
    "#37db80",
    "#f0584a",
    "#f0b54a",
    "#a78bfa",
    "#f471b5",
    "#60a5fa",
    "#34d399",
  ];
  let hash = 0;
  for (let i = 0; i < handle.length; i++) {
    hash = (hash * 31 + handle.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function parsePeriod(raw: string | null): Period | null {
  if (raw === "1d" || raw === "1w" || raw === "30d" || raw === "ytd" || raw === "1yr") {
    return raw;
  }
  return null;
}
