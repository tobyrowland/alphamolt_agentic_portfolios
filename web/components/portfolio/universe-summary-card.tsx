import Link from "next/link";
import {
  draftLine,
  selfSourcedLine,
  sizeLine,
  type UniverseSummary,
} from "@/lib/portfolio-universe";

/**
 * The public "what can this book even buy" strip on a portfolio page.
 *
 * A leaderboard row says how a swarm did; this says out of what. Deliberately
 * a summary and not the screen: label, pond size and draft depth, with the
 * filters and weights left to the owner-only Universe tab (and the owner-only
 * review pack), because a public leaderboard entry is not consent to
 * publishing a competitor's selection recipe.
 *
 * Rendered only when `showsUniverse` holds — see `@/lib/portfolio-universe`.
 */
export default function UniverseSummaryCard({
  summary,
  slug,
  isOwner,
}: {
  summary: UniverseSummary;
  slug: string;
  isOwner: boolean;
}) {
  const note = selfSourcedLine(summary);
  return (
    <section className="mb-6 sm:mb-8 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">
          Universe — what the buyers pick from
        </p>
        {isOwner && (
          <Link
            href={`/portfolios/${slug}/universe`}
            className="text-[11px] font-mono text-[var(--color-cyan)] hover:brightness-125 transition-[filter]"
          >
            Edit universe →
          </Link>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-lg sm:text-xl font-bold text-text">
          {summary.presetLabel}
        </span>
        <span className="font-mono text-[13px] tabular-nums text-text-muted">
          {sizeLine(summary)}
        </span>
      </div>

      <p className="mt-1 text-[11px] font-mono text-text-muted">
        {draftLine(summary)}
        {summary.asOf && (
          <>
            {" "}
            <span className="text-text-muted/70">Screen as of {summary.asOf}.</span>
          </>
        )}
      </p>

      {/* The correction: without it the card silently claims every position
          came through the screen. */}
      {note && (
        <p className="mt-1 text-[11px] font-mono text-text-dim">
          {note}
        </p>
      )}
    </section>
  );
}
