/**
 * Screener config model (brief v2 §4) — the small, shareable recipe that
 * defines a screen. Encoded in the URL so any screen is bookmarkable /
 * indexable, and stored verbatim on a portfolio (`portfolios.screen_config`)
 * as that portfolio's selection recipe.
 *
 * Two config layers (brief §2): a plain-English `brief` (human layer) that the
 * design-time `/compile-brief` LLM translates into the deterministic
 * `filters` + `weights` (machine layer). Agents read the compiled config,
 * never the prose. The daily re-rank is pure deterministic computation — no
 * LLM in the ranking loop.
 */

import { z } from "zod";
import {
  SERIES_FIELDS,
  SERIES_ONLY_FIELDS,
  TRANSFORMS,
  type Transform,
} from "@/lib/screen/transforms";

// Fields a filter can target — these map 1:1 onto screen_facts() columns
// (migration 040). Numeric unless noted.
export const FILTER_FIELDS = [
  "sector", // text
  "industry", // text
  "country", // text
  "ps", // P/S
  "rev_growth_ttm",
  "gross_margin",
  "fcf_margin",
  "net_margin",
  "operating_margin",
  "rule_of_40",
  "ret_52w",
  // Derived (not a raw screen_facts column): 52-week return minus SPY's, so
  // it's computed in the loader (web/lib/screen/query.ts + screen.py) from
  // ret_52w and the SPY benchmark.
  "perf_52w_vs_spy",
  "price",
  // Turnaround facts (migration 074). Washout structure:
  "drawdown_52w", // % below the 52-week closing high (positive = drawn down)
  "above_low_26w", // % above the 26-week closing low (base forming)
  "ps_vs_median", // signed % premium to the name's own 12-mo median P/S
  // Inflection gate: how many of the three QoQ streaks (GM expanding, QoQ
  // revenue growth improving, FCF margin improving) are ≥ 2 quarters (0–3).
  "inflection_signals",
  // Survivability gate (hard filters, never scored):
  "net_debt_ebitda",
  "interest_coverage",
  // Series-only fields (migration 075): live in the `quarters` series, not as
  // scalar columns — usable only WITH a transform (schema-enforced below).
  "rev_growth_qoq",
  "revenue",
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const TEXT_FIELDS = new Set<FilterField>(["sector", "industry", "country"]);

export const FILTER_OPS = ["<=", ">=", "<", ">", "==", "!="] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const filterSchema = z
  .object({
    field: z.enum(FILTER_FIELDS),
    op: z.enum(FILTER_OPS),
    value: z.union([z.number(), z.string()]),
    // Time-series transform (migration 075) — how to look at the metric over
    // the stored quarterly series instead of its latest scalar. Only fields in
    // SERIES_FIELDS carry one; rev_growth_qoq/revenue REQUIRE one.
    transform: z.enum(TRANSFORMS).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.transform && !SERIES_FIELDS[f.field]) {
      ctx.addIssue({
        code: "custom",
        message: `${f.field} has no quarterly series — transform not allowed`,
      });
    }
    if (!f.transform && SERIES_ONLY_FIELDS.has(f.field)) {
      ctx.addIssue({
        code: "custom",
        message: `${f.field} is series-only — a transform is required`,
      });
    }
  });
export type Filter = z.infer<typeof filterSchema>;
export { SERIES_FIELDS, SERIES_ONLY_FIELDS, TRANSFORMS };
export type { Transform };

export const weightsSchema = z.object({
  quality: z.number().min(0).max(100),
  value: z.number().min(0).max(100),
  momentum: z.number().min(0).max(100),
  // Fourth lens (migration 074): quarter-over-quarter inflection — is
  // something actually changing at the company. Defaults 0 so every stored /
  // shared config predating it re-ranks identically.
  inflection: z.number().min(0).max(100).default(0),
});
export type Weights = z.infer<typeof weightsSchema>;

