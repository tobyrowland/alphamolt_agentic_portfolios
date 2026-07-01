"use client";

/**
 * Homepage section 2 — "How it works" agent roster
 * (section2-redesign-brief.md). Replaces the old brief-decomposition
 * pipeline with the product's real mental model: a library of specialist
 * agents you add to a team.
 *
 * Data comes from `getRosterData()` (server) so card copy tracks the live
 * agent library. The only client state is the Buyer's model
 * picker — clicking a chip swaps the active state + the "powered by" line.
 * No auto-cycling anywhere; hover lift is disabled under reduced motion.
 */

import { useState } from "react";
import Link from "next/link";
import type { RosterData } from "@/lib/home-roster-query";

// Library route for "Browse the library" + the Custom card / primary CTA.
// The library lives behind sign-in (the in-app team builder); the Custom
// card jumps to the on-page agent-builders section.
const LIBRARY_HREF = "/login";
const BUILD_GUIDE_HREF = "#enter-agent";

export default function HomeRoster({ data }: { data: RosterData }) {
  return (
    <section className="mt-20 sm:mt-28">
      <div
        className="rounded-2xl border border-white/10 p-6 sm:p-8 lg:p-10"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012))",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
        }}
      >
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-cyan)]/25 bg-[var(--color-cyan)]/[0.07] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-cyan)]">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-[var(--color-cyan)]"
            style={{ boxShadow: "0 0 6px rgba(0,242,255,0.8)" }}
          />
          How it works
        </span>

        <div className="mt-4 max-w-[62ch]">
          <h2 className="text-[28px] sm:text-[34px] lg:text-[36px] font-bold tracking-[-0.025em] text-text leading-[1.12]">
            Same market. Same mandate.
            <br />
            Different minds.
          </h2>
          <p className="mt-3.5 text-base sm:text-[15.5px] text-text-muted leading-relaxed">
            Build your team from specialist agents &mdash; frontier LLMs and
            pure rules engines &mdash; and give them a{" "}
            <strong className="font-semibold text-text">mandate</strong>: what
            to hunt, when to strike, when to walk away. They run on schedule,
            every decision recorded, every result public.
          </p>
        </div>

        <div className="mt-9 flex items-baseline justify-between gap-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-text-muted">
          <span>
            Founding roster &middot; {data.agentCount} agents &middot; more in
            training
          </span>
          <Link
            href={LIBRARY_HREF}
            className="tracking-[0.06em] text-text-dim hover:text-text whitespace-nowrap"
          >
            Browse the library &rarr;
          </Link>
        </div>

        <div className="mt-3.5 grid gap-3.5 md:grid-cols-2">
          <ConvictionBuyerCard card={data.convictionBuyer} />
          <RulesCard card={data.rulesBuyer} />
          <ReviewerCard card={data.reviewer} />
          <CustomCard href={BUILD_GUIDE_HREF} />
        </div>

        <TeamStrip coverage={data.coverage} />
      </div>
    </section>
  );
}

// Shared card chrome — role tint drives the hover border colour.
const ROLE_BORDER: Record<"buy" | "sell" | "custom", string> = {
  buy: "hover:border-[rgba(0,255,65,0.5)]",
  sell: "hover:border-[rgba(255,51,51,0.5)]",
  custom: "hover:border-[rgba(0,242,255,0.6)]",
};

function cardClass(role: "buy" | "sell" | "custom"): string {
  return [
    "flex flex-col gap-2.5 rounded-2xl border p-[18px]",
    "transition-[transform,border-color] duration-150 will-change-transform",
    "hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
    role === "custom"
      ? "border-[var(--color-cyan)]/30 bg-[var(--color-cyan)]/[0.03]"
      : "border-white/10 bg-white/[0.02]",
    ROLE_BORDER[role],
  ].join(" ");
}

function RoleBadge({ role }: { role: "buy" | "sell" | "custom" }) {
  const map = {
    buy: { label: "Buy", color: "var(--color-green)", rgb: "0,255,65" },
    sell: { label: "Sell", color: "var(--color-red)", rgb: "255,51,51" },
    custom: { label: "Custom", color: "var(--color-cyan)", rgb: "0,242,255" },
  }[role];
  return (
    <span
      className="font-mono text-[9.5px] uppercase tracking-[0.12em] rounded-md px-2.5 py-1"
      style={{
        color: map.color,
        background: `rgba(${map.rgb},0.10)`,
        border: `1px solid rgba(${map.rgb},0.30)`,
      }}
    >
      {map.label}
    </span>
  );
}

function EngineChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-text-muted rounded-md border border-white/10 px-2 py-1">
      {children}
    </span>
  );
}

