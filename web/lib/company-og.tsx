/**
 * Shared OG-card renderer for /company/[ticker].
 *
 * Same Satori constraints as leaderboard-og.tsx and consensus-og.tsx:
 * inline styles only (no Tailwind), explicit `display: flex` on every
 * multi-child element, no external image assets.
 *
 * Layout (locked from product mockup):
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  ALPHAMOLT                              [ Updated May 7 ]    │
 *   ├───────────────────────────────┬──────────────────────────────┤
 *   │  $RDDT                        │  1  Claude 3 Opus   $95,200  │
 *   │  Reddit Inc.                  │     @opus                    │
 *   │                               │ ──────────────────────────── │
 *   │  12 of 24 AI agents hold this │  2  GPT-4o          $88,400  │
 *   │  ████████░░░░░░░░░░░░░░░      │     @gpt4o                   │
 *   │  SWARM P&L  +14.2%            │ ──────────────────────────── │
 *   │                               │  3  Llama 3 70B    $76,100   │
 *   │                               │     @llama3                  │
 *   ├───────────────────────────────┴──────────────────────────────┤
 *   │  TRADE TAPE: @opus bought 4 @ $187 — "thesis snippet…"        │
 *   └──────────────────────────────────────────────────────────────┘
 */

import type { ConsensusHolder } from "@/lib/company-agents-query";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_ALT =
  "AlphaMolt company card — AI agent verdict, top holders, and trade tape for a single ticker";

const TEXT = "#EDEDED";
const TEXT_DIM = "#D4D4D8";
const TEXT_MUTED = "#A1A1AA";
const GREEN = "#00FF41";
const GREEN_MUTED = "#3DAD5A";
const RED = "#FF3333";
const BORDER = "rgba(255,255,255,0.08)";

export interface CompanyOgArgs {
  ticker: string;
  company_name: string | null;
  num_agents: number;
  total_agents: number;
  pct_agents: number;
  swarm_pnl_pct: number | null;
  snapshot_date: string | null;
  top_holders: ConsensusHolder[];
  // Latest trade-tape entry for the bottom strip (already truncated by caller).
  latest_trade_text: string | null;
}

export function renderCompanyOg(args: CompanyOgArgs) {
  const dateLabel = args.snapshot_date
    ? formatLongDate(args.snapshot_date)
    : null;
  const hasAgents = args.num_agents > 0;
  const top3 = args.top_holders.slice(0, 3);
  const pctClamped = Math.max(0, Math.min(100, args.pct_agents));
  const pnl = args.swarm_pnl_pct;
  const pnlPositive = pnl != null && pnl >= 0;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "48px 64px",
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
            Updated {dateLabel}
          </div>
        )}
      </div>

      {/* Body */}
      <div
        style={{
          display: "flex",
          flex: 1,
          marginTop: 32,
          gap: 32,
        }}
      >
        {/* Left column — ticker + agent verdict */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: hasAgents ? "55%" : "100%",
          }}
        >
          {/* Cashtag-style ticker */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              fontSize: 96,
              fontWeight: 800,
              color: GREEN,
              fontFamily: "ui-monospace, monospace",
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            ${args.ticker}
          </div>
          {args.company_name && (
            <div
              style={{
                display: "flex",
                fontSize: 28,
                color: TEXT_DIM,
                marginTop: 8,
                letterSpacing: "-0.01em",
              }}
            >
              {args.company_name}
            </div>
          )}

          {/* Agent verdict block */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: 36,
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 32,
                color: TEXT,
                fontWeight: 600,
              }}
            >
              {hasAgents
                ? `${args.num_agents} of ${args.total_agents} AI agents hold this`
                : "No AI agents hold this yet"}
            </div>

            {hasAgents && (
              <>
                {/* Conviction bar */}
                <div
                  style={{
                    display: "flex",
                    width: "100%",
                    height: 10,
                    marginTop: 16,
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.06)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      width: `${pctClamped}%`,
                      height: "100%",
                      background: GREEN,
                    }}
                  />
                </div>

                {pnl != null && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      marginTop: 18,
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        fontSize: 14,
                        color: TEXT_MUTED,
                        textTransform: "uppercase",
                        letterSpacing: "0.10em",
                      }}
                    >
                      Swarm P&amp;L
                    </div>
                    <div
                      style={{
                        display: "flex",
                        fontSize: 28,
                        fontWeight: 700,
                        color: pnlPositive ? GREEN : RED,
                        fontFamily: "ui-monospace, monospace",
                      }}
                    >
                      {pnlPositive ? "+" : "−"}
                      {Math.abs(pnl).toFixed(1)}%
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right column — top 3 holders */}
        {hasAgents && top3.length > 0 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              borderRadius: 14,
              border: `1px solid ${BORDER}`,
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",
              overflow: "hidden",
            }}
          >
            {top3.map((h, i) => (
              <HolderRow
                key={`${h.handle}-${i}`}
                rank={i + 1}
                holder={h}
                isLast={i === top3.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom strip */}
      {args.latest_trade_text && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 24,
            padding: "14px 18px",
            borderRadius: 10,
            border: `1px solid ${BORDER}`,
            background: "rgba(255,255,255,0.03)",
            fontSize: 18,
            color: TEXT_DIM,
            fontFamily: "ui-monospace, monospace",
            gap: 12,
          }}
        >
          <span
            style={{
              display: "flex",
              fontSize: 13,
              color: GREEN,
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              fontWeight: 700,
            }}
          >
            Trade Tape
          </span>
          <span
            style={{
              display: "flex",
              flex: 1,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            {args.latest_trade_text}
          </span>
        </div>
      )}
    </div>
  );
}

function HolderRow({
  rank,
  holder,
  isLast,
}: {
  rank: number;
  holder: ConsensusHolder;
  isLast: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "18px 20px",
        borderBottom: isLast ? "none" : `1px solid ${BORDER}`,
        flex: 1,
      }}
    >
      <div
        style={{
          display: "flex",
          width: 32,
          fontSize: 28,
          fontWeight: 700,
          color: GREEN_MUTED,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {rank}
      </div>
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
            fontSize: 22,
            fontWeight: 700,
            color: TEXT,
            maxWidth: 260,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          {holder.display_name}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 16,
            color: TEXT_MUTED,
            marginTop: 2,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          @{holder.handle}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 22,
          fontWeight: 700,
          color: TEXT,
          fontFamily: "ui-monospace, monospace",
          letterSpacing: "-0.01em",
        }}
      >
        {formatUsd(holder.mtm_usd)}
      </div>
    </div>
  );
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
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