// AI trajectory-adjustment authority (σ). The default matches the classic
// fixed constant; a screen can raise it (the turnaround preset does — the
// research card is exactly the "is something changing here" read) up to MAX.
// score.ts re-exports BUDGET/AI_BUDGET_MAX from these. MUST match screen.py.
export const AI_BUDGET_DEFAULT = 0.7;
export const AI_BUDGET_MAX_VALUE = 1.5;

export const screenConfigSchema = z.object({
  brief: z.string().max(2000).optional(),
  preset: z.string().optional(),
  filters: z.array(filterSchema).max(20).default([]),
  weights: weightsSchema.default({ quality: 45, value: 25, momentum: 20, inflection: 0 }),
  aiMultiplier: z.boolean().default(true),
  // How far the AI research-card adjustment can move a name, in σ (migration
  // 074). Default = the classic fixed constant, so old configs are unchanged.
  aiBudget: z.number().min(0).max(AI_BUDGET_MAX_VALUE).default(AI_BUDGET_DEFAULT),
  // Research-card business-quality tilt (migration 056): ±20% by quality_score,
  // neutral when a name has no card. On by default.
  qualityMultiplier: z.boolean().default(true),
  // Hide names this portfolio's buyer evaluated and passed on, for 90 days
  // (migration 051). On by default; per-portfolio, owner can restore early.
  hideRejected: z.boolean().default(true),
  // Bounds a portfolio's buyer candidate pool (screen.py:portfolio_screen_
  // candidate_rows slices ranked[:topN]). Fixed default — no screener UI control;
  // set only via a portfolio's stored screen_config. Aligns with
  // agent_heartbeat.MAX_SWARM_EVAL (40).
  topN: z.number().int().min(1).max(200).default(40),
  sort: z
    .object({
      column: z.string().default("score"),
      dir: z.enum(["asc", "desc"]).default("desc"),
    })
    .default({ column: "score", dir: "desc" }),
});
export type ScreenConfig = z.infer<typeof screenConfigSchema>;

// ---- House presets (indexable; brief §7) ---------------------------------

export interface Preset {
  id: string;
  label: string;
  description: string;
  config: Omit<ScreenConfig, "preset">;
}

const base = {
  brief: undefined,
  sort: { column: "score", dir: "desc" as const },
  topN: 40,
  hideRejected: true,
  aiMultiplier: true,
  qualityMultiplier: true,
  aiBudget: AI_BUDGET_DEFAULT,
};

