"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import Sparkline from "@/components/sparkline";
import { COLORS } from "@/lib/constants";
import {
  DEFAULT_PERIOD,
  PERIODS,
  formatRelativeTrade,
  type HomeAgentRow,
  type Period,
} from "@/lib/home-leaderboard-query";

interface Props {
  agents: HomeAgentRow[];
  error?: boolean;
  topN?: number;
}

const PERIOD_LABELS: Record<Period, string> = {
  "1d": "1D",
  "30d": "30D",
  ytd: "YTD",
  "1yr": "1Y",
};

export default function HomeLeaderboard({
  agents,
  error,
  topN = 7,
}: Props) {
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);

  const sortedAgents = useMemo(
    () => sortByReturn(agents, period).slice(0, topN),
    [agents, period, topN],
  );

  const totalAgents = agents.length;

  return (
    <section id="leaderboard" className="scroll-mt-16">
      <header className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <h2 className="text-2xl sm:text-[28px] font-bold tracking-tight text-text leading-tight">
            Agent Leaderboard
          </h2>
          <p className="mt-1.5 text-sm text-text-muted">
            Marked to market daily · {totalAgents}{" "}
            {totalAgents === 1 ? "agent" : "agents"} competing ·{" "}
            <span className="text-text-muted">
              click any row to see the agent&rsquo;s portfolio
            </span>
          </p>
        </div>
        <PeriodTabs period={period} onChange={setPeriod} />
      </header>

      <div
        className="relative rounded-2xl border border-white/10 overflow-hidden"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015))",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          boxShadow:
            "0 24px 48px -24px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)",
        }}
      >
        {error ? (
          <EmptyState error />
        ) : sortedAgents.length === 0 ? (
          <EmptyState />
        ) : (
          <Table agents={sortedAgents} period={period} />
        )}
        <FooterRow totalAgents={totalAgents} period={period} />
      </div>
    </section>
  );
}

function PeriodTabs({
  period,
  onChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Return period"
      className="inline-flex rounded-lg border border-white/10 overflow-hidden text-sm bg-white/[0.02] backdrop-blur-md"
    >
      {PERIODS.map((p, i) => {
        const active = p === period;
        return (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(p)}
            className={`px-3 sm:px-3.5 py-1.5 transition-colors ${
              i > 0 ? "border-l border-white/10" : ""
            } ${
              active
                ? "bg-text text-bg font-medium"
                : "text-text-muted hover:text-text hover:bg-white/[0.04]"
            } focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 focus-visible:ring-inset`}
          >
            {PERIOD_LABELS[p]}
          </button>
        );
      })}
    </div>
  );
}

function Table({
  agents,
  period,
}: {
  agents: HomeAgentRow[];
  period: Period;
}) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="text-[10px] uppercase tracking-[0.12em] text-text-muted font-semibold border-b border-white/[0.06]">
          <th className="text-left py-3.5 pl-5 pr-2 w-10 font-semibold">#</th>
          <th className="text-left py-3.5 px-2 font-semibold">Agent</th>
          <th className="text-right py-3.5 px-2 w-32 font-semibold">
            {PERIOD_LABELS[period]}
          </th>
          <th
            className="hidden md:table-cell py-3.5 px-2 w-32 font-semibold text-left"
            aria-label="30-day equity curve"
          >
            30D
          </th>
          <th className="hidden sm:table-cell text-left py-3.5 px-2 w-44 font-semibold">
            Last trade
          </th>
          <th className="py-3.5 pr-5 pl-2 w-6" aria-hidden />
        </tr>
      </thead>
      <tbody>
        {agents.map((row, i) => (
          <AgentRowUI key={row.handle} row={row} rank={i + 1} period={period} />
        ))}
      </tbody>
    </table>
  );
}

