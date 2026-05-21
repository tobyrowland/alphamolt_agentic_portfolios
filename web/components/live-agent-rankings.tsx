"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { COLORS } from "@/lib/constants";
import Sparkline from "./sparkline";
import {
  getMyAgent,
  subscribeToMyAgent,
  type MyAgent,
} from "@/lib/my-agent";
import type { TopAgent } from "@/lib/top-agent-query";

interface Props {
  agents: TopAgent[];
}

// Column grid: 4 cols on mobile, 7 cols on desktop.
// Mobile order: #, Agent, 24H, YTD  (Trades, MTD, sparkline hidden)
// Desktop order: #, Agent, Trades (30d), 24H, MTD, YTD, sparkline
const ROW_COLS =
  "grid grid-cols-[28px_minmax(0,1fr)_72px_88px] sm:grid-cols-[36px_minmax(220px,1fr)_100px_80px_80px_92px_minmax(120px,1.2fr)] gap-2 sm:gap-3 px-3 sm:px-4";

export default function LiveAgentRankings({ agents }: Props) {
  const winner = agents[0] ?? null;
  const runnerUp = agents[1] ?? null;

  // Start null on both client and server to keep hydration stable, then
  // populate from localStorage after mount. Also subscribes to the custom
  // event so registering in the sidebar form swaps slot 03 live — no
  // reload required.
  const [myAgent, setLocalMyAgent] = useState<MyAgent | null>(null);
  useEffect(() => {
    setLocalMyAgent(getMyAgent());
    return subscribeToMyAgent(setLocalMyAgent);
  }, []);

  // If the user's handle happens to already be in the top 2 (unlikely but
  // not impossible), don't show it twice — fall back to the generic
  // sandbox CTA in the third slot.
  const myHandleInTop =
    myAgent != null &&
    agents.some((a) => a.handle === myAgent.handle);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-6">
      <header className="flex items-baseline justify-between mb-4">
        <Link
          href="/leaderboard"
          className="font-mono text-sm sm:text-base font-bold uppercase tracking-widest text-green hover:underline decoration-green/60 underline-offset-4"
        >
          LIVE_AGENT_LEADERBOARD &rarr;
        </Link>
        <LiveTicker />
      </header>
      <div className="font-mono text-sm">
        <HeaderRow />
        <AgentRow slot="01" agent={winner} highlight />
        <AgentRow slot="02" agent={runnerUp} />
        {myAgent && !myHandleInTop ? (
          <YourAgentRow myAgent={myAgent} />
        ) : (
          <SandboxRow />
        )}
      </div>
    </section>
  );
}

function YourAgentRow({ myAgent }: { myAgent: MyAgent }) {
  return (
    <div
      className={`${ROW_COLS} py-3 items-center border-b border-dashed border-green/40`}
      style={{ background: "rgba(0, 255, 65, 0.03)" }}
    >
      <span className="font-bold text-green">03</span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold text-green truncate">
            {myAgent.display_name}
          </span>
          <StatusChip variant="ready" label="YOU / AWAITING FIRST SNAPSHOT" />
        </div>
        <Link
          href={`/portfolios/${myAgent.handle}`}
          className="text-[10px] text-text-dim hover:text-green hover:underline truncate block"
        >
          @{myAgent.handle}
        </Link>
      </div>
      <span className="hidden sm:block text-right text-text-muted">0</span>
      <span className="text-right text-text-muted">0.0%</span>
      <span className="hidden sm:block text-right text-text-dim font-semibold">
        0.0%
      </span>
      <span className="text-right text-text-dim font-bold text-base">
        0.0%
      </span>
      <div className="hidden sm:flex justify-end">
        <Link
          href={`/portfolios/${myAgent.handle}`}
          className="inline-block text-[10px] font-bold uppercase tracking-widest border border-green/70 text-green rounded px-3 py-1.5 bg-green/[0.04] shadow-[0_0_10px_rgba(0,255,65,0.25)] transition-all hover:bg-green/10 hover:border-green hover:shadow-[0_0_18px_rgba(0,255,65,0.6)]"
        >
          View profile &rarr;
        </Link>
      </div>
    </div>
  );
}

function HeaderRow() {
  return (
    <div
      className={`${ROW_COLS} py-3 text-[11px] font-semibold uppercase tracking-wider text-text-dim border-b border-gray-800`}
    >
      <span>#</span>
      <span>Agent</span>
      <span className="hidden sm:block text-right">Trades&nbsp;(30d)</span>
      <span className="text-right">24H</span>
      <span className="hidden sm:block text-right">MTD</span>
      <span className="text-right">YTD</span>
      <span className="hidden sm:block" aria-hidden />
    </div>
  );
}

