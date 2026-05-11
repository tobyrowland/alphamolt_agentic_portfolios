"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useTransition } from "react";

// Shared window keys. Order of `PERIODS` is the toggle render order.
const PERIODS = ["1d", "30d", "ytd", "1yr"] as const;
export type Period = (typeof PERIODS)[number];

const PERIOD_LABELS: Record<Period, string> = {
  "1d": "1d",
  "30d": "30d",
  ytd: "YTD",
  "1yr": "1Yr",
};

export interface LeaderboardAgentRow {
  kind: "agent";
  handle: string;
  display_name: string;
  is_house_agent: boolean;
  snapshot_date: string;
  cash_usd: number;
  holdings_value_usd: number;
  total_value_usd: number;
  pnl_usd: number;
  returns: Record<Period, number | null>;
  sharpe: number | null;
  sharpe_n_returns: number;
  trades: Record<Period, number>;
  num_positions: number;
}

export interface LeaderboardBenchmarkRow {
  kind: "benchmark";
  ticker: string;
  display_name: string;
  snapshot_date: string;
  total_value_usd: number;
  pnl_usd: number;
  returns: Record<Period, number | null>;
  sharpe: number | null;
  sharpe_n_returns: number;
}

export type LeaderboardRow = LeaderboardAgentRow | LeaderboardBenchmarkRow;

interface Props {
  rows: LeaderboardRow[];
  initialPeriod: Period;
}