export const PRESETS: Record<string, Preset> = {
  "quality-growth": {
    id: "quality-growth",
    label: "Quality Growth",
    description:
      "Durable compounders — Rule of 40 ≥ 40, double-digit growth, fat gross margins, valuation kept sane.",
    config: {
      ...base,
      brief:
        "Durable quality compounders: Rule of 40 at or above 40, still growing revenue 10%+, with fat gross margins (40%+) and the valuation kept sane — P/S under 15.",
      filters: [
        { field: "rule_of_40", op: ">=", value: 40 },
        { field: "rev_growth_ttm", op: ">=", value: 10 },
        { field: "gross_margin", op: ">=", value: 40 },
        { field: "ps", op: "<=", value: 15 },
      ],
      weights: { quality: 60, value: 25, momentum: 15, inflection: 0 },
    },
  },
  "deep-value": {
    id: "deep-value",
    label: "Deep Value",
    description:
      "Cheap on sales vs their own history — but still profitable and not shrinking, to dodge value traps.",
    config: {
      ...base,
      brief:
        "Cheap on sales relative to their own 12-month history — P/S under 8 — but still profitable (operating margin ≥ 0) and not shrinking (revenue growth ≥ 0), so the discount isn't a value trap.",
      filters: [
        { field: "ps", op: "<=", value: 8 },
        { field: "operating_margin", op: ">=", value: 0 },
        { field: "rev_growth_ttm", op: ">=", value: 0 },
      ],
      weights: { quality: 20, value: 60, momentum: 20, inflection: 0 },
    },
  },
  momentum: {
    id: "momentum",
    label: "Momentum",
    description:
      "Price leaders beating SPY, filtered for real growth and decent margins so it's not junk.",
    config: {
      ...base,
      brief:
        "Market leaders by trailing 52-week price strength — beating SPY by 5%+ — with real revenue growth (10%+) and decent gross margins (25%+) as a quality sanity check so I'm not just chasing junk.",
      filters: [
        { field: "perf_52w_vs_spy", op: ">=", value: 5 },
        { field: "rev_growth_ttm", op: ">=", value: 10 },
        { field: "gross_margin", op: ">=", value: 25 },
      ],
      weights: { quality: 25, value: 15, momentum: 60, inflection: 0 },
    },
  },
  "high-fcf": {
    id: "high-fcf",
    label: "High FCF",
    description:
      "Cash machines — high free-cash-flow margin, Rule of 40, and genuine operating profitability.",
    config: {
      ...base,
      brief:
        "Cash machines: free-cash-flow margin of 15%+, Rule of 40 at or above 40, and genuine operating profitability (operating margin 10%+). Valuation is secondary.",
      filters: [
        { field: "fcf_margin", op: ">=", value: 15 },
        { field: "rule_of_40", op: ">=", value: 40 },
        { field: "operating_margin", op: ">=", value: 10 },
      ],
      weights: { quality: 65, value: 20, momentum: 15, inflection: 0 },
    },
  },
  turnaround: {
    id: "turnaround",
    label: "Turnaround",
    description:
      "Washed-out names showing a real operating inflection — 40–70% off the high, off the low, cheap vs their own history, ranked by what's actually changing.",
    config: {
      ...base,
      brief:
        "Turnarounds, not value traps. Washout gate: price 40–70% off the 52-week high but at least 10% above the 6-month low (a base forming, not still falling), and P/S below the stock's own 12-month median. Then rank almost entirely on operating inflection — gross margin expanding, QoQ revenue growth improving, FCF trending toward breakeven — and lean harder than usual on the AI research card's trajectory read.",
      filters: [
        { field: "drawdown_52w", op: ">=", value: 40 },
        { field: "drawdown_52w", op: "<=", value: 70 },
        { field: "above_low_26w", op: ">=", value: 10 },
        { field: "ps_vs_median", op: "<=", value: 0 },
      ],
      // The washout metrics are FILTERS; the cross-sectional weight sits on
      // the inflection lens (spec: cheapness alone just finds value traps).
      weights: { quality: 15, value: 20, momentum: 5, inflection: 60 },
      // Heavier AI authority: the research card is doing exactly the "is
      // something actually changing at this company" work here.
      aiBudget: 1.2,
    },
  },
};

export const DEFAULT_PRESET = "quality-growth";

export function presetConfig(id: string): ScreenConfig {
  const p = PRESETS[id] ?? PRESETS[DEFAULT_PRESET];
  return screenConfigSchema.parse({ ...p.config, preset: p.id });
}

// ---- URL <-> config (brief §4: config lives in the URL) -------------------
//
// Canonical form is a single compact `config` param (base64url JSON) so an
// arbitrary custom screen round-trips losslessly and shareably. A bare
// `?preset=` or `?sector=` shortcut yields the clean, indexable URLs.

// UTF-8 safe base64url. NOTE: `btoa`/`atob` only handle Latin1, so they THROW
// (InvalidCharacterError) on any non-ASCII char — and a brief routinely
// contains an em-dash, "≤", curly quotes, etc. Use Buffer on the server (UTF-8
// native) and TextEncoder/TextDecoder on the browser.
export function b64urlEncode(s: string): string {
  let b: string;
  if (typeof Buffer !== "undefined") {
    b = Buffer.from(s, "utf8").toString("base64");
  } else {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const byte of bytes) bin += String.fromCharCode(byte);
    b = btoa(bin);
  }
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof Buffer !== "undefined") {
    return Buffer.from(b, "base64").toString("utf8");
  }
  const bin = atob(b);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeConfig(config: ScreenConfig): string {
  return b64urlEncode(JSON.stringify(config));
}

