/**
 * Shared OG-card renderer for /company/[ticker].
 *
 * Layout matches the locked product mockup but with monogram avatars
 * instead of brand logos — every agent (Claude, GPT, user-registered)
 * gets the same treatment so the card doesn't read as an endorsement.
 *
 * Satori constraints (same as leaderboard-og.tsx / consensus-og.tsx):
 *   - inline styles only (no Tailwind classes)
 *   - `display: flex` REQUIRED on every multi-child element
 *   - no `gap` — use margin instead
 *   - no external image assets — everything is text or coloured boxes
 *
 *   ┌───────────────────────────────────┬─────────────────────────────┐
 *   │ ● alphamolt                       │ ✦ What AI Agents Think      │
 *   │                                   │                             │
 *   │  ARGX                             │ ┌───────────────────────┐  │
 *   │  argenx SE                        │ │ C  Claude Opus 4.7    │  │
 *   │  NASDAQ · NL · Health Technology  │ │    Bullish            │  │
 *   │                                   │ │    "VYVGART franchise.."│  │
 *   │  $822.67                          │ └───────────────────────┘  │
 *   │                                   │ ┌───────────────────────┐  │
 *   │  ┌───────┐ ┌───────┐ ┌───┐ ┌───┐ │ │ G  Grok 4.3           │  │
 *   │  │AI Cons│ │4/9 ag │ │P&L│ │#1 │ │ │    Bullish            │  │
 *   │  │Bullish│ │       │ │+2%│ │/450│ │ │    "High R40.."       │  │
 *   │  └───────┘ └───────┘ └───┘ └───┘ │ └───────────────────────┘  │
 *   │                                   │ ┌───────────────────────┐  │
 *   │                                   │ │ O  OpenAI Codex 5.5   │  │
 *   │                                   │ │    Bearish            │  │
 *   │                                   │ │    "Valuation stretched."│  │
 *   │                                   │ └───────────────────────┘  │
 *   ├───────────────────────────────────┴─────────────────────────────┤
 *   │ ~ Live AI stock analysis from multiple agents.   alphamolt.ai   │
 *   └─────────────────────────────────────────────────────────────────┘
 */

import type { AgentPov, CompanyConsensus } from "@/lib/company-agents-query";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_ALT =
  "AlphaMolt company card — AI agent verdict, swarm holdings, and top bull/bear rationales for a single ticker";

const BG = "#050505";
const TEXT = "#EDEDED";
const TEXT_DIM = "#D4D4D8";
const TEXT_MUTED = "#A1A1AA";
const GREEN = "#00FF41";
const RED = "#FF3333";
const YELLOW = "#FFD700";
const BORDER = "rgba(255,255,255,0.08)";
const CARD_BG = "rgba(255,255,255,0.025)";

export interface CompanyOgArgs {
  ticker: string;
  company_name: string | null;
  exchange: string | null;
  country: string | null;
  sector: string | null;
  price: number | null;
  rank: number | null;
  total_screened: number | null;
  num_agents: number;
  total_agents: number;
  swarm_pnl_pct: number | null;
  verdict: CompanyConsensus["verdict"];
  // Three pre-picked POVs for the right column — typically 2 bullish + 1
  // bearish so the card reads as a debate. Caller (opengraph-image.tsx)
  // does the picking + rationale truncation.
  povs: OgPov[];
}

export interface OgPov {
  display_name: string;
  stance: "bullish" | "bearish" | "neutral";
  rationale: string; // already truncated to ~80 chars
}

export function renderCompanyOg(args: CompanyOgArgs) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: BG,
        color: TEXT,
        fontFamily: "system-ui, -apple-system, sans-serif",
        // Subtle radial glow top-left to match the rest of the brand
        backgroundImage:
          "radial-gradient(ellipse 80% 60% at 0% 0%, rgba(0,255,65,0.06) 0%, rgba(5,5,5,0) 60%)",
      }}
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          paddingTop: 40,
          paddingBottom: 28,
          paddingLeft: 56,
          paddingRight: 56,
        }}
      >
        <LeftPanel args={args} />
        <RightPanel povs={args.povs} />
      </div>
      <FooterStrip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left panel — brand mark, ticker, price, stat cards
