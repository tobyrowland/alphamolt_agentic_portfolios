/**
 * Portfolio page-top signpost (portfolio top + swarm graphics brief). A slim,
 * balanced two-node bridge that mirrors the screener's top signpost with the
 * "you are here" marker flipped onto the portfolio:
 *
 *   [ SCREEN ]  —top N→  [ THIS PORTFOLIO ● you are here ]
 *
 * Pure wayfinding — equal nodes, no nested loop (the swarm engine loop lives
 * lower, above the roster). Cyan = current location; SCREEN is dimmed/upstream
 * and links to the portfolio's screen. It orients; it doesn't configure.
 */
export interface PortfolioSignpostProps {
  /** Candidate pool size (the screen's top N) riding the bridge. */
  candidates: number;
  /** Upstream link to this portfolio's screen (the SCREEN node). */
  screenHref?: string;
}

export default function PortfolioSignpost({
  candidates,
  screenHref = "/screener",
}: PortfolioSignpostProps) {
  return (
    <section className="mb-10 sm:mb-12">
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
        How this works
      </h2>

      <div className="flex flex-col sm:flex-row items-stretch gap-2 sm:gap-0">
        {/* SCREEN — upstream, dimmed, links to the screen. */}
        <a
          href={screenHref}
          className="flex-1 rounded-xl border border-white/10 bg-white/[0.015] p-3.5 transition-colors hover:bg-white/[0.03]"
        >
          <div className="font-mono text-xs text-text-muted">SCREEN</div>
          <div className="mt-1 text-[11px] text-text-dim">
            ranks your universe ·{" "}
            <span style={{ color: "var(--color-cyan)" }}>edit →</span>
          </div>
        </a>

        {/* Bridge: top N rides the grey→cyan arrow (→ on desktop, ↓ on mobile). */}
        <div
          aria-hidden
          className="flex shrink-0 flex-row items-center justify-center gap-2 px-2 py-1 sm:basis-[124px] sm:flex-col sm:gap-1 sm:py-0"
        >
          <span className="font-mono text-[10px] text-text-muted">
            top {candidates}
          </span>
          <span className="hidden w-full items-center sm:flex">
            <span
              className="h-px flex-1"
              style={{
                background:
                  "linear-gradient(90deg, var(--color-text-muted), var(--color-cyan))",
              }}
            />
            <span
              className="-ml-0.5 text-[11px] leading-none"
              style={{ color: "var(--color-cyan)" }}
            >
              ▶
            </span>
          </span>
          <span
            className="text-sm leading-none sm:hidden"
            style={{ color: "var(--color-cyan)" }}
          >
            ↓
          </span>
          <span className="font-mono text-[9px] text-text-muted">candidates</span>
        </div>

        {/* THIS PORTFOLIO — the lit, current node. */}
        <div
          className="flex-1 rounded-xl border p-3.5"
          style={{
            borderColor: "color-mix(in srgb, var(--color-cyan) 50%, transparent)",
            background: "color-mix(in srgb, var(--color-cyan) 7%, transparent)",
          }}
        >
          <div className="font-mono text-xs" style={{ color: "var(--color-cyan)" }}>
            ● THIS PORTFOLIO{" "}
            <span className="text-[9px] tracking-[0.12em] text-text-muted">
              YOU ARE HERE
            </span>
          </div>
          <div className="mt-1 text-[11px] text-text-dim">
            your swarm trades the top {candidates}, marked to market daily
          </div>
        </div>
      </div>
    </section>
  );
}
