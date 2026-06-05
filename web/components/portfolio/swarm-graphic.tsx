import type { CSSProperties, ReactNode } from "react";

/**
 * The portfolio page's single top graphic (portfolio top-graphic brief). It
 * mirrors the screener's signpost with the "you are here" marker flipped onto
 * the portfolio, and folds the swarm loop *inside* the lit portfolio node:
 *
 *   [ SCREEN ] —top N→ [ THIS PORTFOLIO ● you are here:
 *                          BUYERS → YOUR BOOK → REVIEWERS ↺ cash recycles ]
 *
 * One graphic, two jobs: cross-page wayfinding (same map as the screener, the
 * cyan current-location marker moved to the portfolio) AND the internal swarm
 * mechanic (the loop, now living inside the node you're standing in).
 *
 * Honest model: only buyers + reviewers are agents; the top N is the input
 * (never its own node), the book is the state, and the SCREEN is an upstream
 * link — configured on /screener, not here. It orients; it doesn't configure.
 */
export interface SwarmGraphicProps {
  /** Number of buyer-role members; suffixes the BUYERS label when > 0. */
  buyers?: number;
  /** Number of reviewer-role members; suffixes the REVIEWERS label when > 0. */
  reviewers?: number;
  /** Current holdings count; suffixes the BOOK label when > 0. */
  bookCount?: number;
  /** Candidate pool size (the screen's top N) riding the bridge. */
  candidates: number;
  /** Upstream link to this portfolio's screen (the SCREEN node). */
  screenHref?: string;
  /** On-page anchor for the buyers/reviewers nodes (the roster). */
  rosterHref?: string;
  /** On-page anchor for the book node (the holdings). */
  holdingsHref?: string;
}

// Brand tokens (theme vars) → translucent fills. color-mix keeps everything
// driven by the design system rather than hard-coded rgba.
const tint = (v: string, pct: number) =>
  `color-mix(in srgb, ${v} ${pct}%, transparent)`;

const GREEN = "var(--color-green)";
const CYAN = "var(--color-cyan)";
const RED = "var(--color-red)";
const MUTED = "var(--color-text-muted)";
// A dimmer grey for arrows/borders so they recede behind the lit node.
const DIM = "color-mix(in srgb, var(--color-text-muted) 65%, var(--color-bg))";

const ROLES = {
  buyers: { color: GREEN, border: tint(GREEN, 50) },
  book: { color: CYAN, border: tint(CYAN, 45) },
  reviewers: { color: RED, border: tint(RED, 50) },
} as const;

function withCount(label: string, n?: number): string {
  return n && n > 0 ? `${label} · ${n}` : label;
}

