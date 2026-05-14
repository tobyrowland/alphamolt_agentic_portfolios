import Link from "next/link";
import type { ConsensusHolder, ConsensusRow } from "@/lib/consensus-query";

interface Props {
  rows: ConsensusRow[];
  snapshotDate: string | null;
  topN?: number;
}

// Homepage variant of the /consensus table — top N tickers only, fewer
// columns than the full page. Server component (no state, no
// interactivity beyond static links) so it lands in the SSR HTML
// without a hydration cost. Visual treatment mirrors HomeLeaderboard
// for consistency: same rounded-2xl card, same backdrop blur, same
// FooterRow link to the canonical page.
export default function HomeConsensus({ rows, snapshotDate, topN = 5 }: Props) {
  const top = rows.slice(0, topN);
  const totalAgents = top[0]?.total_agents ?? 0;

  return (
    <section id="consensus" className="scroll-mt-16">
      <header className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <h2 className="text-2xl sm:text-[28px] font-bold tracking-tight text-text leading-tight">
            AI stock-picker favourites
          </h2>
          <p className="mt-1.5 text-sm text-text-muted">
            Most-held equities across the arena&rsquo;s {totalAgents || ""}{" "}
            {totalAgents === 1 ? "agent" : "agents"}
            {snapshotDate && (
              <>
                {" · "}snapshot{" "}
                <time
                  dateTime={snapshotDate}
                  className="text-text-dim font-mono"
                >
                  {formatSnapshotDate(snapshotDate)}
                </time>
              </>
            )}
          </p>
        </div>
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
        {top.length === 0 ? <EmptyState /> : <Table rows={top} />}
        <FooterRow />
      </div>
    </section>
  );
}

function Table({ rows }: { rows: ConsensusRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.12em] text-text-muted font-semibold border-b border-white/[0.06] bg-white/[0.02]">
            <th className="text-left py-3 pl-5 pr-2 font-semibold">
              Ticker
            </th>
            <th className="text-left py-3 px-2 min-w-[180px] font-semibold">
              Conviction
            </th>
            <th className="hidden md:table-cell text-left py-3 px-2 font-semibold">
              Top holders
            </th>
            <th className="text-right py-3 pr-5 pl-2 w-24 font-semibold">
              Swarm P&amp;L
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.ticker} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row }: { row: ConsensusRow }) {
  return (
    <tr className="border-t border-white/[0.05] hover:bg-white/[0.025] transition-colors">
      <td className="py-4 pl-5 pr-2">
        <Link
          href={`/company/${encodeURIComponent(row.ticker)}`}
          className="group flex items-baseline gap-2 min-w-0"
        >
          <span className="font-mono text-[15px] font-bold text-green group-hover:underline decoration-1 underline-offset-[3px]">
            {row.ticker}
          </span>
          <span className="text-xs text-text-muted truncate max-w-[160px] hidden sm:inline">
            {row.company_name}
          </span>
        </Link>
      </td>
      <td className="py-4 px-2">
        <ConvictionCell row={row} />
      </td>
      <td className="hidden md:table-cell py-4 px-2">
        <HoldersChips holders={row.top_holders} />
      </td>
      <td className="py-4 pr-5 pl-2 text-right">
        <PnLCell value={row.swarm_pnl_pct} />
      </td>
    </tr>
  );
}

function ConvictionCell({ row }: { row: ConsensusRow }) {
  const pct = Math.max(0, Math.min(100, row.pct_agents));
  return (
    <div className="flex items-center gap-3">
      <div
        className="relative h-1.5 flex-1 max-w-[160px] rounded-full overflow-hidden"
        style={{ background: "rgba(255,255,255,0.06)" }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={`${row.pct_agents.toFixed(0)} percent of agents hold ${row.ticker}`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${pct}%`,
            background: "var(--color-green)",
            boxShadow:
              "0 0 8px rgba(0, 255, 65, 0.55), 0 0 2px rgba(0, 255, 65, 0.35)",
          }}
        />
      </div>
      <span className="text-xs text-text-dim tabular-nums whitespace-nowrap">
        {row.num_agents} of {row.total_agents}
      </span>
    </div>
  );
}

function HoldersChips({ holders }: { holders: ConsensusHolder[] }) {
  if (holders.length === 0) {
    return <span className="text-xs text-text-muted">&mdash;</span>;
  }
  // Homepage variant: just two visible chips + a `+N` count (no
  // tooltip — the full /consensus page is the place to drill in).
  // Kept as a server component so SSR HTML is interactivity-free.
  const visible = holders.slice(0, 2);
  const overflow = holders.length - visible.length;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {visible.map((h) => (
        <Link
          key={h.handle}
          href={`/portfolios/${h.handle}`}
          className="inline-flex items-center px-2 py-0.5 rounded-md text-xs text-text-dim hover:text-text border border-white/10 hover:border-white/20 transition-colors"
        >
          {h.display_name}
        </Link>
      ))}
      {overflow > 0 && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs text-green border border-green/30">
          +{overflow}
        </span>
      )}
    </div>
  );
}

function PnLCell({ value }: { value: number | null }) {
  if (value == null) {
    return <span className="text-text-muted text-sm">&mdash;</span>;
  }
  const positive = value >= 0;
  const sign = positive ? "+" : "−";
  return (
    <span
      className="text-sm font-bold tabular-nums"
      style={{
        color: positive ? "var(--color-green)" : "var(--color-red)",
        textShadow: positive
          ? "0 0 12px rgba(0, 255, 65, 0.35)"
          : "0 0 12px rgba(255, 80, 80, 0.30)",
      }}
    >
      {sign}
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

function EmptyState() {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm text-text-muted font-mono">
        No consensus snapshot yet — first run lands Sunday 08:00 UTC.
      </p>
    </div>
  );
}

function FooterRow() {
  return (
    <div
      className="border-t border-white/[0.06] px-5 py-3 flex items-center justify-end"
      style={{ background: "rgba(255,255,255,0.015)" }}
    >
      <Link
        href="/consensus"
        className="text-xs font-semibold text-text-dim hover:text-text inline-flex items-center gap-1.5 transition-colors"
      >
        Full consensus
        <span aria-hidden>&rarr;</span>
      </Link>
    </div>
  );
}

function formatSnapshotDate(iso: string): string {
  // Friendly compact form ("Sun 04 May") that matches the
  // /consensus page treatment.
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}
