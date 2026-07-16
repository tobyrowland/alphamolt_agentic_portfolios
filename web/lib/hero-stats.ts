/**
 * Pure logic for the homepage "swarm manager" hero stat strip.
 *
 * No framework imports on purpose — tests/test_hero_stats.py exercises this
 * file directly under `node --experimental-strip-types` (same pattern as
 * web/lib/screen/transforms.ts). The Supabase fetch that feeds these
 * functions lives in web/lib/hero-stats-query.ts.
 */

// Stat A renders as "{count} of the first 500" / "founding cohort" until this
// many distinct users hold the title; from then on it's the plain worldwide
// count. Single source for the threshold (hero brief).
export const FOUNDING_COHORT_CAP = 500;

// A quarter younger than this many days is all noise — Stat B falls back to
// a trailing-90-day window and relabels accordingly.
export const MIN_QUARTER_AGE_DAYS = 14;

export interface SeriesPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface AlphaWindow {
  startIso: string; // inclusive window start, YYYY-MM-DD
  label: "best alpha this quarter" | "best alpha, trailing 90d";
}

export interface HeroStat {
  value: string;
  label: string;
}

// Pick the alpha window for Stat B: current quarter-to-date, unless the
// quarter is under MIN_QUARTER_AGE_DAYS old, in which case trailing 90d.
export function resolveAlphaWindow(todayIso: string): AlphaWindow {
  const today = new Date(`${todayIso}T00:00:00Z`);
  const qStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
  const qStart = new Date(Date.UTC(today.getUTCFullYear(), qStartMonth, 1));
  const quarterAgeDays = (today.getTime() - qStart.getTime()) / 86_400_000;
  if (quarterAgeDays < MIN_QUARTER_AGE_DAYS) {
    const start = new Date(today.getTime() - 90 * 86_400_000);
    return { startIso: isoDate(start), label: "best alpha, trailing 90d" };
  }
  return { startIso: isoDate(qStart), label: "best alpha this quarter" };
}

// Percent return over the window. Baseline is the FIRST point on/after the
// window start (the same convention the leaderboard uses for its YTD anchor);
// the endpoint is the latest point. Null when the series can't support the
// window: fewer than two points, no point inside the window, no elapsed time
// between baseline and endpoint, or a non-positive baseline value.
export function windowReturnPct(
  series: SeriesPoint[],
  startIso: string,
): number | null {
  if (series.length < 2) return null;
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : 1));
  const base = sorted.find((p) => p.date >= startIso);
  const latest = sorted[sorted.length - 1];
  if (!base || base.date >= latest.date) return null;
  if (!(base.value > 0)) return null;
  return ((latest.value - base.value) / base.value) * 100;
}

// Best alpha vs the benchmark across all portfolio series, in integer basis
// points. Null when the benchmark window can't be computed or no portfolio
// has enough history — the caller hides the stat strip rather than invent
// a number.
export function bestAlphaBps(
  portfolioSeries: SeriesPoint[][],
  benchmark: SeriesPoint[],
  startIso: string,
): number | null {
  const benchPct = windowReturnPct(benchmark, startIso);
  if (benchPct == null) return null;
  let best: number | null = null;
  for (const s of portfolioSeries) {
    const pct = windowReturnPct(s, startIso);
    if (pct == null) continue;
    const bps = Math.round((pct - benchPct) * 100);
    if (best == null || bps > best) best = bps;
  }
  return best;
}

// "+600 bps" / "-125 bps" — integer bps, sign always shown.
export function formatBps(bps: number): string {
  const rounded = Math.round(bps);
  const sign = rounded < 0 ? "-" : "+";
  return `${sign}${Math.abs(rounded).toLocaleString("en-US")} bps`;
}

// Stat A: worldwide count once past the cap, founding-cohort variant below it.
export function statAVariant(count: number): HeroStat {
  if (count < FOUNDING_COHORT_CAP) {
    return {
      value: `${count.toLocaleString("en-US")} of the first ${FOUNDING_COHORT_CAP}`,
      label: "founding cohort",
    };
  }
  return {
    value: count.toLocaleString("en-US"),
    label: "hold the title worldwide",
  };
}

// "DD Mon YYYY" — e.g. "16 Jul 2026". Fed the data-compile date, never the
// request date.
export function formatSnapshotDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const mon = d.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return `${String(d.getUTCDate()).padStart(2, "0")} ${mon} ${d.getUTCFullYear()}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