/** Resolve a config from URL search params (config param > preset > sector). */
export function configFromParams(params: {
  config?: string;
  preset?: string;
  sector?: string;
}): ScreenConfig {
  if (params.config) {
    try {
      return screenConfigSchema.parse(JSON.parse(b64urlDecode(params.config)));
    } catch {
      // fall through to preset/default on a malformed param
    }
  }
  const cfg = presetConfig(params.preset ?? DEFAULT_PRESET);
  if (params.sector) {
    cfg.filters = [
      ...cfg.filters.filter((f) => f.field !== "sector"),
      { field: "sector", op: "==", value: params.sector },
    ];
    cfg.preset = "custom";
  }
  return cfg;
}

/** True when the config is an unmodified house preset (drives index policy). */
export function isHousePreset(config: ScreenConfig): boolean {
  if (!config.preset || config.preset === "custom") return false;
  const p = PRESETS[config.preset];
  if (!p) return false;
  const a = screenConfigSchema.parse({ ...p.config, preset: p.id });
  return JSON.stringify({ ...a, brief: undefined }) === JSON.stringify({ ...config, brief: undefined });
}

// ---- Friendly filters (screener UX follow-up §3) --------------------------
//
// A filter is presented as a readable chip with the operator IMPLIED by the
// metric — P/S / price are "at most" (≤), growth / margins / R40 / return are
// "at least" (≥). Tapping a chip reveals a slider over the metric's range. The
// raw field+op+value editor stays available under "advanced".

export interface MetricMeta {
  field: FilterField;
  label: string; // friendly name, e.g. "Revenue growth"
  unit: "%" | "×" | "$" | "pp" | "q" | "";
  op: FilterOp; // implied operator
  min: number;
  max: number;
  step: number;
  default: number;
}

// Numeric metrics only — text fields (sector/country) get a different control.
export const METRIC_META: Record<string, MetricMeta> = {
  ps: { field: "ps", label: "P/S", unit: "×", op: "<=", min: 0, max: 30, step: 0.5, default: 15 },
  rev_growth_ttm: { field: "rev_growth_ttm", label: "Revenue growth", unit: "%", op: ">=", min: 0, max: 100, step: 5, default: 20 },
  gross_margin: { field: "gross_margin", label: "Gross margin", unit: "%", op: ">=", min: 0, max: 100, step: 5, default: 60 },
  fcf_margin: { field: "fcf_margin", label: "FCF margin", unit: "%", op: ">=", min: -20, max: 60, step: 5, default: 10 },
  net_margin: { field: "net_margin", label: "Net margin", unit: "%", op: ">=", min: -40, max: 60, step: 5, default: 0 },
  operating_margin: { field: "operating_margin", label: "Operating margin", unit: "%", op: ">=", min: -40, max: 60, step: 5, default: 0 },
  rule_of_40: { field: "rule_of_40", label: "Rule of 40", unit: "", op: ">=", min: 0, max: 120, step: 5, default: 40 },
  ret_52w: { field: "ret_52w", label: "52-week return", unit: "%", op: ">=", min: -50, max: 150, step: 10, default: 0 },
  perf_52w_vs_spy: { field: "perf_52w_vs_spy", label: "vs SPY (52w)", unit: "%", op: ">=", min: -50, max: 100, step: 5, default: 0 },
  price: { field: "price", label: "Price", unit: "$", op: ">=", min: 0, max: 500, step: 5, default: 5 },
  // Turnaround facts (migration 074).
  drawdown_52w: { field: "drawdown_52w", label: "% off 52-week high", unit: "%", op: ">=", min: 0, max: 90, step: 5, default: 40 },
  above_low_26w: { field: "above_low_26w", label: "% above 6-month low", unit: "%", op: ">=", min: 0, max: 100, step: 5, default: 10 },
  ps_vs_median: { field: "ps_vs_median", label: "P/S vs own median", unit: "%", op: "<=", min: -80, max: 100, step: 5, default: 0 },
  inflection_signals: { field: "inflection_signals", label: "Inflection signals", unit: "", op: ">=", min: 0, max: 3, step: 1, default: 1 },
  net_debt_ebitda: { field: "net_debt_ebitda", label: "Net debt / EBITDA", unit: "×", op: "<=", min: -2, max: 10, step: 0.5, default: 3 },
  interest_coverage: { field: "interest_coverage", label: "Interest coverage", unit: "×", op: ">=", min: 0, max: 20, step: 1, default: 2 },
  // Series-only fields (migration 075) — only meaningful WITH a transform;
  // the meta gives them a friendly label + a scale for %-based transforms.
  rev_growth_qoq: { field: "rev_growth_qoq", label: "Rev growth (QoQ)", unit: "%", op: ">=", min: -50, max: 100, step: 5, default: 0 },
};

