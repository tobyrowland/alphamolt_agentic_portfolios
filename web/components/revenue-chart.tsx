"use client";

/**
 * Income-statement chart for the equity overview page — grouped Revenue + Net
 * income bars with an Annual / Quarterly toggle (modelled on the reference
 * mockup). Net income can be a loss, so the chart uses a signed scale with the
 * baseline at zero: profit bars rise above it, losses drop below.
 *
 * Client component for the toggle, but its initial (Annual) view is server-
 * rendered to HTML, so the figures ship in the SSR markup for crawlers and
 * there's no layout shift (space reserved via an aspect-ratio box).
 */

import { useState } from "react";
import type { RevenuePoint } from "@/lib/company-financials";
import { formatCompactUsd } from "@/lib/company-financials";

const W = 620;
const H = 240;
const PAD = { left: 8, right: 8, top: 28, bottom: 26 };
const REVENUE = "#00F2FF";
const PROFIT = "#3fb950";
const LOSS = "#f85149";

export default function RevenueChart({
  ticker,
  annual,
  quarterly,
  annualNet = [],
  quarterlyNet = [],
}: {
  ticker: string;
  annual: RevenuePoint[];
  quarterly: RevenuePoint[];
  annualNet?: RevenuePoint[];
  quarterlyNet?: RevenuePoint[];
}) {
  // Default to whichever has data, preferring Annual (matches the mockup).
  const [view, setView] = useState<"annual" | "quarterly">(
    annual.length > 0 ? "annual" : "quarterly",
  );
  const points = view === "annual" ? annual : quarterly;
  const net = view === "annual" ? annualNet : quarterlyNet;

  const hasAnnual = annual.length > 0;
  const hasQuarterly = quarterly.length > 0;
  const hasNet = net.length > 0;

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
        <div className="inline-flex items-center gap-3 font-mono text-[10.5px] text-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: REVENUE }}
            />
            Revenue
          </span>
          {hasNet && (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: PROFIT }}
              />
              Net income
            </span>
          )}
        </div>
      </div>
      <Bars ticker={ticker} points={points} net={net} view={view} />
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
  net,
  view,
}: {
  ticker: string;
  points: RevenuePoint[];
  net: RevenuePoint[];
  view: "annual" | "quarterly";
}) {
  if (points.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        No {view} revenue data to chart yet.
      </p>
    );
  }

  const netByLabel = new Map(net.map((p) => [p.label, p]));
  const hasNet = net.length > 0;

  // Signed scale: baseline at value 0, so losses draw below it.
  const allVals = [
    ...points.map((p) => p.value),
    ...net.map((p) => p.value),
  ];
  const yMax = Math.max(0, ...allVals);
  const yMin = Math.min(0, ...allVals);
  const range = yMax - yMin || 1;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const yOf = (v: number) => PAD.top + ((yMax - v) / range) * plotH;
  const zeroY = yOf(0);
  const slot = plotW / points.length;
  // Two grouped bars per period when net income is present, else one wide bar.
  const barW = hasNet
    ? Math.min(slot * 0.3, 30)
    : Math.min(slot * 0.5, 56);
  const gap = hasNet ? barW * 0.25 : 0;

  const ariaLabel =
    `${ticker} ${view} revenue and net income: ` +
    points
      .map((p) => {
        const n = netByLabel.get(p.label);
        return `${p.label} revenue ${formatCompactUsd(p.value)}${
          n ? `, net income ${formatCompactUsd(n.value)}` : ""
        }`;
      })
      .join("; ") +
    ".";

  const bar = (
    cx: number,
    pt: RevenuePoint,
    fill: string,
    labelAbove: boolean,
  ) => {
    const y = yOf(pt.value);
    const top = Math.min(y, zeroY);
    const h = Math.max(Math.abs(zeroY - y), 1);
    const labelY = pt.value >= 0 ? top - 7 : top + h + 13;
    return (
      <>
        <rect
          x={cx - barW / 2}
          y={top}
          width={barW}
          height={h}
          rx={3}
          fill={fill}
          opacity={0.85}
        />
        {labelAbove && (
          <text
            x={cx}
            y={labelY}
            fontSize={10.5}
            fill="#A1A1AA"
            fontFamily="monospace"
            textAnchor="middle"
          >
            {pt.raw}
          </text>
        )}
      </>
    );
  };

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
        {/* zero baseline */}
        <line
          x1={PAD.left}
          y1={zeroY}
          x2={W - PAD.right}
          y2={zeroY}
          stroke="#5e696f"
          strokeWidth={1}
        />
        {points.map((p, i) => {
          const center = PAD.left + slot * (i + 0.5);
          const n = netByLabel.get(p.label);
          // Revenue value label always shown; net income label only when it
          // wouldn't collide (kept compact — revenue is the headline series).
          const revCx = hasNet ? center - (barW + gap) / 2 : center;
          return (
            <g key={`${p.label}-${i}`}>
              {bar(revCx, p, REVENUE, true)}
              {hasNet && n &&
                bar(
                  center + (barW + gap) / 2,
                  n,
                  n.value >= 0 ? PROFIT : LOSS,
                  false,
                )}
              {/* period label below the chart */}
              <text
                x={center}
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
