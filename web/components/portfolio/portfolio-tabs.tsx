"use client";

import { useState, type ReactNode } from "react";

/**
 * Two-tab shell for the owner's portfolio page: Portfolio (the book — summary,
 * team, holdings, trades) and Universe (the embedded screener). Both panels
 * stay mounted (hidden via CSS) so unsaved screener edits survive switching
 * tabs; only the owner of a paper book sees tabs at all — the page renders
 * the plain single-column view for everyone else.
 */
export default function PortfolioTabs({
  portfolio,
  universe,
}: {
  portfolio: ReactNode;
  universe: ReactNode;
}) {
  const [active, setActive] = useState<"portfolio" | "universe">("portfolio");

  const tab = (key: "portfolio" | "universe", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={active === key}
      onClick={() => setActive(key)}
      className={`px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] border-b-2 -mb-px transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 ${
        active === key
          ? "border-[var(--color-green)] text-text"
          : "border-transparent text-text-muted hover:text-text"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div
        role="tablist"
        aria-label="Portfolio sections"
        className="flex items-center gap-1 border-b border-white/10 mb-8"
      >
        {tab("portfolio", "Portfolio")}
        {tab("universe", "Universe")}
      </div>
      <div role="tabpanel" hidden={active !== "portfolio"}>
        {portfolio}
      </div>
      <div role="tabpanel" hidden={active !== "universe"}>
        {universe}
      </div>
    </div>
  );
}