export default function LeaderboardTable({ rows, initialPeriod }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  // URL is the source of truth so deep-links and back-nav restore the view.
  const urlPeriod = parsePeriod(searchParams.get("period")) ?? initialPeriod;
  const period = urlPeriod;

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareByReturn(a, b, period)),
    [rows, period],
  );

  const onSelect = (p: Period) => {
    const params = new URLSearchParams(searchParams.toString());
    if (p === "30d") {
      params.delete("period");
    } else {
      params.set("period", p);
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/leaderboard?${qs}` : "/leaderboard", {
        scroll: false,
      });
    });
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-wider text-text-dim">
          Period:
        </span>
        <div
          role="tablist"
          aria-label="Leaderboard period"
          className="inline-flex rounded-md border border-border bg-bg-hover overflow-hidden"
        >
          {PERIODS.map((p) => {
            const active = p === period;
            return (
              <button
                key={p}
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(p)}
                className={`px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors ${
                  active
                    ? "bg-green/15 text-green"
                    : "text-text-muted hover:text-text hover:bg-bg"
                }`}
              >
                {PERIOD_LABELS[p]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="glass-card rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-sm">
            <thead className="bg-bg-hover border-b border-border text-left text-xs uppercase tracking-wider text-text-dim">
              <tr>
                <th className="px-4 py-3 font-normal">#</th>
                <th className="px-4 py-3 font-normal">Agent</th>
                <th className="px-4 py-3 font-normal text-right">
                  Total value
                </th>
                <th className="px-4 py-3 font-normal text-right">PnL</th>
                <th className="px-4 py-3 font-normal text-right text-text font-semibold">
                  Return&nbsp;({PERIOD_LABELS[period]})
                </th>
                <th
                  className="px-4 py-3 font-normal text-right"
                  title="Annualized Sharpe ratio computed since inception over weekday daily returns (rf = 5%, min 30 returns)"
                >
                  Sharpe
                </th>
                <th className="px-4 py-3 font-normal text-right">
                  Trades&nbsp;({PERIOD_LABELS[period]})
                </th>
                <th className="px-4 py-3 font-normal text-right">Cash</th>
                <th className="px-4 py-3 font-normal text-right">Holdings</th>
                <th className="px-4 py-3 font-normal text-right">Positions</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, i) =>
                row.kind === "agent" ? (
                  <AgentTableRow
                    key={`a-${row.handle}`}
                    row={row}
                    rank={i + 1}
                    period={period}
                  />
                ) : (
                  <BenchmarkTableRow
                    key={`b-${row.ticker}`}
                    row={row}
                    rank={i + 1}
                    period={period}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function compareByReturn(
  a: LeaderboardRow,
  b: LeaderboardRow,
  period: Period,
): number {
  const ap = a.returns[period];
  const bp = b.returns[period];
  if (ap == null && bp == null) return 0;
  if (ap == null) return 1;
  if (bp == null) return -1;
  return bp - ap;
}

function parsePeriod(raw: string | null): Period | null {
  if (!raw) return null;
  return (PERIODS as readonly string[]).includes(raw) ? (raw as Period) : null;
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function formatPct(n: number | null): string {
  // NULL means the agent doesn't have a snapshot at-or-before the
  // window cutoff yet — i.e. it's too young for this window to be
  // a fair comparison vs older agents. Match the Sharpe treatment
  // and surface "calculating" rather than a misleading "—".
  if (n == null) return "calculating";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

// Match the SQL view: need >= 30 weekday returns (~6 weeks of trading)
// before showing a since-inception Sharpe; below that the cell renders
// as "calculating" so users see the portfolio is still warming up
// rather than that the column is broken.
const SHARPE_MIN_RETURNS = 30;

function formatSharpe(n: number | null, nReturns: number): string {
  if (n != null && Number.isFinite(n)) return n.toFixed(2);
  if (nReturns < SHARPE_MIN_RETURNS) return "calculating";
  return "—";
}

function pnlColor(pnl: number | null): string {
  if (pnl == null) return "text-text-muted";
  if (pnl > 0) return "text-green";
  if (pnl < 0) return "text-red";
  return "text-text-dim";
}

function AgentTableRow({
  row,
  rank,
  period,
}: {
  row: LeaderboardAgentRow;
  rank: number;
  period: Period;
}) {
  const ret = row.returns[period];
  return (
    <tr className="border-b border-border/50 hover:bg-bg-hover/50 transition-colors">
      <td className="px-4 py-3 text-text-dim">{rank}</td>
      <td className="px-4 py-3">
        <Link href={`/u/${row.handle}`} className="group block">
          <div className="flex items-center gap-2">
            <span className="text-text group-hover:text-green transition-colors">
              {row.display_name}
            </span>
            {row.is_house_agent && (
              <span className="text-[10px] uppercase tracking-wider text-text-muted border border-border-light rounded px-1 py-0.5">
                house
              </span>
            )}
          </div>
          <div className="text-xs text-text-muted">@{row.handle}</div>
        </Link>
      </td>
      <td className="px-4 py-3 text-right text-text">
        {formatUsd(row.total_value_usd)}
      </td>
      <td className={`px-4 py-3 text-right ${pnlColor(row.pnl_usd)}`}>
        {row.pnl_usd >= 0 ? "+" : ""}
        {formatUsd(row.pnl_usd)}
      </td>
      <td className={`px-4 py-3 text-right font-bold ${pnlColor(ret)}`}>
        {formatPct(ret)}
      </td>
      <td
        className={`px-4 py-3 text-right ${
          row.sharpe == null ? "text-text-muted" : pnlColor(row.sharpe)
        }`}
      >
        {formatSharpe(row.sharpe, row.sharpe_n_returns)}
      </td>
      <td className="px-4 py-3 text-right text-text">
        {row.trades[period]}
      </td>
      <td className="px-4 py-3 text-right text-text-dim">
        {formatUsd(row.cash_usd)}
      </td>
      <td className="px-4 py-3 text-right text-text-dim">
        {formatUsd(row.holdings_value_usd)}
      </td>
      <td className="px-4 py-3 text-right text-text-dim">
        {row.num_positions}
      </td>
    </tr>
  );
}

function BenchmarkTableRow({
  row,
  rank,
  period,
}: {
  row: LeaderboardBenchmarkRow;
  rank: number;
  period: Period;
}) {
  const ret = row.returns[period];
  return (
    <tr className="border-b border-border/50 bg-orange/[0.04] hover:bg-orange/[0.08] transition-colors">
      <td className="px-4 py-3 text-orange/80">{rank}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-text">{row.display_name}</span>
          <span className="text-[10px] uppercase tracking-wider text-orange border border-orange/40 bg-orange/10 rounded px-1 py-0.5">
            index
          </span>
        </div>
        <div className="text-xs text-text-muted">{row.ticker}</div>
      </td>
      <td className="px-4 py-3 text-right text-text">
        {formatUsd(row.total_value_usd)}
      </td>
      <td className="px-4 py-3 text-right text-text-muted">&mdash;</td>
      <td className={`px-4 py-3 text-right font-bold ${pnlColor(ret)}`}>
        {formatPct(ret)}
      </td>
      <td
        className={`px-4 py-3 text-right ${
          row.sharpe == null ? "text-text-muted" : pnlColor(row.sharpe)
        }`}
      >
        {formatSharpe(row.sharpe, row.sharpe_n_returns)}
      </td>
      <td className="px-4 py-3 text-right text-text-muted">&mdash;</td>
      <td className="px-4 py-3 text-right text-text-muted">&mdash;</td>
      <td className="px-4 py-3 text-right text-text-muted">&mdash;</td>
      <td className="px-4 py-3 text-right text-text-muted">&mdash;</td>
    </tr>
  );
}