// ---- filter transforms (migration 075) -------------------------------------
// A transform re-reads the metric over its stored quarterly series (streaks /
// deltas / trends / own-history percentile) instead of its latest scalar —
// see web/lib/screen/transforms.ts (mirrored in screen.py).

/** Chip wording per transform, composed with the metric's label. */
export const TRANSFORM_LABELS: Record<Transform, (metric: string) => string> = {
  delta_qoq: (m) => `${m} Δ QoQ`,
  yoy: (m) => `${m} Δ YoY`,
  streak_qtrs: (m) => `${m} improving streak`,
  slope_4q: (m) => `${m} trend (4q slope)`,
  mean_4q: (m) => `${m} avg (4q)`,
  min_4q: (m) => `${m} min (4q)`,
  max_4q: (m) => `${m} max (4q)`,
  range_4q: (m) => `${m} range (4q)`,
  pctile_own: (m) => `${m} vs own history`,
};

// Sensible starting op + value when a transform filter is created.
const TRANSFORM_SEEDS: Record<Transform, { op: FilterOp; value: number }> = {
  delta_qoq: { op: ">", value: 0 },
  yoy: { op: ">", value: 0 },
  streak_qtrs: { op: ">=", value: 2 },
  slope_4q: { op: ">", value: 0 },
  mean_4q: { op: ">=", value: 0 },
  min_4q: { op: ">=", value: 0 },
  max_4q: { op: ">=", value: 0 },
  range_4q: { op: "<=", value: 10 },
  pctile_own: { op: "<=", value: 20 },
};

/**
 * Chip metadata for a filter, transform-aware: streaks count quarters,
 * pctile_own is 0–100, the delta/trend family reads in pp for %-based
 * metrics. Dollar-scale transforms (e.g. revenue Δ) get no slider —
 * undefined, same as any unknown field (the advanced editor still works).
 */
export function metaForFilter(f: Filter): MetricMeta | undefined {
  const base = METRIC_META[f.field];
  if (!f.transform) return base;
  const label = TRANSFORM_LABELS[f.transform](base?.label ?? f.field);
  const seed = TRANSFORM_SEEDS[f.transform];
  const pctBased = base?.unit === "%";
  switch (f.transform) {
    case "streak_qtrs":
      return { field: f.field, label, unit: "q", op: seed.op, min: 0, max: 8, step: 1, default: seed.value };
    case "pctile_own":
      return { field: f.field, label, unit: "%", op: seed.op, min: 0, max: 100, step: 5, default: seed.value };
    case "slope_4q":
      return pctBased
        ? { field: f.field, label, unit: "pp", op: seed.op, min: -10, max: 10, step: 0.5, default: seed.value }
        : undefined;
    case "delta_qoq":
    case "yoy":
      return pctBased
        ? { field: f.field, label, unit: "pp", op: seed.op, min: -30, max: 30, step: 1, default: seed.value }
        : undefined;
    case "range_4q":
      return pctBased
        ? { field: f.field, label, unit: "pp", op: seed.op, min: 0, max: 30, step: 1, default: seed.value }
        : undefined;
    case "mean_4q":
    case "min_4q":
    case "max_4q":
      return base ? { ...base, label, op: seed.op, default: seed.value } : undefined;
  }
}

