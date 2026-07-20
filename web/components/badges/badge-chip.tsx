"use client";

// A single earned badge: the rarity-styled medallion + a hover/focus tooltip
// (name, description, date earned, triggering event) that links to the badge's
// catalog entry. Used on the portfolio header strip and leaderboard rows.

import Link from "next/link";
import BadgeMedallion from "@/components/badges/badge-medallion";
import {
  badgeDisplayName,
  describeTrigger,
  formatGrantedDate,
  RARITY_LABEL,
  type EarnedBadge,
} from "@/lib/badges";

export default function BadgeChip({
  badge,
  size = "md",
}: {
  badge: EarnedBadge;
  size?: "sm" | "md" | "lg";
}) {
  const name = badgeDisplayName(badge);
  const trigger = describeTrigger(badge.context);
  const earned = formatGrantedDate(badge.granted_at);

  return (
    <span className="group relative inline-flex">
      <Link
        href={`/badges#${badge.slug}`}
        aria-label={`${name} — ${RARITY_LABEL[badge.rarity]} badge`}
        className="inline-flex focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)] rounded-full"
      >
        <BadgeMedallion
          icon={badge.icon}
          category={badge.category}
          rarity={badge.rarity}
          size={size}
        />
      </Link>

      {/* Tooltip — appears on hover/focus of the group. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-60 -translate-x-1/2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-bg-card)] p-3 text-left shadow-xl group-hover:block group-focus-within:block"
      >
        <span className="flex items-center gap-2">
          <BadgeMedallion
            icon={badge.icon}
            category={badge.category}
            rarity={badge.rarity}
            size="sm"
          />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-bold text-[var(--color-text)]">
              {name}
            </span>
            <span className="block text-[10px] font-mono uppercase tracking-wider text-[var(--color-text-muted)]">
              {RARITY_LABEL[badge.rarity]}
            </span>
          </span>
        </span>
        <span className="mt-2 block text-[11px] leading-snug text-[var(--color-text-dim)]">
          {badge.description}
        </span>
        {trigger ? (
          <span className="mt-1.5 block font-mono text-[10px] text-[var(--color-text-muted)]">
            {trigger}
          </span>
        ) : null}
        {earned ? (
          <span className="mt-1.5 block text-[10px] text-[var(--color-text-muted)]">
            Earned {earned}
          </span>
        ) : null}
      </span>
    </span>
  );
}
