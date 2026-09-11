import Link from "next/link";
import {
  draftLine,
  NO_FILTERS_LINE,
  rankingLine,
  selfSourcedLine,
  sizeLine,
  type UniverseSummary,
} from "@/lib/portfolio-universe";

/**
 * The public "what can this book even buy" strip on a portfolio page.
 *
 * A leaderboard row says how a swarm did; this says out of what — the whole
 * selection rule, in the order it runs: filter (the chips), rank (the lens
 * blend), take the top N. A label and a count alone proved not to be an
 * answer: "Quality Growth · 2,653 of 3,030 names pass" describes a screen that
 * narrows almost nothing, and reads as though it narrows a lot.
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

      <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-mono text-lg sm:text-xl font-bold text-text">
          {summary.presetLabel}
        </span>
        {/* A preset the owner has since edited. Saying so is the difference
            between naming the starting point and misnaming the screen. */}
        {summary.modified && (
          <span className="font-mono text-[11px] text-text-muted">edited</span>
        )}
        <span className="font-mono text-[13px] tabular-nums text-text-muted">
          {sizeLine(summary)}
        </span>
      </div>

      {/* Step 1 — the filters. A name failing any of these is never seen. */}
      {summary.filters.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {summary.filters.map((f) => (
            <li
              key={f}
              className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] text-text-dim"
            >
              {f}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] font-mono text-text-muted">
          {NO_FILTERS_LINE}
        </p>
      )}

      {/* Steps 2 and 3 — rank the survivors, offer the top N to the buyers. */}
      <p className="mt-2 text-[11px] font-mono text-text-muted">
        {rankingLine(summary)} {draftLine(summary)}
        {summary.asOf && (
          <>
            {" "}
            <span className="text-text-muted/70">Screen as of {summary.asOf}.</span>
          </>
        )}
      </p>

      {/* The correction: without it the strip silently claims every position
          came through the screen. */}
      {note && (
        <p className="mt-1 text-[11px] font-mono text-text-dim">{note}</p>
      )}
    </section>
  );
}
