// Shared, client-safe badge types + the rarity/category visual system.
// No server imports here — this file is imported by both server components
// (catalog page, portfolio page) and client components (badge chip, tooltip,
// leaderboard row).

export type BadgeCategory =
  | "alpha"
  | "process"
  | "honesty"
  | "swarm"
  | "competitive";

export type BadgeRarity = "common" | "uncommon" | "rare" | "legendary";

export interface Badge {
  id: number;
  slug: string;
  name: string;
  description: string;
  condition_text: string;
  category: BadgeCategory;
  rarity: BadgeRarity;
  icon: string;
  is_period: boolean;
  phase: number;
  sort_order: number;
}

// A badge a portfolio has actually earned (grant joined to catalog).
export interface EarnedBadge extends Badge {
  granted_at: string;
  period_id: string;
  context: Record<string, unknown>;
}

// A catalog entry decorated with its global earn-rate (for the /badges page).
export interface CatalogBadge extends Badge {
  grant_count: number;
  earn_rate: number; // fraction of eligible portfolios holding it, 0..1
}

// Rarity ordering — used to pick the "top 3 by rarity" on leaderboard rows.
export const RARITY_RANK: Record<BadgeRarity, number> = {
  legendary: 4,
  rare: 3,
  uncommon: 2,
  common: 1,
};

export const CATEGORY_LABEL: Record<BadgeCategory, string> = {
  alpha: "Alpha & Performance",
  process: "Process & Discipline",
  honesty: "Honesty & Losses",
  swarm: "Swarm & Mechanics",
  competitive: "Champions",
};

// Category display order on the catalog page.
export const CATEGORY_ORDER: BadgeCategory[] = [
  "alpha",
  "process",
  "honesty",
  "swarm",
  "competitive",
];

export const RARITY_LABEL: Record<BadgeRarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  legendary: "Legendary",
};

// Each category owns a prestige track colour. Performance is phosphor green;
// honesty/loss badges get amber so they read as their own distinct track
// (the brief's "we show the losses" ethos). Champions get gold.
interface Track {
  color: string; // CSS var reference
  rgb: string; // "r,g,b" for rgba() glows
}

const TRACKS: Record<BadgeCategory, Track> = {
  alpha: { color: "var(--color-green)", rgb: "0,255,65" },
  process: { color: "var(--color-cyan)", rgb: "0,242,255" },
  honesty: { color: "var(--color-orange)", rgb: "255,153,0" },
  swarm: { color: "var(--color-cyan)", rgb: "0,242,255" },
  competitive: { color: "var(--color-yellow)", rgb: "255,215,0" },
};

// Rarity drives icon treatment (border + glow intensity).
const RARITY_GLOW: Record<BadgeRarity, { alpha: number; blur: number; border: number }> = {
  common: { alpha: 0, blur: 0, border: 0.18 },
  uncommon: { alpha: 0.25, blur: 6, border: 0.35 },
  rare: { alpha: 0.45, blur: 9, border: 0.55 },
  legendary: { alpha: 0.7, blur: 14, border: 0.8 },
};

export interface BadgeVisual {
  color: string;
  borderColor: string;
  background: string;
  boxShadow: string;
}

export function badgeVisual(
  category: BadgeCategory,
  rarity: BadgeRarity,
): BadgeVisual {
  const track = TRACKS[category] ?? TRACKS.process;
  const g = RARITY_GLOW[rarity] ?? RARITY_GLOW.common;
  return {
    color: track.color,
    borderColor: `rgba(${track.rgb},${g.border})`,
    background: `rgba(${track.rgb},0.06)`,
    boxShadow: g.alpha > 0 ? `0 0 ${g.blur}px rgba(${track.rgb},${g.alpha})` : "none",
  };
}

// The human-facing name of an earned badge — period badges render their dated
// label from grant context ("Champion — Jan 2026"); everything else uses the
// catalog name.
export function badgeDisplayName(b: {
  name: string;
  context?: Record<string, unknown> | null;
}): string {
  const label = b.context?.["label"];
  return typeof label === "string" && label ? label : b.name;
}

// Order a portfolio's earned badges for display: rarity desc, then most-recent.
export function sortEarnedForDisplay(badges: EarnedBadge[]): EarnedBadge[] {
  return [...badges].sort((a, b) => {
    const r = RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity];
    if (r !== 0) return r;
    return (b.granted_at || "").localeCompare(a.granted_at || "");
  });
}

// "Jul 12, 2026" from an ISO timestamp (UTC, locale-stable).
export function formatGrantedDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// A short line describing the triggering event of an earned badge, built from
// grant context (e.g. "NVDA · closed Feb 10, 2026 · −20.0%"). Empty when there
// is no position-level trigger (time-window badges).
export function describeTrigger(
  context: Record<string, unknown> | null | undefined,
): string {
  if (!context) return "";
  const parts: string[] = [];
  const ticker = context["ticker"];
  if (typeof ticker === "string" && ticker) parts.push(ticker);

  const closed = context["closed_at"];
  if (typeof closed === "string" && closed) {
    parts.push(`closed ${formatGrantedDate(closed)}`);
  }

  const pctKeys = [
    "loss_pct",
    "realized_return_pct",
    "cumulative_alpha_pct",
    "alpha_pct",
    "max_drawdown_pct",
  ];
  for (const k of pctKeys) {
    const v = context[k];
    if (typeof v === "number") {
      const sign = v > 0 ? "+" : v < 0 ? "−" : "";
      const abs = Math.abs(v).toFixed(1);
      parts.push(`${sign}${abs}%`);
      break;
    }
  }

  const dryDays = context["dry_days"];
  if (typeof dryDays === "number") parts.push(`${dryDays}d dry spell`);

  const streak = context["streak"];
  if (typeof streak === "number") parts.push(`${streak} in a row`);

  return parts.join(" · ");
}
