/**
 * Parsers for the `companies` revenue strings into chartable numeric series.
 *
 * The pipeline stores revenue as pre-formatted human strings, not numbers:
 *   annual_revenue_5y: "2025: $1.0B | 2024: $748M | ... | 2021: $251M"
 *   quarterly_revenue: "$292M (2026-03-31) | $283M (2025-12-31) | ..."
 * Both are newest-first. These helpers parse them to oldest-first
 * {label, value, raw} points so a bar chart reads left→right in time order.
 *
 * Net income (annual_net_income_5y / quarterly_net_income) is stored in the
 * same pipe-delimited shape (with "-$X" for loss periods), so these parsers are
 * generic over both series — the revenue-named exports are kept as aliases.
 */

export interface RevenuePoint {
  /** Axis label, e.g. "2025" (annual) or "Q1 '26" (quarterly). */
  label: string;
  /** Numeric USD value for bar heights. */
  value: number;
  /** The source's own formatted string, e.g. "$1.0B" — used as the bar label
   *  so the chart matches the pipeline's rounding exactly. */
  raw: string;
}

const UNIT: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** Parse a single "$1.0B" / "-$1.2B" / "$748M" token to a number. Net income
 *  can be a loss, so an optional leading "-" is honoured. */
function parseAmount(s: string): number | null {
  const m = s.match(/(-?)\s*\$?\s*([\d,.]+)\s*([KMBT])?/i);
  if (!m) return null;
  const num = parseFloat(m[2].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  const unit = m[3] ? (UNIT[m[3].toUpperCase()] ?? 1) : 1;
  return (m[1] === "-" ? -num : num) * unit;
}

/** "2025: $1.0B | 2024: -$0.2B | ..." → [{2021…}, …, {2025…}] (oldest first).
 *  Generic over revenue / net income (same format). */
export function parseAnnualSeries(raw: string | null | undefined): RevenuePoint[] {
  if (!raw) return [];
  const out: RevenuePoint[] = [];
  for (const piece of raw.split("|")) {
    const m = piece.match(/(\d{4})\s*:\s*(.+)/);
    if (!m) continue;
    const value = parseAmount(m[2]);
    if (value == null) continue;
    out.push({ label: m[1], value, raw: m[2].trim() });
  }
  return out.reverse();
}

/** "$292M (2026-03-31) | -$8M (2025-12-31) | ..." → oldest-first quarters.
 *  Generic over revenue / net income (same format). */
export function parseQuarterlySeries(raw: string | null | undefined): RevenuePoint[] {
  if (!raw) return [];
  const out: RevenuePoint[] = [];
  for (const piece of raw.split("|")) {
    const m = piece.match(/(.+?)\((\d{4})-(\d{2})-\d{2}\)/);
    if (!m) continue;
    const value = parseAmount(m[1]);
    if (value == null) continue;
    const year = m[2];
    const month = parseInt(m[3], 10);
    const q = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
    out.push({ label: `Q${q} '${year.slice(2)}`, value, raw: m[1].trim() });
  }
  return out.reverse();
}

/** Back-compat aliases (the parsers are generic over revenue / net income). */
export const parseAnnualRevenue = parseAnnualSeries;
export const parseQuarterlyRevenue = parseQuarterlySeries;

/** Compact USD for axis ticks / aria, e.g. "$1.2B", "$748M". */
export function formatCompactUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(abs / 1e12 >= 10 ? 0 : 1)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(abs / 1e9 >= 10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
