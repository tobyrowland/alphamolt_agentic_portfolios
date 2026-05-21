"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Company } from "@/lib/types";
import {
  formatPct,
  formatPrice,
  formatNumber,
  parseEval,
  extractEvalRationale,
} from "@/lib/constants";

type SortKey = keyof Company;
type SortDir = "asc" | "desc";

export default function DataTable({ companies }: { companies: Company[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("sort_order");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "sort_order" || key === "rating" ? "asc" : "desc");
    }
  }

  const filtered = useMemo(() => {
    let rows = companies;

    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (c) =>
          c.ticker.toLowerCase().includes(q) ||
          c.company_name.toLowerCase().includes(q) ||
          c.sector?.toLowerCase().includes(q) ||
          c.country?.toLowerCase().includes(q)
      );
    }

    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [companies, search, sortKey, sortDir]);

  return (
    <div>
      {/* Search */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="text"
          placeholder="Search ticker, company, sector..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-bg-card border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-text focus:outline-none focus:border-white/20 focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/40 placeholder:text-text-muted transition-colors"
        />
      </div>

      {/* Count */}
      <p className="text-xs font-mono text-text-muted mb-3">
        {filtered.length} companies
      </p>

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.02]">
        <table className="w-full text-sm font-mono table-fixed min-w-[1560px]">
          <colgroup>
            <col className="w-[50px]" />   {/* # */}
            <col className="w-[90px]" />   {/* Ticker */}
            <col className="w-[220px]" />  {/* Company */}
            <col className="w-[70px]" />   {/* Score */}
            <col className="w-[160px]" />  {/* Sector */}
            <col className="w-[120px]" />  {/* Country */}
            <col className="w-[90px]" />   {/* Price */}
            <col className="w-[70px]" />   {/* P/S */}
            <col className="w-[80px]" />   {/* P/S Med */}
            <col className="w-[85px]" />   {/* Rev Gr% */}
            <col className="w-[70px]" />   {/* GM% */}
            <col className="w-[75px]" />   {/* FCF M% */}
            <col className="w-[70px]" />   {/* R40 */}
            <col className="w-[90px]" />   {/* 52w vs SPY */}
            <col className="w-[70px]" />   {/* Rating */}
            <col className="w-[70px]" />   {/* Bear */}
            <col className="w-[70px]" />   {/* Bull */}
          </colgroup>
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.02]">
              <Th onClick={() => handleSort("sort_order")} active={sortKey === "sort_order"} dir={sortDir} tooltip="Composite rank (1 = best). Recomputed daily.">#</Th>
              <Th onClick={() => handleSort("ticker")} active={sortKey === "ticker"} dir={sortDir} tooltip="Exchange ticker. Click the row for the company detail page.">Ticker</Th>
              <Th onClick={() => handleSort("company_name")} active={sortKey === "company_name"} dir={sortDir} tooltip="Company name.">Company</Th>
              <Th onClick={() => handleSort("composite_score")} active={sortKey === "composite_score"} dir={sortDir} tooltip="Composite score (0-100). Weights: Rule of 40 ×47%, P/S inverted ×29%, 52w perf vs SPY ×24%. Penalised by red/yellow flags and weak analyst rating.">Score</Th>
              <Th onClick={() => handleSort("sector")} active={sortKey === "sector"} dir={sortDir} tooltip="TradingView sector classification.">Sector</Th>
              <Th onClick={() => handleSort("country")} active={sortKey === "country"} dir={sortDir} tooltip="Country of incorporation / primary listing.">Country</Th>
              <Th onClick={() => handleSort("price")} active={sortKey === "price"} dir={sortDir} tooltip="Latest TradingView close price (USD for US listings; native currency otherwise).">Price</Th>
              <Th onClick={() => handleSort("ps_now")} active={sortKey === "ps_now"} dir={sortDir} tooltip="Trailing-twelve-month price-to-sales ratio.">P/S</Th>
              <Th onClick={() => handleSort("ps_median_12m")} active={sortKey === "ps_median_12m"} dir={sortDir} tooltip="12-month median P/S — anchor for 'is this expensive?'. The Discount badge fires when current P/S is >20% below this.">P/S Med</Th>
              <Th onClick={() => handleSort("rev_growth_ttm_pct")} active={sortKey === "rev_growth_ttm_pct"} dir={sortDir} tooltip="TTM revenue growth — year-over-year percent change.">Rev Gr%</Th>
              <Th onClick={() => handleSort("gross_margin_pct")} active={sortKey === "gross_margin_pct"} dir={sortDir} tooltip="Gross margin (TTM). Screen requires >25%.">GM%</Th>
              <Th onClick={() => handleSort("fcf_margin_pct")} active={sortKey === "fcf_margin_pct"} dir={sortDir} tooltip="Free cash flow margin (TTM). Positive means the business funds itself from operations.">FCF M%</Th>
              <Th onClick={() => handleSort("rule_of_40")} active={sortKey === "rule_of_40"} dir={sortDir} tooltip="Rule of 40: revenue growth + operating margin. Above 40 is the canonical SaaS/growth quality bar.">R40</Th>
              <Th onClick={() => handleSort("perf_52w_vs_spy")} active={sortKey === "perf_52w_vs_spy"} dir={sortDir} tooltip="52-week relative performance vs S&P 500. Capped at +40% in the score (blow-off-top guard); below -50% disqualifies (falling-knife guard).">52w vs SPY</Th>
              <Th onClick={() => handleSort("rating")} active={sortKey === "rating"} dir={sortDir} tooltip="TradingView technical/analyst rating. 1.0 = strong buy, 5.0 = strong sell. Score multiplier tapers from 1.21 and disqualifies above 1.6.">Rating</Th>
              <Th onClick={() => handleSort("bear_eval")} active={sortKey === "bear_eval"} dir={sortDir} tooltip="Forensic fundamental-health audit by Gemini 2.5 Flash. ✅ pass / ❌ fail. Hover a row's badge for the rationale. Refreshed daily on a ~5-day rotation.">Bear</Th>
              <Th onClick={() => handleSort("bull_eval")} active={sortKey === "bull_eval"} dir={sortDir} tooltip="Growth/venture equity audit by Claude Opus 4.6 — looks for 'smash hits' in expanding verticals. ✅ pass / ❌ fail. Hover a row's badge for the rationale. Refreshed daily on a ~5-day rotation.">Bull</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const bear = parseEval(c.bear_eval);
              const bull = parseEval(c.bull_eval);
              const bearRationale = extractEvalRationale(c.bear_eval);
              const bullRationale = extractEvalRationale(c.bull_eval);

              return (
                <tr
                  key={c.ticker}
                  className="border-b border-white/[0.06] hover:bg-white/[0.025] transition-colors"
                >
                  <td className="px-3 py-2 text-text-muted text-right whitespace-nowrap">
                    {c.sort_order ?? "--"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-text">
                    {c.ticker}
                  </td>
                  <td
                    className="px-3 py-2 truncate"
                    title={c.short_outlook || c.company_name || ""}
                  >
                    <Link
                      href={`/company/${c.ticker}`}
                      className="text-text hover:text-[var(--color-cyan)] hover:underline decoration-1 underline-offset-[3px] transition-colors"
                    >
                      {c.company_name || "--"}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {formatNumber(c.composite_score, { decimals: 1 })}
                  </td>
                  <td
                    className="px-3 py-2 text-text-dim text-xs truncate"
                    title={c.sector || ""}
                  >
                    {c.sector || "--"}
                  </td>
                  <td
                    className="px-3 py-2 text-text-dim text-xs truncate"
                    title={c.country || ""}
                  >
                    {c.country || "--"}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {formatPrice(c.price)}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {formatNumber(c.ps_now, { decimals: 1 })}
                  </td>
                  <td className="px-3 py-2 text-right text-text-dim whitespace-nowrap">
                    {formatNumber(c.ps_median_12m, { decimals: 1 })}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <span
                      className={
                        (c.rev_growth_ttm_pct ?? 0) >= 25
                          ? "text-green"
                          : "text-text-dim"
                      }
                    >
                      {formatPct(c.rev_growth_ttm_pct)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <span
                      className={
                        (c.gross_margin_pct ?? 0) >= 45
                          ? "text-green"
                          : "text-text-dim"
                      }
                    >
                      {formatPct(c.gross_margin_pct)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <span
                      className={
                        (c.fcf_margin_pct ?? 0) > 0
                          ? "text-green"
                          : "text-text-dim"
                      }
                    >
                      {formatPct(c.fcf_margin_pct)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <span
                      className={
                        (c.rule_of_40 ?? 0) >= 40
                          ? "text-green"
                          : "text-text-dim"
                      }
                    >
                      {formatNumber(c.rule_of_40, { decimals: 1 })}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <span
                      className={
                        (c.perf_52w_vs_spy ?? 0) >= 0
                          ? "text-green"
                          : "text-text-dim"
                      }
                    >
                      {formatPct(
                        c.perf_52w_vs_spy != null
                          ? c.perf_52w_vs_spy * 100
                          : null,
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-text-dim whitespace-nowrap">
                    {formatNumber(c.rating, { decimals: 1 })}
                  </td>
                  <td
                    className="px-3 py-2 text-center whitespace-nowrap"
                    title={bearRationale ?? undefined}
                  >
                    <span
                      style={{ color: bear.color }}
                      className={bearRationale ? "cursor-help" : undefined}
                    >
                      {bear.label}
                    </span>
                  </td>
                  <td
                    className="px-3 py-2 text-center whitespace-nowrap"
                    title={bullRationale ?? undefined}
                  >
                    <span
                      style={{ color: bull.color }}
                      className={bullRationale ? "cursor-help" : undefined}
                    >
                      {bull.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
  tooltip,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: SortDir;
  tooltip?: string;
}) {
  return (
    <th
      onClick={onClick}
      title={tooltip}
      className="px-3 py-2.5 text-left text-xs uppercase tracking-wider text-text-dim cursor-pointer hover:text-text select-none whitespace-nowrap"
    >
      <span className={active ? "text-[var(--color-cyan)]" : ""}>
        {children}
        {active && (
          <span className="ml-1">{dir === "asc" ? "\u25B2" : "\u25BC"}</span>
        )}
      </span>
    </th>
  );
}
