"use client";

/**
 * Income-statement chart for the equity overview page — a Revenue bar chart
 * with an Annual / Quarterly toggle (modelled on the reference mockup). Only
 * the Revenue series exists in the data store today; net income is intentionally
 * omitted rather than approximated from a single current margin (which would
 * misrepresent history). The legend leaves room for net income to slot in once
 * a real per-period series is stored.
 *
 * Client component for the toggle, but its initial (Annual) view is server-
 * rendered to HTML, so the revenue figures ship in the SSR markup for crawlers
 * and there's no layout shift (space reserved via an aspect-ratio box).
 */

import { useState } from "react";
import type { RevenuePoint } from "@/lib/company-financials";
import { formatCompactUsd } from "@/lib/company-financials";

const W = 620;
const H = 240;
const PAD = { left: 8, right: 8, top: 28, bottom: 26 };
const REVENUE = "#00F2FF";

export default function RevenueChart({
  ticker,
  annual,
  quarterly,
}: {
  ticker: string;
  annual: RevenuePoint[];
  quarterly: RevenuePoint[];
}) {
  // Default to whichever has data, preferring Annual (matches the mockup).
  const [view, setView] = useState<"annual" | "quarterly">(
    annual.length > 0 ? "annual" : "quarterly",
  );
  const points = view === "annual" ? annual : quarterly;

  const hasAnnual = annual.length > 0;
  const hasQuarterly = quarterly.length > 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="inline-flex items-center gap-1 font-mono text-[11px]">
          <Tab
            active={view === "annual"}
            disabled={!hasAnnual}
            onClick={() => setView("annual")}
          >
            Annual
          </Tab>
          <Tab
            active={view === "quarterly"}
            disabled={!hasQuarterly}
            onClick={() => setView("quarterly")}
          >
            Quarterly
          </Tab>
        </div>
        <div className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-text-muted">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ background: REVENUE }}
          />
          Revenue
        </div>
      </div>
      <Bars ticker={ticker} points={points} view={view} />
    </div>
  );
}

function Tab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`px-2.5 py-1 rounded-[6px] border tracking-[0.04em] uppercase transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 ${
        active
          ? "border-cyan/40 text-cyan bg-cyan/[0.08]"
          : "border-white/[0.12] text-text-muted hover:text-text-dim"
      }`}
    >
      {children}
    </button>
  );
}

function Bars({
  ticker,
  points,
  view,
}: {
  ticker: string;
  points: RevenuePoint[];
  view: "annual" | "quarterly";
}) {
  if (points.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        No {view} revenue data to chart yet.
      </p>
    );
  }

  const yMax = Math.max(...points.map((p) => p.value), 0) || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const slot = plotW / points.length;
  // Cap bar width so a 5-bar annual view doesn't render chunky blocks.
  const barW = Math.min(slot * 0.5, 56);

  const ariaLabel =
    `${ticker} ${view} revenue: ` +
    points.map((p) => `${p.label} ${formatCompactUsd(p.value)}`).join(", ") +
    ".";

  return (
    <div style={{ aspectRatio: `${W} / ${H}` }} className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* baseline */}
        <line
          x1={PAD.left}
          y1={baseY}
          x2={W - PAD.right}
          y2={baseY}
          stroke="#5e696f"
          strokeWidth={1}
        />
        {points.map((p, i) => {
          const cx = PAD.left + slot * (i + 0.5);
          const h = (p.value / yMax) * plotH;
          const barX = cx - barW / 2;
          const barY = baseY - h;
          return (
            <g key={`${p.label}-${i}`}>
              <rect
                x={barX}
                y={barY}
                width={barW}
                height={Math.max(h, 1)}
                rx={3}
                fill={REVENUE}
                opacity={0.85}
              />
              {/* value label above the bar */}
              <text
                x={cx}
                y={barY - 7}
                fontSize={11}
                fill="#A1A1AA"
                fontFamily="monospace"
                textAnchor="middle"
              >
                {p.raw}
              </text>
              {/* period label below the baseline */}
              <text
                x={cx}
                y={H - 9}
                fontSize={10.5}
                fill="#5e696f"
                fontFamily="monospace"
                textAnchor="middle"
              >
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
