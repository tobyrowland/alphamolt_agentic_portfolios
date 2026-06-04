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
      "Durable compounders — Rule of 40, fat FCF and gross margins, valuation kept sane.",
    config: {
      ...base,
      filters: [{ field: "ps", op: "<=", value: 15 }],
      weights: { quality: 60, value: 25, momentum: 15 },
    },
  },
  "deep-value": {
    id: "deep-value",
    label: "Deep Value",
    description: "Cheap on sales relative to their own history; quality is secondary.",
    config: {
      ...base,
      filters: [{ field: "ps", op: "<=", value: 8 }],
      weights: { quality: 20, value: 60, momentum: 20 },
    },
  },
  momentum: {
    id: "momentum",
    label: "Momentum",
    description: "Leaders by trailing 52-week price strength, quality as a sanity check.",
    config: {
      ...base,
      filters: [],
      weights: { quality: 25, value: 15, momentum: 60 },
    },
  },
  "high-fcf": {
    id: "high-fcf",
    label: "High FCF",
    description: "Cash machines — free-cash-flow margin and Rule of 40 lead the score.",
    config: {
      ...base,
      filters: [{ field: "fcf_margin", op: ">=", value: 10 }],
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

function b64urlEncode(s: string): string {
  const b = typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64");
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return typeof atob === "function" ? atob(b) : Buffer.from(b, "base64").toString("utf8");
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