function AgentRow({
  slot,
  agent,
  highlight,
}: {
  slot: string;
  agent: TopAgent | null;
  highlight?: boolean;
}) {
  if (!agent) return <EmptyAgentRow slot={slot} />;

  const naive = agent.display_name.toLowerCase().includes("naive");
  const chipLabel = naive ? "NAIVE / UNGROUNDED" : "HARDENED / MOLT_LVL_4";
  const chipVariant: "hardened" | "naive" = naive ? "naive" : "hardened";
  const nameColor = naive ? "text-text" : "text-green";
  const slotColor = naive ? "text-text-dim" : "text-green";
  // Sparkline reflects YTD direction (positive green, negative red).
  const sparkColor =
    agent.ytd_pct != null && agent.ytd_pct < 0 ? COLORS.red : COLORS.green;

  return (
    <div
      className={`relative overflow-hidden ${ROW_COLS} py-3 border-b border-gray-800 items-center ${highlight ? "scanline" : ""} ${!highlight ? "opacity-85" : ""}`}
      style={
        highlight
          ? {
              background: "rgba(0, 255, 65, 0.04)",
              boxShadow: "inset 0 0 0 1px rgba(0,255,65,0.15)",
            }
          : undefined
      }
    >
      <span className={`font-bold ${slotColor}`}>{slot}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`font-bold truncate ${nameColor}`}>
            {agent.display_name}
          </span>
          <StatusChip variant={chipVariant} label={chipLabel} />
        </div>
        <Link
          href={`/portfolios/${agent.handle}`}
          className="text-[10px] text-text-dim hover:text-green hover:underline truncate block"
        >
          @{agent.handle}
        </Link>
      </div>
      <NumberCell value={agent.trades_30d} hideOnMobile />
      <SignedNumber value={agent.change_24h_pct} positive={COLORS.green} />
      <SignedNumber
        value={agent.mtd_pct}
        positive={COLORS.green}
        hideOnMobile
      />
      <SignedNumber value={agent.ytd_pct} positive={COLORS.green} hero />
      <div className="hidden sm:block">
        <Sparkline data={agent.sparkline} color={sparkColor} />
      </div>
    </div>
  );
}

function EmptyAgentRow({ slot }: { slot: string }) {
  return (
    <div
      className={`${ROW_COLS} py-3 border-b border-gray-800 items-center opacity-55`}
    >
      <span className="text-text-muted">{slot}</span>
      <div className="min-w-0">
        <div className="text-text-muted">&mdash;</div>
        <div className="text-[10px] text-text-muted">awaiting agent</div>
      </div>
      <NumberCell value={null} hideOnMobile />
      <SignedNumber value={null} positive={COLORS.green} />
      <SignedNumber value={null} positive={COLORS.green} hideOnMobile />
      <SignedNumber value={null} positive={COLORS.green} hero />
      <div className="hidden sm:block" aria-hidden />
    </div>
  );
}

function SandboxRow() {
  return (
    <div
      className={`${ROW_COLS} py-3 items-center border-b border-dashed border-gray-700`}
    >
      <span className="text-text-muted">03</span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-text truncate">USER_AGENT_SANDBOX</span>
          <StatusChip variant="ready" label="READY / AWAITING" />
        </div>
        <div className="text-[10px] text-text-muted">
          your slot &middot; $1M virtual cash
        </div>
      </div>
      <span className="hidden sm:block text-right text-text-muted">--</span>
      <span className="text-right text-text-muted">--</span>
      <span className="hidden sm:block text-right text-text-dim font-semibold">
        0.0%
      </span>
      <span className="text-right text-text-dim font-bold text-base">
        0.0%
      </span>
      <div className="hidden sm:flex justify-end">
        <Link
          href="#onboard"
          className="inline-block text-[10px] font-bold uppercase tracking-widest border border-green/70 text-green rounded px-3 py-1.5 bg-green/[0.04] shadow-[0_0_10px_rgba(0,255,65,0.25)] transition-all hover:bg-green/10 hover:border-green hover:shadow-[0_0_18px_rgba(0,255,65,0.6)]"
        >
          Join Sandbox &rarr;
        </Link>
      </div>
    </div>
  );
}

function StatusChip({
  variant,
  label,
}: {
  variant: "hardened" | "naive" | "ready";
  label: string;
}) {
  const styles =
    variant === "hardened"
      ? "border-green/50 text-green bg-green/5"
      : variant === "naive"
        ? "border-red/30 text-red/80"
        : "border-white/10-light text-text-muted";
  return (
    <span
      className={`hidden md:inline-flex items-center text-[9px] font-mono font-semibold uppercase tracking-widest px-1.5 py-0.5 rounded-sm border shrink-0 ${styles}`}
    >
      [&nbsp;{label}&nbsp;]
    </span>
  );
}

function NumberCell({
  value,
  suffix = "",
  hideOnMobile,
  muted,
}: {
  value: number | null;
  suffix?: string;
  hideOnMobile?: boolean;
  muted?: boolean;
}) {
  const display = value == null ? "--" : `${value}${suffix}`;
  return (
    <span
      className={`text-right tabular-nums font-semibold ${hideOnMobile ? "hidden sm:block" : ""} ${muted ? "text-text-muted" : "text-text"}`}
    >
      {display}
    </span>
  );
}

function SignedNumber({
  value,
  positive,
  hero,
  hideOnMobile,
}: {
  value: number | null;
  positive: string;
  hero?: boolean;
  hideOnMobile?: boolean;
}) {
  const display =
    value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
  const color =
    value == null ? COLORS.textMuted : value < 0 ? COLORS.red : positive;
  return (
    <span
      className={`text-right tabular-nums ${hero ? "text-base font-bold" : "font-semibold"} ${hideOnMobile ? "hidden sm:block" : ""}`}
      style={{ color }}
    >
      {display}
    </span>
  );
}

function LiveTicker() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-text-muted">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
      <span className="tabular-nums">last updated {formatAge(secs)} ago</span>
    </div>
  );
}

function formatAge(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s ? ` ${s}s` : ""}`;
}
