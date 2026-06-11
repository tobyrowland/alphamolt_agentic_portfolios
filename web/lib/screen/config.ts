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

// Fields a filter can target — these map 1:1 onto screen_facts() columns
// (migration 040). Numeric unless noted.
export const FILTER_FIELDS = [
  "sector", // text
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
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const TEXT_FIELDS = new Set<FilterField>(["sector", "country"]);

export const FILTER_OPS = ["<=", ">=", "<", ">", "==", "!="] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const filterSchema = z.object({
  field: z.enum(FILTER_FIELDS),
  op: z.enum(FILTER_OPS),
  value: z.union([z.number(), z.string()]),
});
export type Filter = z.infer<typeof filterSchema>;

export const weightsSchema = z.object({
  quality: z.number().min(0).max(100),
  value: z.number().min(0).max(100),
  momentum: z.number().min(0).max(100),
});
export type Weights = z.infer<typeof weightsSchema>;

export const screenConfigSchema = z.object({
  brief: z.string().max(2000).optional(),
  preset: z.string().optional(),
  filters: z.array(filterSchema).max(20).default([]),
  weights: weightsSchema.default({ quality: 45, value: 25, momentum: 20 }),
  aiMultiplier: z.boolean().default(true),
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
  aiMultiplier: true,
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
      weights: { quality: 60, value: 25, momentum: 15 },
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
      weights: { quality: 20, value: 60, momentum: 20 },
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
      weights: { quality: 25, value: 15, momentum: 60 },
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
      weights: { quality: 65, value: 20, momentum: 15 },
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
  unit: "%" | "×" | "$" | "";
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
};

/** The natural operator for a metric (implied — no operator dropdown). */
export function impliedOp(field: FilterField): FilterOp {
  return METRIC_META[field]?.op ?? ">=";
}

/** A readable chip label for a filter, e.g. "P/S ≤ 15" / "Rev growth ≥ 20%". */
export function filterChipLabel(f: Filter): string {
  if (TEXT_FIELDS.has(f.field)) {
    if (f.field === "sector" && !String(f.value)) return "any sector";
    const verb = f.op === "!=" ? "exclude" : "only";
    return `${verb} ${f.value}`;
  }
  const m = METRIC_META[f.field];
  const sym = f.op === "<=" || f.op === "<" ? "≤" : f.op === ">=" || f.op === ">" ? "≥" : f.op;
  const label = m?.label ?? f.field;
  const unit = m?.unit ?? "";
  return `${label} ${sym} ${f.value}${unit}`;
}

// The "+ add filter" menu — named, friendly filters (not a blank field/op/value
// row). Each seeds a chip with its implied operator + default value.
export const NAMED_FILTERS: { field: FilterField; label: string }[] = [
  { field: "sector", label: "Sector" },
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
];

/** Build a default filter for a metric, ready to drop into the bar as a chip. */
export function newFilterFor(field: FilterField): Filter {
  // Sector reads as "only <sector>"; other text fields default to "exclude".
  if (field === "sector") return { field, op: "==", value: "" };
  if (TEXT_FIELDS.has(field)) return { field, op: "!=", value: "" };
  const m = METRIC_META[field];
  return { field, op: impliedOp(field), value: m?.default ?? 0 };
}
