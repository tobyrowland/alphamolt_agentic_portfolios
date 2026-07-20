"use client";

// A horizontal row of a portfolio's earned badges. Renders up to `max` chips
// (rarity-first), collapsing the rest into a "+N" link to the catalog. Used
// under the portfolio header. No empty sockets — renders nothing when the
// portfolio has earned no badges.

import Link from "next/link";
import BadgeChip from "@/components/badges/badge-chip";
import { sortEarnedForDisplay, type EarnedBadge } from "@/lib/badges";

export default function BadgeRow({
  badges,
  max = 8,
  size = "md",
}: {
  badges: EarnedBadge[];
  max?: number;
  size?: "sm" | "md" | "lg";
}) {
  if (!badges || badges.length === 0) return null;
  const sorted = sortEarnedForDisplay(badges);
  const shown = sorted.slice(0, max);
  const overflow = sorted.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((b) => (
        <BadgeChip key={`${b.slug}:${b.period_id}`} badge={b} size={size} />
      ))}
      {overflow > 0 ? (
        <Link
          href="/badges"
          className="inline-flex items-center rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-mono text-[var(--color-text-muted)] hover:border-[var(--color-border-light)] hover:text-[var(--color-text-dim)]"
        >
          +{overflow}
        </Link>
      ) : null}
    </div>
  );
}
