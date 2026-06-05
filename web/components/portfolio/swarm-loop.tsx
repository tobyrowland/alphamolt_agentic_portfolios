import type { CSSProperties, ReactNode } from "react";

/**
 * The swarm engine loop (portfolio top + swarm graphics brief). Placed as a
 * compact section *above the buyers/reviewers roster* — it answers "how the
 * swarm runs", shown where you configure it (not the page-top wayfinder).
 *
 *   TOP N (input) → BUYERS (draft, snake) → YOUR BOOK (state) → REVIEWERS
 *                       ↑                                            │
 *                       └──────────── cash recycles ─────────────────┘ (sell)
 *
 * Honest model: only buyers + reviewers are agents; the top N is the input
 * (from the screen), the book is the state. No extra stages, no screen node.
 */
export interface SwarmLoopProps {
  buyers?: number;
  reviewers?: number;
  bookCount?: number;
  candidates: number;
  rosterHref?: string;
  holdingsHref?: string;
  /** Outer wrapper classes; default spaces it as a standalone section. */
  className?: string;
}

const tint = (v: string, pct: number) =>
  `color-mix(in srgb, ${v} ${pct}%, transparent)`;

const GREEN = "var(--color-green)";
const CYAN = "var(--color-cyan)";
const RED = "var(--color-red)";
const MUTED = "var(--color-text-muted)";
const DIM = "color-mix(in srgb, var(--color-text-muted) 65%, var(--color-bg))";

const ROLES = {
  candidates: { color: MUTED, border: DIM },
  buyers: { color: GREEN, border: tint(GREEN, 50) },
  book: { color: CYAN, border: tint(CYAN, 50) },
  reviewers: { color: RED, border: tint(RED, 50) },
} as const;

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
  className = "mb-12 sm:mb-14",
}: SwarmLoopProps) {
  const buyersLabel = withCount("BUYERS", buyers);
  const reviewersLabel = withCount("REVIEWERS", reviewers);
  const bookLabel = withCount("YOUR BOOK", bookCount);

  return (
    <div className={className}>
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
        How your swarm works
      </h2>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
        <p className="sr-only">
          The top {candidates} candidates from your screen flow to your buyers,
          who draft them by conviction in snake order to build your book of
          holdings; reviewers sell on a broken thesis; the freed-up cash
          recycles back to the buyers.
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
        <div aria-hidden className="sm:hidden flex flex-col items-stretch">
          <Node role="candidates" title={`TOP ${candidates}`} sub="from your screen" />
          <Down />
          <Node role="buyers" title={buyersLabel} sub="draft · snake order" href={rosterHref} />
          <Down />
          <Node role="book" title={bookLabel} sub="holdings, marked daily" href={holdingsHref} />
          <Down />
          <Node role="reviewers" title={reviewersLabel} sub="sell broken theses" href={rosterHref} />
          <div className="mt-2.5 flex items-center gap-2 text-[10px] font-mono text-text-muted">
            <span aria-hidden className="inline-block h-px flex-1" style={{ borderTop: `1px dashed ${DIM}` }} />
            ↺ cash recycles to buyers
            <span aria-hidden className="inline-block h-px flex-1" style={{ borderTop: `1px dashed ${DIM}` }} />
          </div>
        </div>
      </div>
    </div>
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
    background: role === "candidates" ? "var(--color-bg-card)" : tint(color, 6),
  };
  const inner = (
    <>
      <span className="font-mono text-[12px] font-medium" style={{ color }}>
        {title}
      </span>
      <span className="font-mono text-[10px] text-text-muted">{sub}</span>
    </>
  );
  const cls = "flex flex-col items-center gap-0.5 rounded-xl border px-4 py-3 text-center";
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

// ----- Desktop SVG ---------------------------------------------------------

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
      viewBox="0 0 720 178"
      className={`w-full h-auto ${className ?? ""}`}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <defs>
        <marker id="loop-ah" markerWidth="8" markerHeight="8" refX="5.5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" style={{ fill: DIM }} />
        </marker>
      </defs>

      {/* TOP N — input (from the screen), not its own agent. */}
      <SvgNode x={18} y={40} w={120} h={52} role="candidates" mono={mono}
        title={`TOP ${candidates}`} sub="from your screen" />

      <a href={rosterHref} aria-label="Buyers — jump to the roster">
        <SvgNode x={192} y={40} w={140} h={52} role="buyers" mono={mono}
          title={buyersLabel} sub="draft · snake order" />
      </a>
      <a href={holdingsHref} aria-label="Your book — jump to holdings">
        <SvgNode x={384} y={34} w={136} h={64} role="book" mono={mono}
          title={bookLabel} sub="holdings, marked daily" />
      </a>
      <a href={rosterHref} aria-label="Reviewers — jump to the roster">
        <SvgNode x={572} y={40} w={128} h={52} role="reviewers" mono={mono}
          title={reviewersLabel} sub="sell broken theses" />
      </a>

      {/* forward arrows */}
      <path d="M138,66 L188,66" stroke={DIM} strokeWidth="1.4" fill="none" markerEnd="url(#loop-ah)" />
      <path d="M332,66 L380,66" stroke={DIM} strokeWidth="1.4" fill="none" markerEnd="url(#loop-ah)" />
      <path d="M520,66 L568,66" stroke={DIM} strokeWidth="1.4" fill="none" markerEnd="url(#loop-ah)" />

      {/* recycle: reviewers → buyers */}
      <path d="M636,94 L636,148 L262,148 L262,96" stroke={DIM} strokeWidth="1.3"
        strokeDasharray="4 4" fill="none" markerEnd="url(#loop-ah)" />
      <rect x={406} y={140} width={88} height={16} rx={4} style={{ fill: "var(--color-bg-card)" }} />
      <text x={450} y={152} textAnchor="middle" fontFamily={mono} fontSize="9.5" fill={MUTED}>
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
  const cy = y + h / 2;
  const fill = role === "candidates" ? "var(--color-bg-card)" : tint(color, 6);
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} style={{ fill, stroke: border }} />
      <text x={cx} y={cy - 2} textAnchor="middle" fontFamily={mono} fontSize="12" style={{ fill: color }}>
        {title}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontFamily={mono} fontSize="9.5" fill={MUTED}>
        {sub}
      </text>
    </g>
  );
}