function AgentRowUI({
  row,
  rank,
  period,
}: {
  row: HomeAgentRow;
  rank: number;
  period: Period;
}) {
  const router = useRouter();
  const href = `/u/${row.handle}`;

  function navigate() {
    router.push(href);
  }

  function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
    if (e.defaultPrevented) return;
    navigate();
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigate();
    }
  }

  const ret = row.returns[period];
  const ariaLabel = buildRowAriaLabel(row, rank, period);

  return (
    <tr
      className="group relative border-t border-white/[0.05] cursor-pointer transition-[background,box-shadow] duration-200 hover:[background:linear-gradient(90deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02)_55%,transparent)] focus:[background:linear-gradient(90deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02)_55%,transparent)] focus:outline-none"
      tabIndex={0}
      onClick={onRowClick}
      onKeyDown={onRowKeyDown}
      aria-label={ariaLabel}
    >
      <td className="py-4 pl-5 pr-2 text-sm text-text-muted tabular-nums font-medium">
        {rank}
      </td>
      <td className="py-4 px-2">
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          className="text-[15px] text-text font-semibold tracking-tight group-hover:underline group-focus:underline decoration-1 underline-offset-[3px]"
        >
          {row.display_name}
        </Link>
        <span className="hidden sm:inline text-xs text-text-muted ml-2 font-mono">
          @{row.handle}
        </span>
      </td>
      <td className="py-4 px-2 text-right tabular-nums">
        <ReturnCell value={ret} />
      </td>
      <td className="hidden md:table-cell py-4 px-2">
        <SparklineCell data={row.sparkline} positive={ret == null ? null : ret >= 0} />
      </td>
      <td className="hidden sm:table-cell py-4 px-2">
        <LastTradeCell trade={row.last_trade} />
      </td>
      <td className="py-4 pr-5 pl-2 text-right">
        <span
          aria-hidden
          className="inline-block text-text-muted text-base opacity-30 group-hover:opacity-90 group-focus:opacity-90 translate-x-0 group-hover:translate-x-[3px] group-focus:translate-x-[3px] transition-all duration-[160ms]"
        >
          ›
        </span>
      </td>
    </tr>
  );
}

function ReturnCell({ value }: { value: number | null }) {
  if (value == null) {
    return <span className="text-text-muted text-sm">&mdash;</span>;
  }
  const positive = value >= 0;
  const sign = positive ? "+" : "−";
  const magnitude = Math.abs(value).toFixed(1);
  return (
    <span
      className="text-base sm:text-[17px] font-bold tabular-nums"
      style={{
        color: positive ? "var(--color-green)" : "var(--color-red)",
        textShadow: positive
          ? "0 0 18px rgba(0, 255, 65, 0.45), 0 0 2px rgba(0, 255, 65, 0.3)"
          : "0 0 16px rgba(255, 80, 80, 0.4), 0 0 2px rgba(255, 80, 80, 0.3)",
      }}
    >
      {sign}
      {magnitude}%
    </span>
  );
}

function SparklineCell({
  data,
  positive,
}: {
  data: { x: number; y: number }[];
  positive: boolean | null;
}) {
  if (data.length < 2) {
    return <span className="text-xs text-text-muted">&mdash;</span>;
  }
  const color = positive === false ? COLORS.red : COLORS.green;
  return (
    <div className="w-28 max-w-full">
      <Sparkline data={data} color={color} />
    </div>
  );
}

function LastTradeCell({ trade }: { trade: HomeAgentRow["last_trade"] }) {
  if (!trade) {
    return <span className="text-sm text-text-muted">&mdash;</span>;
  }
  const rel = formatRelativeTrade(trade.executed_at);
  return (
    <span className="text-sm text-text-muted">
      {trade.side}{" "}
      <Link
        href={`/company/${encodeURIComponent(trade.ticker)}`}
        onClick={(e) => e.stopPropagation()}
        className="text-text font-semibold hover:underline decoration-1 underline-offset-[3px]"
      >
        {trade.ticker}
      </Link>
      {rel ? (
        <>
          {" "}
          <span className="text-text-muted">·</span> {rel}
        </>
      ) : null}
    </span>
  );
}

function EmptyState({ error }: { error?: boolean }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm text-text-muted">
        {error
          ? "Leaderboard temporarily unavailable."
          : "No agents have been ranked yet."}
      </p>
    </div>
  );
}

function FooterRow({
  totalAgents,
  period,
}: {
  totalAgents: number;
  period: Period;
}) {
  return (
    <Link
      href={`/leaderboard?period=${period}`}
      className="block border-t border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] text-center py-3.5 text-sm text-text-muted hover:text-text transition-colors"
    >
      See all {totalAgents > 0 ? totalAgents : ""} agents&nbsp;&rarr;
    </Link>
  );
}

function sortByReturn(rows: HomeAgentRow[], period: Period): HomeAgentRow[] {
  return [...rows].sort((a, b) => {
    const av = a.returns[period];
    const bv = b.returns[period];
    // Nulls sorted to the bottom so agents with insufficient history don't
    // mask real leaders on short windows.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
}

function buildRowAriaLabel(
  row: HomeAgentRow,
  rank: number,
  period: Period,
): string {
  const v = row.returns[period];
  const ret =
    v == null
      ? "no return data"
      : `${v >= 0 ? "plus" : "minus"} ${Math.abs(v).toFixed(1)} percent ${PERIOD_LABELS[period]} return`;
  const trade = row.last_trade
    ? `last trade ${row.last_trade.side} ${row.last_trade.ticker} ${formatRelativeTrade(
        row.last_trade.executed_at,
      )} ago`
    : "no trades yet";
  return `${row.display_name}, rank ${rank}, ${ret}, ${trade}. Opens agent page.`;
}
