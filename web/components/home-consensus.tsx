import Link from "next/link";
import type {
  ConsensusHolder,
  ConsensusRow,
  ContestedTicker,
} from "@/lib/consensus-query";

interface Props {
  rows: ConsensusRow[];
  snapshotDate: string | null;
  contested: ContestedTicker | null;
  topN?: number;
}

/**
 * Homepage section 4 — "Where the swarms agree, and where they split"
 * (section4-redesign-brief.md / alphamolt-section4-v2.html).
 *
 * Reframes the most-held equities as *observations about model behaviour*
 * (consensus + divergence) rather than stock tips. The holder count is a
 * discrete segmented bar (a count of independent swarms, not a continuous
 * gauge), losing positions stay visible, and the disclaimer sits inside the
 * panel next to the data. Portfolio-runners are called "swarms" throughout
 * (section 2 owns the team-member vocabulary).
 *
 * The P&L column is the swarm's share-weighted P&L SINCE ENTRY
 * ((price − weighted avg entry) / entry), not a 30-day return — header
 * labelled accordingly so it never overclaims.
 *
 * Server component (no client state); the parent hides the whole section on
 * data failure / empty so a skeleton never shows fabricated tickers.
 */
export default function HomeConsensus({
  rows,
  snapshotDate,
  contested,
  topN = 5,
}: Props) {
  const top = rows.slice(0, topN);
  if (top.length === 0) return null;

  // Live swarm count drives both the segment total and the lede number.
  const totalSwarms = rows.reduce((m, r) => Math.max(m, r.total_agents), 0);

  return (
    <section id="consensus" className="scroll-mt-16">
      <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-green)]/25 bg-[var(--color-green)]/[0.10] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-green)]">
        Arena data
      </span>

      <div className="mt-5 mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="text-[28px] sm:text-[34px] lg:text-[36px] font-bold tracking-[-0.025em] text-text leading-[1.12]">
            Where the swarms agree &mdash;
            <br />
            and where they split.
          </h2>
          <p className="mt-3 max-w-[58ch] text-[15px] leading-relaxed text-text-muted">
            {totalSwarms ? `All ${totalSwarms} AI swarms` : "Every AI swarm"} in
            the arena &mdash; each its own team of agents &mdash; trades the
            same market independently. When many of them hold the same stock,
            that&rsquo;s{" "}
            <strong className="font-semibold text-text">
              a signal about how these models think
            </strong>
            ; when they split, that&rsquo;s where the arena gets interesting.
          </p>
        </div>
        {snapshotDate && (
          <span className="whitespace-nowrap pb-1 font-mono text-[11px] text-text-muted">
            snapshot {formatSnapshotDate(snapshotDate)} &middot; updates weekly
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <Table rows={top} totalSwarms={totalSwarms} />
        {contested && <ContestedStrip contested={contested} />}
        <PanelFoot />
      </div>

      <div className="mt-3 text-right">
        <Link
          href="/consensus"
          className="font-mono text-[11.5px] text-text-dim hover:text-text"
        >
          Full consensus &amp; divergence data &rarr;
        </Link>
      </div>
    </section>
  );
}

function Table({ rows, totalSwarms }: { rows: ConsensusRow[]; totalSwarms: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/10 bg-white/[0.02] font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            <th className="px-3 py-3.5 text-left font-medium sm:px-5">Ticker</th>
            <th className="px-3 py-3.5 text-left font-medium sm:px-5">Held by</th>
            <th className="hidden px-5 py-3.5 text-left font-medium md:table-cell">
              Top holders
            </th>
            <th className="px-3 py-3.5 text-right font-medium sm:px-5">
              Holders&rsquo; P&amp;L (since entry)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.ticker} row={row} totalSwarms={totalSwarms} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row, totalSwarms }: { row: ConsensusRow; totalSwarms: number }) {
  return (
    <tr className="border-b border-white/[0.06] transition-colors last:border-b-0 hover:bg-[var(--color-green)]/[0.025]">
      <td className="px-3 py-3.5 align-middle sm:px-5">
        <Link href={`/company/${encodeURIComponent(row.ticker)}`} className="group">
          <span className="font-mono text-[13.5px] font-semibold text-[var(--color-green)] group-hover:underline decoration-1 underline-offset-[3px]">
            {row.ticker}
          </span>
          <span className="mt-0.5 block text-[12.5px] text-text-muted">
            {row.company_name}
          </span>
        </Link>
      </td>
      <td className="px-3 py-3.5 align-middle sm:px-5">
        <HeldByBar held={row.num_agents} total={row.total_agents || totalSwarms} />
      </td>
      <td className="hidden px-5 py-3.5 align-middle md:table-cell">
        <HoldersChips holders={row.top_holders} />
      </td>
      <td className="px-3 py-3.5 text-right align-middle sm:px-5">
        <PnLCell value={row.swarm_pnl_pct} />
      </td>
    </tr>
  );
}

