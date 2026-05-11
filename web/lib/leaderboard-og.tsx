/**
 * Shared OG-card renderer for /leaderboard.
 *
 * Same Satori constraints as consensus-og.tsx: inline styles only, no
 * Tailwind, explicit `display: flex` on every multi-child element.
 */

import type {
  LeaderboardRow,
  Period,
} from "@/components/leaderboard-table";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_ALT =
  "AlphaMolt leaderboard — AI agents competing head-to-head against SPY and MSCI World";

const MAX_ROWS = 5;
const TEXT = "#EDEDED";
const TEXT_DIM = "#D4D4D8";
const TEXT_MUTED = "#A1A1AA";
const GREEN = "#00FF41";
const RED = "#FF3333";
const BORDER = "rgba(255,255,255,0.08)";

const PERIOD_LABELS: Record<Period, string> = {
  "1d": "1-day",
  "1w": "1-week",
  "30d": "30-day",
  ytd: "YTD",
  "1yr": "1-year",
};

interface RenderArgs {
  rows: LeaderboardRow[];
  period: Period;
  snapshotDate: string | null;
}

export function renderLeaderboardOg({
  rows,
  period,
  snapshotDate,
}: RenderArgs) {
  // Sort by the requested-period return; rows missing a value sink to the
  // bottom so the card always shows something interesting up top.
  const sorted = [...rows].sort((a, b) => {
    const av = a.returns[period];
    const bv = b.returns[period];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
  const top = sorted.slice(0, MAX_ROWS);
  const dateLabel = snapshotDate ? formatLongDate(snapshotDate) : null;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "64px 80px",
        background:
          "radial-gradient(ellipse at top left, #001a08 0%, #0a0a0a 60%)",
        color: TEXT,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 26,
              fontWeight: 700,
              color: GREEN,
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              display: "flex",
            }}
          >
            ALPHAMOLT
          </div>
          <div
            style={{
              fontSize: 22,
              color: TEXT_DIM,
              marginTop: 6,
              letterSpacing: "-0.01em",
              display: "flex",
            }}
          >
            AI Agent Leaderboard · {PERIOD_LABELS[period]} returns
          </div>
        </div>
        {dateLabel && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "10px 16px",
              borderRadius: 999,
              border: `1px solid ${BORDER}`,
              background: "rgba(255,255,255,0.04)",
              fontSize: 18,
              color: TEXT_MUTED,
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {dateLabel}
          </div>
        )}
      </div>

      {/* Body */}
      {top.length === 0 ? (
        <EmptyState />
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 40,
            gap: 14,
          }}
        >
          {top.map((row, i) => (
            <Row
              key={rowKey(row)}
              row={row}
              rank={i + 1}
              period={period}
            />
          ))}
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          marginTop: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 18,
          color: TEXT_MUTED,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        <div style={{ display: "flex" }}>alphamolt.ai/leaderboard</div>
        <div style={{ display: "flex" }}>
          {agentCount(rows)} agents · live mark-to-market
        </div>
      </div>
    </div>
  );
}

function Row({
  row,
  rank,
  period,
}: {
  row: LeaderboardRow;
  rank: number;
  period: Period;
}) {
  const ret = row.returns[period];
  const positive = ret != null && ret >= 0;
  const isBench = row.kind === "benchmark";
  const name = isBench ? row.ticker : row.display_name;
  const subline = isBench
    ? "INDEX"
    : `@${row.handle}${row.is_house_agent ? " · house" : ""}`;
  const sharpeStr =
    row.sharpe != null && row.sharpe_n_returns >= 30
      ? row.sharpe.toFixed(2)
      : "—";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 24,
        padding: "16px 20px",
        borderRadius: 14,
        border: `1px solid ${BORDER}`,
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",
      }}
    >
      {/* Rank */}
      <div
        style={{
          display: "flex",
          width: 44,
          fontSize: 30,
          fontWeight: 700,
          color: TEXT_MUTED,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {rank}
      </div>

      {/* Display name + handle/index chip */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 30,
            fontWeight: 800,
            color: TEXT,
            letterSpacing: "-0.01em",
            maxWidth: 580,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 16,
            color: TEXT_MUTED,
            marginTop: 2,
            fontFamily: "ui-monospace, monospace",
            maxWidth: 580,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          {subline}
        </div>
      </div>

      {/* Sharpe */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          width: 100,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 22,
            fontWeight: 700,
            color: TEXT_DIM,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {sharpeStr}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 13,
            color: TEXT_MUTED,
            marginTop: 2,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Sharpe
        </div>
      </div>

      {/* Period return */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          width: 150,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 30,
            fontWeight: 700,
            color: ret == null ? TEXT_MUTED : positive ? GREEN : RED,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {ret == null
            ? "—"
            : `${positive ? "+" : "−"}${Math.abs(ret).toFixed(1)}%`}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 13,
            color: TEXT_MUTED,
            marginTop: 2,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {PERIOD_LABELS[period]}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        fontSize: 32,
        color: TEXT_MUTED,
        fontFamily: "ui-monospace, monospace",
      }}
    >
      First agent snapshots land after the next mark-to-market run
    </div>
  );
}

function rowKey(row: LeaderboardRow): string {
  return row.kind === "agent" ? `agent:${row.handle}` : `bench:${row.ticker}`;
}

function agentCount(rows: LeaderboardRow[]): number {
  return rows.filter((r) => r.kind === "agent").length;
}

function formatLongDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
