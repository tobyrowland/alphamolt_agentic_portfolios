/**
 * Screener filter transforms (migration 076) — time-series math over the
 * stored quarterly metric series (`screen_facts().quarters`, written by
 * eodhd_updater.compute_quarterly_series).
 *
 * A filter is `metric + op + value`; a transform adds the missing dimension —
 * HOW to look at the metric over time. "Two consecutive quarters of improving
 * QoQ revenue growth" is `{field: rev_growth_qoq, transform: streak_qtrs,
 * op: >=, value: 2}` — any metric × any transform, no bespoke column.
 *
 * DELIBERATELY dependency-free (no zod, no path aliases): the parity test
 * (tests/test_transforms.py) executes this file directly under
 * `node --experimental-strip-types` and asserts it agrees with the Python
 * mirror in screen.py over the shared fixture
 * (tests/fixtures/transform_parity.json). Every function here MUST match
 * screen.py's `_TRANSFORMS` exactly — same null rules, same arithmetic
 * expressions, so IEEE-754 doubles come out bit-identical on both sides.
 *
 * All series are NEWEST-FIRST (index 0 = latest quarter), nulls preserved in
 * place so positions never shift.
 */

export const TRANSFORMS = [
  "delta_qoq", // latest quarter minus prior (pp / native units)
  "yoy", // latest quarter minus the year-ago quarter (index 4)
  "streak_qtrs", // consecutive improving steps from the latest value back
  "slope_4q", // least-squares trend per quarter over the last 4 (needs all 4)
  "mean_4q", // mean over the last 4 (needs ≥ 2 present)
  "min_4q", // min over the last 4 (needs ≥ 1 present)
  "max_4q", // max over the last 4 (needs ≥ 1 present)
  "range_4q", // max − min over the last 4 (needs ≥ 2 present)
  "pctile_own", // latest value's percentile within the stored series (needs ≥ 4)
] as const;
export type Transform = (typeof TRANSFORMS)[number];

/** Filter field → key inside the `quarters` series object. Fields listed here
 *  accept a `transform`; without one they read their scalar matview column as
 *  always (rev_growth_qoq's scalar landed in migration 075). MUST match
 *  screen.py SERIES_FIELDS. */
export const SERIES_FIELDS: Record<string, string> = {
  gross_margin: "gross_margin",
  operating_margin: "operating_margin",
  net_margin: "net_margin",
  fcf_margin: "fcf_margin",
  rev_growth_qoq: "rev_growth_qoq",
  rev_growth_yoy_q: "rev_growth_yoy",
  revenue: "revenue",
};

/** Fields with no scalar matview column — usable only WITH a transform. A
 *  transform-less filter on one is a no-constraint (matches everything), the
 *  same on both scorers; the config schema + UI prevent creating that state. */
export const SERIES_ONLY_FIELDS = new Set(["revenue"]);

/** The quarterly series object stored on a screen-facts row (`quarters`). */
export interface QuarterSeries {
  period_ends?: (string | null)[];
  [metric: string]: unknown;
}

/** Extract one metric's numeric series (newest-first) from the quarters
 *  object; null when absent/malformed. Mirrors screen.py _series_for. */
export function seriesFor(
  quarters: QuarterSeries | null | undefined,
  key: string,
): (number | null)[] | null {
  const raw = quarters?.[key];
  if (!Array.isArray(raw)) return null;
  return raw.map((v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });
}

type Series = (number | null)[];

function deltaQoq(s: Series): number | null {
  if (s.length < 2 || s[0] == null || s[1] == null) return null;
  return s[0] - s[1];
}

function yoy(s: Series): number | null {
  if (s.length < 5 || s[0] == null || s[4] == null) return null;
  return s[0] - s[4];
}

/** Consecutive improving steps from the newest value backwards — the same
 *  semantics as eodhd_updater._improvement_streak. Null when the latest step
 *  can't even be assessed (distinguishing "no data" from a genuine 0). */
function streakQtrs(s: Series): number | null {
  if (s.length < 2 || s[0] == null || s[1] == null) return null;
  let n = 0;
  for (let i = 0; i + 1 < s.length; i++) {
    const cur = s[i];
    const prev = s[i + 1];
    if (cur == null || prev == null || cur <= prev) break;
    n += 1;
  }
  return n;
}

/** Least-squares trend per quarter over the last 4 points (positive =
 *  improving toward the present). Closed form for times [0,−1,−2,−3] so both
 *  implementations evaluate the identical expression. Needs all 4 present. */
function slope4q(s: Series): number | null {
  if (s.length < 4) return null;
  const [v0, v1, v2, v3] = [s[0], s[1], s[2], s[3]];
  if (v0 == null || v1 == null || v2 == null || v3 == null) return null;
  return (1.5 * v0 + 0.5 * v1 - 0.5 * v2 - 1.5 * v3) / 5;
}

function present4(s: Series): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4 && i < s.length; i++) {
    const v = s[i];
    if (v != null) out.push(v);
  }
  return out;
}

function mean4q(s: Series): number | null {
  const vals = present4(s);
  if (vals.length < 2) return null;
  let sum = 0;
  for (const v of vals) sum += v;
  return sum / vals.length;
}

function min4q(s: Series): number | null {
  const vals = present4(s);
  return vals.length ? Math.min(...vals) : null;
}

function max4q(s: Series): number | null {
  const vals = present4(s);
  return vals.length ? Math.max(...vals) : null;
}

function range4q(s: Series): number | null {
  const vals = present4(s);
  if (vals.length < 2) return null;
  return Math.max(...vals) - Math.min(...vals);
}

/** The latest value's empirical percentile (0–100) within the whole stored
 *  series — "is it high or low by its own history". count(v ≤ latest)/n, the
 *  same convention as the lens pctRank. Needs ≥ 4 present values. */
function pctileOwn(s: Series): number | null {
  if (!s.length || s[0] == null) return null;
  const latest = s[0];
  const vals: number[] = [];
  for (const v of s) if (v != null) vals.push(v);
  if (vals.length < 4) return null;
  let le = 0;
  for (const v of vals) if (v <= latest) le += 1;
  return (le / vals.length) * 100;
}

const FNS: Record<Transform, (s: Series) => number | null> = {
  delta_qoq: deltaQoq,
  yoy,
  streak_qtrs: streakQtrs,
  slope_4q: slope4q,
  mean_4q: mean4q,
  min_4q: min4q,
  max_4q: max4q,
  range_4q: range4q,
  pctile_own: pctileOwn,
};

/** Evaluate a transform over a series; null series / unknown transform / not
 *  enough data ⇒ null (a numeric filter then excludes the row — the standard
 *  missing-datum rule). */
export function applyTransform(
  series: (number | null)[] | null,
  transform: string,
): number | null {
  const fn = FNS[transform as Transform];
  if (!fn || !series) return null;
  return fn(series);
}
