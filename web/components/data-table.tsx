"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Company } from "@/lib/types";
import {
  formatPct,
  formatPrice,
  formatNumber,
  parseStatus,
  parseEval,
  extractEvalRationale,
} from "@/lib/constants";

type SortKey = keyof Company;
type SortDir = "asc" | "desc";

const STATUS_OPTIONS = ["All", "Discount", "Excluded"];

export default function DataTable({ companies }: { companies: Company[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
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

    if (statusFilter !== "All") {
      rows = rows.filter((c) => c.status?.includes(statusFilter));
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
  }, [companies, search, statusFilter, sortKey, sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="text"
          placeholder="Search ticker, company, sector..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-bg-card border border-border rounded px-3 py-2 text-sm font-mono text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
        />
        <div className="flex gap-1">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-2 text-xs font-mono rounded transition-colors ${
                statusFilter === s
                  ? "bg-green/10 text-green border border-green/30"
                  : "text-text-dim border border-border hover:border-border-light"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Count */}
      <p className="text-xs font-mono text-text-muted mb-3">
        {filtered.length} companies
      </p>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm font-mono table-fixed min-w-[1200px]">
          <colgroup>
            <col className="w-[50px]" />
            <col className="w-[90px]" />
            <col className="w-[90px]" />
            <col className="w-[220px]" />
            <col className="w-[70px]" />
            <col className="w-[160px]" />
            <col className="w-[120px]" />
            <col className="w-[90px]" />
            <col className="w-[70px]" />
            <col className="w-[85px]" />
            <col className="w-[70px]" />
            <col className="w-[70px]" />
            <col className="w-[70px]" />
            <col className="w-[70px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-bg-card">
              <Th onClick={() => handleSort("sort_order")} active={sortKey === "sort_order"} dir={sortDir}>#</Th>
              <Th onClick={() => handleSort("status")} active={sortKey === "status"} dir={sortDir}>Status</Th>
              <Th onClick={() => handleSort("ticker")} active={sortKey === "ticker"} dir={sortDir}>Ticker</Th>
              <Th onClick={() => handleSort("company_name")} active={sortKey === "company_name"} dir={sortDir}>Company</Th>
              <Th onClick={() => handleSort("composite_score")} active={sortKey === "composite_score"} dir={sortDir}>Score</Th>
              <Th onClick={() => handleSort("sector")} active={sortKey === "sector"} dir={sortDir}>Sector</Th>
              <Th onClick={() => handleSort("country")} active={sortKey === "country"} dir={sortDir}>Country</Th>
              <Th onClick={() => handleSort("price")} active={sortKey === "price"} dir={sortDir}>Price</Th>
              <Th onClick={() => handleSort("ps_now")} active={sortKey === "ps_now"} dir={sortDir}>P/S</Th>
              <Th onClick={() => handleSort("rev_growth_ttm_pct")} active={sortKey === "rev_growth_ttm_pct"} dir={sortDir}>Rev Gr%</Th>
              <Th onClick={() => handleSort("gross_margin_pct")} active={sortKey === "gross_margin_pct"} dir={sortDir}>GM%</Th>
              <Th onClick={() => handleSort("rating")} active={sortKey === "rating"} dir={sortDir}>Rating</Th>
              <Th onClick={() => handleSort("bear_eval")} active={sortKey === "bear_eval"} dir={sortDir}>Bear</Th>
              <Th onClick={() => handleSort("bull_eval")} active={sortKey === "bull_eval"} dir={sortDir}>Bull</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const st = parseStatus(c.status);
              const bear = parseEval(c.bear_eval);
              const bull = parseEval(c.bull_eval);
              const bearRationale = extractEvalRationale(c.bear_eval);
              const bullRationale = extractEvalRationale(c.bull_eval);

              return (
                <tr
                  key={c.ticker}
                  className="border-b border-border/50 hover:bg-bg-hover transition-colors"
                >
                  <td className="px-3 py-2 text-text-muted text-right whitespace-nowrap">
                    {c.sort_order ?? "--"}
                  </td>
                  <td
                    className="px-3 py-2 whitespace-nowrap overflow-hidden"
                    title={st.detail ?? st.label ?? ""}
                  >
                    {st.label && (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{
                          color: st.color,
                          backgroundColor: st.color + "15",
                        }}
                      >
                        {st.label}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-text">
                    {c.ticker}
                  </td>
                  <td
                    className="px-3 py-2 truncate"
                    title={c.company_name || ""}
                  >
                    <Link
                      href={`/company/${c.ticker}`}
                      className="text-green hover:underline"
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
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: SortDir;
}) {
  return (
    <th
      onClick={onClick}
      className="px-3 py-2.5 text-left text-xs uppercase tracking-wider text-text-dim cursor-pointer hover:text-text select-none whitespace-nowrap"
    >
      <span className={active ? "text-green" : ""}>
        {children}
        {active && (
          <span className="ml-1">{dir === "asc" ? "\u25B2" : "\u25BC"}</span>
        )}
      </span>
    </th>
  );
}
