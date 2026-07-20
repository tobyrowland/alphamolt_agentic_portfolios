// Presentational badge medallion — the rarity-styled emoji disc. No hooks, no
// server-only deps, so it renders in both server components (catalog cards) and
// client components (the hover chip). Pure styling driven by category (colour
// track) + rarity (border/glow).

import { badgeVisual, type BadgeCategory, type BadgeRarity } from "@/lib/badges";

const SIZES: Record<string, { box: number; font: number }> = {
  sm: { box: 26, font: 14 },
  md: { box: 34, font: 18 },
  lg: { box: 56, font: 30 },
};

export default function BadgeMedallion({
  icon,
  category,
  rarity,
  size = "md",
  dimmed = false,
}: {
  icon: string;
  category: BadgeCategory;
  rarity: BadgeRarity;
  size?: "sm" | "md" | "lg";
  dimmed?: boolean;
}) {
  const v = badgeVisual(category, rarity);
  const s = SIZES[size] ?? SIZES.md;
  return (
    <span
      aria-hidden="true"
      style={{
        width: s.box,
        height: s.box,
        fontSize: s.font,
        borderColor: dimmed ? "var(--color-border)" : v.borderColor,
        background: dimmed ? "transparent" : v.background,
        boxShadow: dimmed ? "none" : v.boxShadow,
        opacity: dimmed ? 0.45 : 1,
        filter: dimmed ? "grayscale(1)" : "none",
      }}
      className="inline-flex shrink-0 items-center justify-center rounded-full border leading-none"
    >
      {icon}
    </span>
  );
}