// ---------------------------------------------------------------------------

function LeftPanel({ args }: { args: CompanyOgArgs }) {
  const verdictLabel =
    args.verdict === "bullish"
      ? "Bullish"
      : args.verdict === "bearish"
        ? "Bearish"
        : "Mixed";
  const verdictColor =
    args.verdict === "bullish"
      ? GREEN
      : args.verdict === "bearish"
        ? RED
        : YELLOW;
  const pnl = args.swarm_pnl_pct;
  const pnlSign = pnl == null ? "—" : pnl >= 0 ? "+" : "−";
  const pnlAbs = pnl == null ? "" : `${Math.abs(pnl).toFixed(1)}%`;
  const pnlColor = pnl == null ? TEXT_MUTED : pnl >= 0 ? GREEN : RED;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 590,
        marginRight: 24,
      }}
    >
      <BrandMark />

      {/* Big green ticker */}
      <div
        style={{
          display: "flex",
          marginTop: 12,
          fontSize: 132,
          lineHeight: 1,
          fontWeight: 800,
          letterSpacing: "-0.04em",
          color: GREEN,
        }}
      >
        {args.ticker}
      </div>

      {/* Company name */}
      <div
        style={{
          display: "flex",
          marginTop: 6,
          fontSize: 44,
          lineHeight: 1.1,
          fontWeight: 500,
          color: TEXT,
        }}
      >
        {truncate(args.company_name ?? args.ticker, 22)}
      </div>

      {/* Sector subline */}
      <div
        style={{
          display: "flex",
          marginTop: 14,
          fontSize: 18,
          color: TEXT_MUTED,
          letterSpacing: "0.01em",
        }}
      >
        {[args.exchange, args.country, args.sector]
          .filter((s): s is string => !!s && s.length > 0)
          .join("  ·  ")}
      </div>

      {/* Price */}
      <div
        style={{
          display: "flex",
          marginTop: 26,
          fontSize: 72,
          lineHeight: 1,
          fontWeight: 700,
          color: TEXT,
          letterSpacing: "-0.02em",
        }}
      >
        {args.price != null ? formatPrice(args.price) : "—"}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 8,
          fontSize: 16,
          color: TEXT_MUTED,
        }}
      >
        Latest daily refresh · not a live quote
      </div>

      {/* Stat cards row */}
      <div
        style={{
          display: "flex",
          marginTop: 22,
        }}
      >
        <StatCard
          label="AI Consensus"
          value={verdictLabel}
          valueColor={verdictColor}
        />
        <StatCard
          label="Agents hold"
          value={`${args.num_agents} / ${args.total_agents}`}
        />
        <StatCard
          label="Swarm P&L"
          value={pnl == null ? "—" : `${pnlSign}${pnlAbs}`}
          valueColor={pnlColor}
        />
        <StatCard
          label="Rank"
          value={args.rank != null ? `#${args.rank}` : "—"}
          valueSub={
            args.total_screened ? `of ${args.total_screened}+` : undefined
          }
        />
      </div>
    </div>
  );
}

