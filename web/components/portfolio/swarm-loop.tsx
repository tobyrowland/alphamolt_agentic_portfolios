import type { CSSProperties, ReactNode } from "react";

/**
 * "How your swarm works" — the orientation graphic at the top of a portfolio
 * page (swarm graphic brief). It explains the unique mechanic: how this
 * portfolio turns screen candidates into a managed book and recycles cash.
 *
 * The honest model is a *loop*, not a line, with exactly two agent roles:
 *
 *   Top N candidates → BUYERS (draft, snake order) → YOUR BOOK
 *                          ↑                              │
 *                          └──────── cash recycles ───────┘ ← REVIEWERS (sell)
 *
 * Only buyers + reviewers are agents; candidates are the input (from this
 * portfolio's screen — referenced, not configured here) and the book is the
 * state. No extra invented stages, no "screen" node.
 *
 * Static by default; it orients, it doesn't configure. Optional live counts
 * are baked into the labels when cheap. Nodes deep-link within the page
 * (buyers/reviewers → the roster, book → holdings) — links only.
 */
export interface SwarmLoopProps {
  /** Number of buyer-role members; suffixes the BUYERS label when > 0. */
  buyers?: number;
  /** Number of reviewer-role members; suffixes the REVIEWERS label when > 0. */
  reviewers?: number;
  /** Current holdings count; suffixes the BOOK label when > 0. */
  bookCount?: number;
  /** Candidate pool size (the screen's top N). */
  candidates: number;
  /** On-page anchor for the buyers/reviewers nodes (the roster). */
  rosterHref?: string;
  /** On-page anchor for the book node (the holdings). */
  holdingsHref?: string;
}

// Brand tokens (theme vars) → translucent fills for the node cards. color-mix
// keeps everything driven by the design system rather than hard-coded rgba.
const tint = (v: string, pct: number) =>
  `color-mix(in srgb, ${v} ${pct}%, transparent)`;

const ROLES = {
  candidates: { color: "var(--color-text-muted)", border: "var(--color-border-light)" },
  buyers: { color: "var(--color-green)", border: tint("var(--color-green)", 50) },
  book: { color: "var(--color-cyan)", border: tint("var(--color-cyan)", 50) },
  reviewers: { color: "var(--color-red)", border: tint("var(--color-red)", 50) },
} as const;

const ARROW = "var(--color-text-muted)";

function withCount(label: string, n?: number): string {
  return n && n > 0 ? `${label} · ${n}` : label;
}