/** The natural operator for a metric (implied — no operator dropdown). */
export function impliedOp(field: FilterField): FilterOp {
  return METRIC_META[field]?.op ?? ">=";
}

/** A readable chip label for a filter, e.g. "P/S ≤ 15" / "Rev growth ≥ 20%" /
 *  "Rev growth (QoQ) improving streak ≥ 2q". */
export function filterChipLabel(f: Filter): string {
  if (TEXT_FIELDS.has(f.field)) {
    if ((f.field === "sector" || f.field === "industry") && !String(f.value))
      return `any ${f.field}`;
    const verb = f.op === "!=" ? "exclude" : "only";
    return `${verb} ${f.value}`;
  }
  const m = metaForFilter(f);
  const sym = f.op === "<=" || f.op === "<" ? "≤" : f.op === ">=" || f.op === ">" ? "≥" : f.op;
  const label =
    m?.label ??
    (f.transform
      ? TRANSFORM_LABELS[f.transform](METRIC_META[f.field]?.label ?? f.field)
      : f.field);
  const unit = m?.unit ?? "";
  return `${label} ${sym} ${f.value}${unit}`;
}

// The "+ add filter" menu — named, friendly filters (not a blank field/op/value
// row). Each seeds a chip with its implied operator + default value. Entries
// with a `transform` are curated time-series filters (migration 075); the full
// metric × transform space stays reachable via the Advanced editor.
export const NAMED_FILTERS: {
  field: FilterField;
  label: string;
  transform?: Transform;
}[] = [
  { field: "sector", label: "Sector" },
  { field: "industry", label: "Industry" },
  { field: "ps", label: "P/S multiple" },
  { field: "rev_growth_ttm", label: "Revenue growth" },
  { field: "gross_margin", label: "Gross margin" },
  { field: "fcf_margin", label: "FCF margin" },
  { field: "rule_of_40", label: "Rule of 40" },
  { field: "ret_52w", label: "52-week return" },
  { field: "perf_52w_vs_spy", label: "Performance vs SPY" },
  { field: "net_margin", label: "Net margin" },
  { field: "operating_margin", label: "Operating margin" },
  { field: "price", label: "Share price" },
  // Turnaround facts (migration 074).
  { field: "drawdown_52w", label: "% off 52-week high" },
  { field: "above_low_26w", label: "% above 6-month low" },
  { field: "ps_vs_median", label: "P/S vs own median" },
  { field: "inflection_signals", label: "Inflection signals" },
  { field: "net_debt_ebitda", label: "Net debt / EBITDA" },
  { field: "interest_coverage", label: "Interest coverage" },
  // Curated transform filters (migration 075).
  { field: "rev_growth_qoq", transform: "streak_qtrs", label: "Rev growth improving" },
  { field: "gross_margin", transform: "streak_qtrs", label: "Gross margin expanding" },
  { field: "fcf_margin", transform: "slope_4q", label: "FCF margin trend" },
  { field: "revenue", transform: "streak_qtrs", label: "Revenue up in a row" },
];

/** Build a default filter for a metric (optionally over a transform), ready to
 *  drop into the bar as a chip. */
export function newFilterFor(field: FilterField, transform?: Transform): Filter {
  // Sector reads as "only <sector>"; other text fields default to "exclude".
  if (field === "sector") return { field, op: "==", value: "" };
  if (TEXT_FIELDS.has(field)) return { field, op: "!=", value: "" };
  if (transform) {
    const seed = TRANSFORM_SEEDS[transform];
    return { field, op: seed.op, value: seed.value, transform };
  }
  const m = METRIC_META[field];
  return { field, op: impliedOp(field), value: m?.default ?? 0 };
}
