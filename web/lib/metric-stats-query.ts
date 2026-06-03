/**
 * Read layer for the precomputed `metric_stats` table (migration 038).
 *
 * Powers the fundamentals "distribution strips" on /company/{ticker}
 * (brief §5): each metric is a percentile ruler with a constant
 * middle-50% band (p25–p75), a universe-median tick (p50), a
 * sector-median tick (the sector's median mapped to its universe
 * percentile), and the stock's dot at its percentile.
 *
 * The distributions are precomputed nightly by score_ai_analysis.py
 * (Step 6b) so the page never recomputes them per request — it reads
 * the five summary points (min/p25/p50/p75/max) per (metric, sector)
 * and interpolates a value → percentile against them.
 */

import { getSupabase } from "@/lib/supabase";
import { formatNumber, formatPct } from "@/lib/constants";
import type { Company } from "@/lib/types";

export interface MetricStatRow {
  metric: string;
  sector: string; // "" = universe-wide row
  min_val: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  max_val: number | null;
  sample_count: number;
}

export interface MetricStatsBundle {
  // metric -> universe-wide row (sector === "")
  universe: Record<string, MetricStatRow>;
  // sector -> metric -> row
  bySector: Record<string, Record<string, MetricStatRow>>;
}

// The six metrics rendered as strips, in display order (brief §5). The
// P/S polarity is left RAW — right = more expensive — to match the
// reference mockup; it's the one strip that reads opposite-direction.
export const STRIP_METRICS = [
  { key: "rev_growth_ttm_pct", label: "Revenue growth", kind: "pct" },
  { key: "gross_margin_pct", label: "Gross margin", kind: "pct" },
  { key: "fcf_margin_pct", label: "FCF margin", kind: "pct" },
  { key: "rule_of_40", label: "Rule of 40", kind: "num" },
  { key: "net_margin_pct", label: "Net margin", kind: "pct" },
  { key: "ps_now", label: "P/S multiple", kind: "mult" },
] as const;

export interface StripModel {
  key: string;
  label: string;
  available: boolean;
  valueLabel: string; // "46.1%" / "77.0" / "8.57×"
  stockPct: number | null; // 0–100 — dot position
  sectorPct: number | null; // 0–100 — sector-median tick (mapped to universe percentile)
  percentileLabel: string | null; // "p86"
}

export async function getMetricStats(): Promise<MetricStatsBundle> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("metric_stats")
    .select("metric, sector, min_val, p25, p50, p75, max_val, sample_count");

  const bundle: MetricStatsBundle = { universe: {}, bySector: {} };
  if (error) {
    // Don't break the page — the strips degrade to "stat unavailable".
    console.error("getMetricStats failed:", error.message);
    return bundle;
  }

  for (const raw of (data ?? []) as MetricStatRow[]) {
    const row: MetricStatRow = {
      metric: raw.metric,
      sector: raw.sector ?? "",
      min_val: num(raw.min_val),
      p25: num(raw.p25),
      p50: num(raw.p50),
      p75: num(raw.p75),
      max_val: num(raw.max_val),
      sample_count: Number(raw.sample_count) || 0,
    };
    if (row.sector === "") {
      bundle.universe[row.metric] = row;
    } else {
      (bundle.bySector[row.sector] ??= {})[row.metric] = row;
    }
  }
  return bundle;
}

/**
 * Map a value to a 0–100 percentile against a five-point summary
 * (min→0, p25→25, p50→50, p75→75, max→100), piecewise-linear. Returns
 * null when the row lacks at least two usable points.
 */
export function valueToPercentile(
  v: number,
  row: MetricStatRow | undefined,
): number | null {
  if (!row) return null;
  const pts: Array<[number, number]> = [];
  if (row.min_val != null) pts.push([row.min_val, 0]);
  if (row.p25 != null) pts.push([row.p25, 25]);
  if (row.p50 != null) pts.push([row.p50, 50]);
  if (row.p75 != null) pts.push([row.p75, 75]);
  if (row.max_val != null) pts.push([row.max_val, 100]);
  if (pts.length < 2) return null;

  if (v <= pts[0][0]) return 0;
  if (v >= pts[pts.length - 1][0]) return 100;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (v >= x0 && v <= x1) {
      if (x1 === x0) return y1;
      return y0 + (y1 - y0) * ((v - x0) / (x1 - x0));
    }
  }
  return null;
}

/** Pull the displayed metric value off the company, applying the
 *  gross-margin ≤100 clamp (brief §7). */
function metricValue(company: Company, key: string): number | null {
  const raw = (company as unknown as Record<string, unknown>)[key];
  let v: number | null =
    typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (v != null && key === "gross_margin_pct" && v > 100) v = 100;
  return v;
}

function formatMetric(v: number, kind: "pct" | "num" | "mult"): string {
  if (kind === "pct") return formatPct(v);
  if (kind === "mult") return `${formatNumber(v, { decimals: 2 })}×`;
  return formatNumber(v, { decimals: 1 });
}

/**
 * Build one StripModel per metric for the given company. Pure — no DB
 * access; the caller passes the precomputed bundle + the company's
 * sector so the sector-median tick can be placed.
 */
export function buildStripModels(
  company: Company,
  stats: MetricStatsBundle,
): StripModel[] {
  const sector = (company.sector ?? "").trim();
  const sectorRows = stats.bySector[sector] ?? {};

  return STRIP_METRICS.map((m) => {
    const universeRow = stats.universe[m.key];
    const value = metricValue(company, m.key);
    if (value == null || !universeRow) {
      return {
        key: m.key,
        label: m.label,
        available: false,
        valueLabel: "—",
        stockPct: null,
        sectorPct: null,
        percentileLabel: null,
      } satisfies StripModel;
    }

    const stockPct = valueToPercentile(value, universeRow);
    const sectorMedian = sectorRows[m.key]?.p50 ?? null;
    const sectorPct =
      sectorMedian != null ? valueToPercentile(sectorMedian, universeRow) : null;

    return {
      key: m.key,
      label: m.label,
      available: true,
      valueLabel: formatMetric(value, m.kind),
      stockPct,
      sectorPct,
      percentileLabel: stockPct != null ? `p${Math.round(stockPct)}` : null,
    } satisfies StripModel;
  });
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