export default function SwarmLoop({
  buyers,
  reviewers,
  bookCount,
  candidates,
  rosterHref = "#roster",
  holdingsHref = "#holdings",
}: SwarmLoopProps) {
  const buyersLabel = withCount("BUYERS", buyers);
  const reviewersLabel = withCount("REVIEWERS", reviewers);
  const bookLabel = withCount("YOUR BOOK", bookCount);

  return (
    <section className="mb-12 sm:mb-14">
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
        How your swarm works
      </h2>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
        {/* One accessible text equivalent for both visual variants. */}
        <p className="sr-only">
          Your portfolio runs a loop. The top {candidates} candidates from your
          screen flow to your buyers, who draft them by conviction in snake
          order; that builds your book of holdings, marked to market daily; your
          reviewers sell on a broken thesis; the freed-up cash recycles back to
          the buyers.
        </p>

        {/* Desktop / tablet: horizontal SVG loop. */}
        <SvgLoop
          aria-hidden
          className="hidden sm:block"
          candidates={candidates}
          buyersLabel={buyersLabel}
          bookLabel={bookLabel}
          reviewersLabel={reviewersLabel}
          rosterHref={rosterHref}
          holdingsHref={holdingsHref}
        />

        {/* Mobile: vertical stack with the recycle note. */}
        <div aria-hidden className="sm:hidden flex flex-col items-stretch gap-0">
          <Node role="candidates" title={`TOP ${candidates}`} sub="from your screen" />
          <Down />
          <Node role="buyers" title={buyersLabel} sub="draft · snake order" href={rosterHref} />
          <Down />
          <Node role="book" title={bookLabel} sub="holdings, marked daily" href={holdingsHref} />
          <Down />
          <Node role="reviewers" title={reviewersLabel} sub="sell broken theses" href={rosterHref} />
          <div className="mt-2.5 flex items-center gap-2 text-[10px] font-mono text-text-muted">
            <span
              aria-hidden
              className="inline-block h-px flex-1"
              style={{ background: tint(ARROW, 60), borderTop: `1px dashed ${ARROW}` }}
            />
            ↺ cash recycles to buyers
            <span
              aria-hidden
              className="inline-block h-px flex-1"
              style={{ background: tint(ARROW, 60), borderTop: `1px dashed ${ARROW}` }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

// ----- Mobile node card ----------------------------------------------------

function Node({
  role,
  title,
  sub,
  href,
}: {
  role: keyof typeof ROLES;
  title: string;
  sub: string;
  href?: string;
}) {
  const { color, border } = ROLES[role];
  const style: CSSProperties = {
    borderColor: border,
    background: role === "candidates" ? "transparent" : tint(color, 6),
  };
  const inner = (
    <>
      <span className="font-mono text-[12px] font-medium" style={{ color }}>
        {title}
      </span>
      <span className="font-mono text-[10px] text-text-muted">{sub}</span>
    </>
  );
  const cls =
    "flex flex-col items-center gap-0.5 rounded-xl border px-4 py-3 text-center";
  return href ? (
    <a href={href} className={`${cls} transition-colors hover:brightness-110`} style={style}>
      {inner}
    </a>
  ) : (
    <div className={cls} style={style}>
      {inner}
    </div>
  );
}

function Down() {
  return (
    <div className="flex justify-center py-1.5 text-text-muted" aria-hidden>
      <span className="text-sm leading-none">↓</span>
    </div>
  );
}

// ----- Desktop SVG loop ----------------------------------------------------

function SvgLoop({
  candidates,
  buyersLabel,
  bookLabel,
  reviewersLabel,
  rosterHref,
  holdingsHref,
  className,
  ...rest
}: {
  candidates: number;
  buyersLabel: string;
  bookLabel: string;
  reviewersLabel: string;
  rosterHref: string;
  holdingsHref: string;
  className?: string;
} & React.SVGProps<SVGSVGElement>) {
  const mono = "var(--font-mono, 'JetBrains Mono', monospace)";
  return (
    <svg
      viewBox="0 0 720 172"
      className={`w-full h-auto ${className ?? ""}`}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <defs>
        <marker id="swarm-ah" markerWidth="8" markerHeight="8" refX="5.5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill={ARROW} />
        </marker>
      </defs>

      {/* IN: candidates (input, not a node to configure) */}
      <SvgNode x={18} y={40} w={120} h={52} role="candidates" mono={mono}
        title={`TOP ${candidates}`} sub="from your screen" />

      {/* BUYERS → roster */}
      <a href={rosterHref} aria-label="Buyers — jump to the roster">
        <SvgNode x={192} y={40} w={140} h={52} role="buyers" mono={mono}
          title={buyersLabel} sub="draft · snake order" />
      </a>

      {/* BOOK → holdings */}
      <a href={holdingsHref} aria-label="Your book — jump to holdings">
        <SvgNode x={384} y={34} w={136} h={64} role="book" mono={mono}
          title={bookLabel} sub="holdings, marked daily" />
      </a>

      {/* REVIEWERS → roster */}
      <a href={rosterHref} aria-label="Reviewers — jump to the roster">
        <SvgNode x={572} y={40} w={130} h={52} role="reviewers" mono={mono}
          title={reviewersLabel} sub="sell broken theses" />
      </a>

      {/* forward arrows */}
      <path d="M138,66 L188,66" stroke={ARROW} strokeWidth="1.4" fill="none" markerEnd="url(#swarm-ah)" />
      <path d="M332,66 L380,66" stroke={ARROW} strokeWidth="1.4" fill="none" markerEnd="url(#swarm-ah)" />
      <path d="M520,66 L568,66" stroke={ARROW} strokeWidth="1.4" fill="none" markerEnd="url(#swarm-ah)" />

      {/* return loop: reviewers → buyers (cash recycles) */}
      <path d="M637,94 L637,146 L262,146 L262,96" stroke={ARROW} strokeWidth="1.3"
        strokeDasharray="4 4" fill="none" markerEnd="url(#swarm-ah)" />
      <rect x="406" y="137" width="88" height="16" rx="4" fill="var(--color-bg)" />
      <text x="450" y="149" textAnchor="middle" fontFamily={mono} fontSize="9.5" fill={ARROW}>
        cash recycles
      </text>
    </svg>
  );
}

function SvgNode({
  x,
  y,
  w,
  h,
  role,
  title,
  sub,
  mono,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  role: keyof typeof ROLES;
  title: string;
  sub: string;
  mono: string;
}): ReactNode {
  const { color, border } = ROLES[role];
  const cx = x + w / 2;
  const fill = role === "candidates" ? "var(--color-bg-card)" : tint(color, 6);
  const titleColor = role === "candidates" ? "var(--color-text-muted)" : color;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} style={{ fill, stroke: border }} />
      <text x={cx} y={y + 24} textAnchor="middle" fontFamily={mono} fontSize="12" style={{ fill: titleColor }}>
        {title}
      </text>
      <text x={cx} y={y + 40} textAnchor="middle" fontFamily={mono} fontSize="9.5" fill="var(--color-text-muted)">
        {sub}
      </text>
    </g>
  );
}