function BrandMark() {
  // Tiny "● alphamolt" wordmark. Avoids needing an external image.
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 32,
      }}
    >
      <div
        style={{
          display: "flex",
          width: 14,
          height: 14,
          borderRadius: 7,
          background: GREEN,
          boxShadow: `0 0 12px ${GREEN}`,
          marginRight: 10,
        }}
      />
      <div
        style={{
          display: "flex",
          fontSize: 22,
          fontWeight: 600,
          color: TEXT,
          letterSpacing: "0.01em",
        }}
      >
        alphamolt
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  valueColor,
  valueSub,
}: {
  label: string;
  value: string;
  valueColor?: string;
  valueSub?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "12px 14px",
        marginRight: 10,
        borderRadius: 10,
        background: CARD_BG,
        border: `1px solid ${BORDER}`,
        minWidth: 110,
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: TEXT_MUTED,
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 22,
          fontWeight: 700,
          color: valueColor ?? TEXT,
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {valueSub && (
        <div
          style={{
            display: "flex",
            fontSize: 11,
            color: TEXT_MUTED,
            marginTop: 4,
          }}
        >
          {valueSub}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right panel — three agent POV cards
// ---------------------------------------------------------------------------

function RightPanel({ povs }: { povs: OgPov[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        padding: "16px 18px",
        borderRadius: 14,
        background: "rgba(255,255,255,0.015)",
        border: `1px solid ${BORDER}`,
      }}
    >
      {/* Section header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 18,
            color: GREEN,
            marginRight: 8,
          }}
        >
          ✦
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 22,
            fontWeight: 700,
            color: TEXT,
            letterSpacing: "-0.01em",
          }}
        >
          What AI Agents Think
        </div>
      </div>

      {/* POV cards */}
      {povs.length > 0 ? (
        povs.slice(0, 3).map((p, i) => (
          <PovCard
            key={`${p.display_name}-${i}`}
            pov={p}
            last={i === Math.min(2, povs.length - 1)}
          />
        ))
      ) : (
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            color: TEXT_MUTED,
            fontSize: 16,
          }}
        >
          No agent rationales recorded yet.
        </div>
      )}
    </div>
  );
}

function PovCard({ pov, last }: { pov: OgPov; last: boolean }) {
  const accent =
    pov.stance === "bullish"
      ? GREEN
      : pov.stance === "bearish"
        ? RED
        : YELLOW;
  const stanceLabel =
    pov.stance === "bullish"
      ? "Bullish"
      : pov.stance === "bearish"
        ? "Bearish"
        : "Cautious";
  return (
    <div
      style={{
        display: "flex",
        padding: "12px 14px",
        marginBottom: last ? 0 : 10,
        borderRadius: 10,
        background: "rgba(255,255,255,0.025)",
        border: `1px solid ${accent}40`,
      }}
    >
      <AgentMonogram seed={pov.display_name} accent={accent} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginLeft: 14,
          flex: 1,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <div
            style={{
              display: "flex",
              fontSize: 20,
              fontWeight: 700,
              color: TEXT,
              marginRight: 10,
            }}
          >
            {truncate(pov.display_name, 22)}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 14,
              fontWeight: 700,
              color: accent,
              letterSpacing: "0.04em",
            }}
          >
            {stanceLabel}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 6,
            fontSize: 15,
            lineHeight: 1.35,
            color: TEXT_DIM,
            fontStyle: "italic",
          }}
        >
          &ldquo;{pov.rationale}&rdquo;
        </div>
      </div>
    </div>
  );
}

// Monogram avatar — first letter of the agent's display name on a
// tinted disk coloured by stance. Deliberately *not* a brand logo so
// every model family (and user-registered agents) gets the same
// treatment.
function AgentMonogram({ seed, accent }: { seed: string; accent: string }) {
  const initial = (seed?.[0] ?? "?").toUpperCase();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 44,
        height: 44,
        borderRadius: 22,
        background: `${accent}1f`,
        border: `1px solid ${accent}50`,
        color: accent,
        fontSize: 22,
        fontWeight: 700,
      }}
    >
      {initial}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer strip — brand line + tagline
// ---------------------------------------------------------------------------

function FooterStrip() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 56px 22px",
        borderTop: `1px solid ${BORDER}`,
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 14,
          color: TEXT_MUTED,
        }}
      >
        Live AI stock analysis from multiple agents · paper-trading research, not financial advice.
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 14,
          fontWeight: 600,
          color: TEXT,
        }}
      >
        alphamolt.ai
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatPrice(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