export default function SwarmGraphic({
  buyers,
  reviewers,
  bookCount,
  candidates,
  screenHref = "/screener",
  rosterHref = "#roster",
  holdingsHref = "#holdings",
}: SwarmGraphicProps) {
  const buyersLabel = withCount("BUYERS", buyers);
  const reviewersLabel = withCount("REVIEWERS", reviewers);
  const bookLabel = withCount("YOUR BOOK", bookCount);

  return (
    <section className="mb-12 sm:mb-14">
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
        How this works
      </h2>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
        {/* One accessible text equivalent for both visual variants. */}
        <p className="sr-only">
          The screen ranks your universe; its top {candidates} flow into this
          portfolio, where you are. Inside, buyers draft by conviction in snake
          order to build your book of holdings, reviewers sell on a broken
          thesis, and the freed-up cash recycles back to the buyers. Edit the
          screen on the screener page.
        </p>

        {/* Desktop / tablet: horizontal mirrored bridge. */}
        <SvgGraphic
          aria-hidden
          className="hidden sm:block"
          candidates={candidates}
          buyersLabel={buyersLabel}
          bookLabel={bookLabel}
          reviewersLabel={reviewersLabel}
          screenHref={screenHref}
          rosterHref={rosterHref}
          holdingsHref={holdingsHref}
        />

        {/* Mobile: stack Screen → top N → Portfolio (inner loop stacked). */}
        <div aria-hidden className="sm:hidden">
          <a
            href={screenHref}
            className="flex flex-col items-center gap-0.5 rounded-xl border px-4 py-3 text-center transition-colors hover:brightness-110"
            style={{ borderColor: DIM }}
          >
            <span className="font-mono text-[12px] font-medium text-text-muted">
              SCREEN
            </span>
            <span className="font-mono text-[10px]" style={{ color: CYAN }}>
              ← edit your screen
            </span>
          </a>
          <Down label={`top ${candidates}`} />
          <div
            className="rounded-2xl border p-3"
            style={{ borderColor: tint(CYAN, 50), background: tint(CYAN, 5) }}
          >
            <div className="mb-2.5 flex items-baseline justify-between gap-2 px-0.5">
              <span className="font-mono text-[11px]" style={{ color: CYAN }}>
                ● THIS PORTFOLIO
              </span>
              <span className="font-mono text-[9px] tracking-[0.12em] text-text-muted">
                YOU ARE HERE
              </span>
            </div>
            <Node role="buyers" title={buyersLabel} sub="draft · snake" href={rosterHref} />
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
  const style: CSSProperties = { borderColor: border, background: tint(color, 6) };
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

function Down({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-1.5 text-text-muted" aria-hidden>
      {label && <span className="font-mono text-[9.5px] mb-0.5 text-text-muted">{label}</span>}
      <span className="text-sm leading-none">↓</span>
    </div>
  );
}

// ----- Desktop SVG ---------------------------------------------------------

function SvgGraphic({
  candidates,
  buyersLabel,
  bookLabel,
  reviewersLabel,
  screenHref,
  rosterHref,
  holdingsHref,
  className,
  ...rest
}: {
  candidates: number;
  buyersLabel: string;
  bookLabel: string;
  reviewersLabel: string;
  screenHref: string;
  rosterHref: string;
  holdingsHref: string;
  className?: string;
} & React.SVGProps<SVGSVGElement>) {
  const mono = "var(--font-mono, 'JetBrains Mono', monospace)";
  return (
    <svg
      viewBox="0 0 760 200"
      className={`w-full h-auto ${className ?? ""}`}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <defs>
        <marker id="swarm-ah" markerWidth="8" markerHeight="8" refX="5.5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" style={{ fill: DIM }} />
        </marker>
        <marker id="swarm-ahc" markerWidth="8" markerHeight="8" refX="5.5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" style={{ fill: CYAN }} />
        </marker>
        <linearGradient id="swarm-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: MUTED }} />
          <stop offset="1" style={{ stopColor: CYAN }} />
        </linearGradient>
      </defs>

      {/* SCREEN — upstream, dimmed, links back to the screener. */}
      <a href={screenHref} aria-label="Edit your screen on the screener">
        <rect x={12} y={66} width={120} height={58} rx={10}
          style={{ fill: "var(--color-bg-card)", stroke: DIM }} />
        <text x={72} y={92} textAnchor="middle" fontFamily={mono} fontSize="12" fill={MUTED}>
          SCREEN
        </text>
        <text x={72} y={109} textAnchor="middle" fontFamily={mono} fontSize="9" style={{ fill: CYAN }}>
          ← edit your screen
        </text>
      </a>

      {/* bridge: top N rides the grey→cyan arrow into the lit node. */}
      <text x={176} y={86} textAnchor="middle" fontFamily={mono} fontSize="9.5" fill={MUTED}>
        top {candidates}
      </text>
      <path d="M132,95 L218,95" stroke="url(#swarm-grad)" strokeWidth="2.4" fill="none" markerEnd="url(#swarm-ahc)" />

      {/* THIS PORTFOLIO — the lit, current container holding the swarm engine. */}
      <rect x={198} y={12} width={550} height={176} rx={13} style={{ fill: tint(CYAN, 5), stroke: tint(CYAN, 50) }} />
      <text x={216} y={36} fontFamily={mono} fontSize="12" style={{ fill: CYAN }}>
        ● THIS PORTFOLIO
      </text>
      <text x={344} y={36} fontFamily={mono} fontSize="9" fill={MUTED} letterSpacing="0.5">
        YOU ARE HERE
      </text>

      {/* inner loop — centered within the container (24px inset each side). */}
      <a href={rosterHref} aria-label="Buyers — jump to the roster">
        <SvgNode x={222} y={70} w={132} h={50} role="buyers" mono={mono} title={buyersLabel} sub="draft · snake" />
      </a>
      <a href={holdingsHref} aria-label="Your book — jump to holdings">
        <SvgNode x={409} y={70} w={120} h={50} role="book" mono={mono} title={bookLabel} sub="holdings" solid />
      </a>
      <a href={rosterHref} aria-label="Reviewers — jump to the roster">
        <SvgNode x={584} y={70} w={140} h={50} role="reviewers" mono={mono} title={reviewersLabel} sub="sell broken theses" />
      </a>

      {/* inner forward arrows */}
      <path d="M356,95 L407,95" stroke={DIM} strokeWidth="1.4" fill="none" markerEnd="url(#swarm-ah)" />
      <path d="M531,95 L582,95" stroke={DIM} strokeWidth="1.4" fill="none" markerEnd="url(#swarm-ah)" />

      {/* recycle: reviewers → buyers */}
      <path d="M654,120 L654,158 L288,158 L288,122" stroke={DIM} strokeWidth="1.3" strokeDasharray="4 4" fill="none" markerEnd="url(#swarm-ah)" />
      <rect x={427} y={150} width={88} height={16} rx={4} style={{ fill: "var(--color-bg-card)" }} />
      <text x={471} y={162} textAnchor="middle" fontFamily={mono} fontSize="9" fill={MUTED}>
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
  solid = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  role: keyof typeof ROLES;
  title: string;
  sub: string;
  mono: string;
  solid?: boolean;
}): ReactNode {
  const { color, border } = ROLES[role];
  const cx = x + w / 2;
  const fill = solid ? "var(--color-bg-card)" : tint(color, 6);
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={9} style={{ fill, stroke: border }} />
      <text x={cx} y={y + 22} textAnchor="middle" fontFamily={mono} fontSize="11.5" style={{ fill: color }}>
        {title}
      </text>
      <text x={cx} y={y + 37} textAnchor="middle" fontFamily={mono} fontSize="9" fill={MUTED}>
        {sub}
      </text>
    </g>
  );
}