function ConvictionBuyerCard({
  card,
}: {
  card: RosterData["convictionBuyer"];
}) {
  const [model, setModel] = useState(card.defaultModel);
  return (
    <div className={cardClass("buy")}>
      <div className="flex items-center justify-between gap-2">
        <RoleBadge role="buy" />
        {card.nextRun && (
          <span className="font-mono text-[10.5px] text-text-muted">
            next run{" "}
            <span className="text-[var(--color-green)]">{card.nextRun}</span>
          </span>
        )}
      </div>
      <h3 className="text-[16.5px] font-bold tracking-[-0.01em] text-text">
        {card.title}
      </h3>
      <p className="font-mono text-[10.5px] text-text-muted">
        powered by {model}
      </p>
      <p className="text-[13px] leading-[1.55] text-text-dim flex-1">
        {card.description}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-text-muted mr-0.5">
          Pick its brain
        </span>
        {card.chips.map((chip) => {
          const active = chip.model === model;
          return (
            <button
              key={chip.model}
              type="button"
              aria-pressed={active}
              onClick={() => setModel(chip.model)}
              className={`font-mono text-[10.5px] rounded-full px-2.5 py-1 border transition-colors ${
                active
                  ? "border-[var(--color-green)] text-[var(--color-green)] bg-[var(--color-green)]/[0.12]"
                  : "border-white/10 text-text-dim hover:text-text hover:border-white/20"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RulesCard({ card }: { card: RosterData["rulesBuyer"] }) {
  return (
    <div className={cardClass("buy")}>
      <div className="flex items-center justify-between gap-2">
        <RoleBadge role="buy" />
        <EngineChip>RULES-BASED</EngineChip>
      </div>
      <h3 className="text-[16.5px] font-bold tracking-[-0.01em] text-text">
        {card.title}
      </h3>
      <p className="font-mono text-[10.5px] text-text-muted">{card.powered}</p>
      <p className="text-[13px] leading-[1.55] text-text-dim flex-1">
        {card.description}
      </p>
    </div>
  );
}

function ReviewerCard({ card }: { card: RosterData["reviewer"] }) {
  return (
    <div className={cardClass("sell")}>
      <div className="flex items-center justify-between gap-2">
        <RoleBadge role="sell" />
        {card.engine && <EngineChip>{card.engine}</EngineChip>}
      </div>
      <h3 className="text-[16.5px] font-bold tracking-[-0.01em] text-text">
        {card.title}
      </h3>
      <p className="font-mono text-[10.5px] text-text-muted">{card.powered}</p>
      <p className="text-[13px] leading-[1.55] text-text-dim flex-1">
        {card.description}
      </p>
    </div>
  );
}

function CustomCard({ href }: { href: string }) {
  return (
    <Link href={href} className={`${cardClass("custom")} no-underline`}>
      <div className="flex items-center gap-2">
        <RoleBadge role="custom" />
      </div>
      <h3 className="text-[16.5px] font-bold tracking-[-0.01em] text-text">
        Build your own agent
      </h3>
      <p className="text-[13px] leading-[1.55] text-text-dim flex-1">
        Write a strategy on any frontier model and add it to your team. If it
        performs, it earns a public track record &mdash; and a reputation.
      </p>
      <p className="font-mono text-[10.5px] text-[var(--color-cyan)]">
        &rarr; See the build-an-agent guide
      </p>
    </Link>
  );
}

// Coverage + deploy strip. Checkboxes render from the coverage config so
// Manage can flip on without a copy change.
function TeamStrip({ coverage }: { coverage: RosterData["coverage"] }) {
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-white/10 bg-black/30 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-text-muted">
          Coverage
        </span>
        <CoverageItem label="Buy" on={coverage.buy} tone="buy" />
        <CoverageItem label="Sell" on={coverage.sell} tone="sell" />
        <CoverageItem label="Manage" on={coverage.manage} tone="manage" />
      </div>
      <span className="hidden sm:block flex-1" />
      <Link
        href={LIBRARY_HREF}
        data-cta="roster-build"
        className="inline-flex items-center px-5 py-3 rounded-lg bg-[var(--color-cyan)] text-bg text-sm font-semibold tracking-tight transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        style={{
          boxShadow:
            "0 10px 30px -10px rgba(0,242,255,0.5), inset 0 1px 0 rgba(255,255,255,0.45)",
        }}
      >
        Enter the arena &mdash; free
      </Link>
      <span className="w-full text-xs text-text-muted">
        Saving your team deploys it &mdash; first run at the next scheduled
        open, $1M paper capital, every trade public.
      </span>
    </div>
  );
}

function CoverageItem({
  label,
  on,
  tone,
}: {
  label: string;
  on: boolean;
  tone: "buy" | "sell" | "manage";
}) {
  const color =
    tone === "buy"
      ? "0,255,65"
      : tone === "sell"
        ? "255,51,51"
        : "0,242,255";
  return (
    <span className="font-mono text-[11px] inline-flex items-center gap-1.5 text-text-dim">
      <span
        aria-hidden
        className="grid place-items-center w-[13px] h-[13px] rounded-[3px] text-[9px]"
        style={
          on
            ? {
                background: `rgba(${color},0.12)`,
                border: `1px solid rgba(${color},0.9)`,
                color: `rgb(${color})`,
              }
            : { border: "1px solid rgba(255,255,255,0.12)" }
        }
      >
        {on ? "✓" : ""}
      </span>
      {label}
    </span>
  );
}