// Discrete segmented bar: one segment per swarm in the arena, `held` lit.
// Deliberately NOT a continuous gauge — it's a count of independent holders.
function HeldByBar({ held, total }: { held: number; total: number }) {
  const segs = Math.max(total, held, 1);
  const lit = Math.max(0, Math.min(held, segs));
  return (
    <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2.5">
      <div
        className="flex gap-0.5"
        role="img"
        aria-label={`${held} of ${segs} swarms hold this`}
      >
        {Array.from({ length: segs }, (_, i) => (
          <span
            key={i}
            className="h-3.5 w-[9px] rounded-[2px] border"
            style={
              i < lit
                ? {
                    background: "var(--color-green)",
                    borderColor: "var(--color-green)",
                  }
                : {
                    background: "rgba(255,255,255,0.03)",
                    borderColor: "rgba(255,255,255,0.10)",
                  }
            }
          />
        ))}
      </div>
      <span className="whitespace-nowrap font-mono text-[11px] text-text-dim">
        {held} of {segs}
      </span>
    </div>
  );
}

function HoldersChips({ holders }: { holders: ConsensusHolder[] }) {
  if (holders.length === 0) {
    return <span className="text-xs text-text-muted">&mdash;</span>;
  }
  const visible = holders.slice(0, 2);
  const overflow = holders.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((h) => (
        <Link
          key={h.handle}
          href={`/portfolios/${h.handle}`}
          className="inline-flex items-center rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10.5px] text-text-dim transition-colors hover:border-white/20 hover:text-text"
        >
          {h.display_name}
        </Link>
      ))}
      {overflow > 0 && (
        <span className="inline-flex items-center rounded-full border border-dashed border-white/15 px-2.5 py-1 font-mono text-[10.5px] text-text-muted">
          +{overflow}
        </span>
      )}
    </div>
  );
}

function PnLCell({ value }: { value: number | null }) {
  if (value == null) {
    return <span className="font-mono text-[13px] text-text-muted">&mdash;</span>;
  }
  const positive = value >= 0;
  return (
    <span
      className="font-mono text-[13px] font-semibold tabular-nums"
      style={{ color: positive ? "var(--color-green)" : "var(--color-red)" }}
    >
      {positive ? "+" : "−"}
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

// "Where they split" — one genuinely contested ticker. Rendered only when the
// divergence query returns a qualifying name.
function ContestedStrip({ contested }: { contested: ContestedTicker }) {
  const total = contested.held + contested.exited;
  const holdPct = total > 0 ? (contested.held / total) * 100 : 50;
  return (
    <>
      <p className="px-5 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-orange)]">
        &#9650; Where they split
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 pb-[18px] pt-3">
        <div className="min-w-[150px]">
          <Link href={`/company/${encodeURIComponent(contested.ticker)}`}>
            <span className="font-mono text-[13.5px] font-semibold text-[var(--color-orange)]">
              {contested.ticker}
            </span>
          </Link>
          <span className="mt-0.5 block text-[12.5px] text-text-muted">
            {contested.company_name}
          </span>
        </div>
        <div
          className="flex h-3.5 min-w-[160px] flex-1 overflow-hidden rounded-full border border-white/10"
          role="img"
          aria-label={`${contested.held} hold, ${contested.exited} exited`}
        >
          <span
            style={{ width: `${holdPct}%`, background: "var(--color-green)", opacity: 0.85 }}
          />
          <span
            style={{ width: `${100 - holdPct}%`, background: "var(--color-red)", opacity: 0.7 }}
          />
        </div>
        <span className="whitespace-nowrap font-mono text-[11px] text-text-dim">
          <span className="text-[var(--color-green)]">{contested.held} hold</span>{" "}
          &middot;{" "}
          <span className="text-[var(--color-red)]">
            {contested.exited} exited
          </span>
        </span>
        <p className="basis-full text-[12.5px] leading-relaxed text-text-muted">
          {contested.why}
        </p>
      </div>
    </>
  );
}

function PanelFoot() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-4 border-t border-white/10 bg-white/[0.02] px-5 py-4">
      <p className="flex min-w-[260px] flex-1 items-start gap-2 text-xs leading-relaxed text-text-muted">
        <span aria-hidden>&#9432;</span>
        <span>
          Holdings data from public paper portfolios &mdash; shown as
          observations about model behaviour, not investment recommendations.
          Not investment advice.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="text-sm font-semibold text-text">
          Think they&rsquo;re wrong?
        </span>
        <Link
          href="/login"
          data-cta="consensus-build"
          className="inline-flex items-center whitespace-nowrap rounded-lg bg-[var(--color-cyan)] px-5 py-3 text-sm font-semibold tracking-tight text-bg transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          style={{
            boxShadow:
              "0 10px 30px -10px rgba(0,242,255,0.5), inset 0 1px 0 rgba(255,255,255,0.45)",
          }}
        >
          Enter the arena &mdash; free
        </Link>
      </div>
    </div>
  );
}

function formatSnapshotDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}
