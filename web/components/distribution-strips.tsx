/**
 * Fundamentals distribution strips (brief §5). Each metric is a neutral
 * percentile RULER (0–100), not a fill bar:
 *   - a constant middle-50% band (p25–p75)
 *   - a universe-median tick (p50, always centre by construction)
 *   - a sector-median tick (the sector median mapped to its universe %)
 *   - the stock's dot at its percentile
 *
 * Neutral colour throughout — no green-for-good coding; the reader judges
 * (brief §3, §9). Server component: pure CSS, ships in the initial HTML.
 */

import type { StripModel } from "@/lib/metric-stats-query";

function clampLeft(pct: number | null): number {
  if (pct == null || !Number.isFinite(pct)) return 50;
  return Math.min(100, Math.max(0, pct));
}

export default function DistributionStrips({
  ticker,
  strips,
}: {
  ticker: string;
  strips: StripModel[];
}) {
  const anyAvailable = strips.some((s) => s.available);
  if (!anyAvailable) {
    return (
      <p className="text-sm text-text-muted">
        Distribution stats are not yet available for {ticker}.
      </p>
    );
  }

  return (
    <div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 mb-4 text-[10.5px] font-mono text-text-muted">
        <LegendItem>
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-cyan align-middle mr-1.5" />
          {ticker}
        </LegendItem>
        <LegendItem>
          <span className="inline-block w-0.5 h-3 bg-text align-middle mr-1.5" />
          universe median
        </LegendItem>
        <LegendItem>
          <span className="inline-block w-0.5 h-3 bg-text-muted align-middle mr-1.5" />
          sector median
        </LegendItem>
        <LegendItem>
          <span className="inline-block w-3.5 h-2.5 rounded-[2px] bg-white/15 align-middle mr-1.5" />
          middle 50%
        </LegendItem>
      </div>

      <div className="flex flex-col gap-3.5">
        {strips.map((s) => (
          <StripRow key={s.key} strip={s} ticker={ticker} />
        ))}
      </div>
    </div>
  );
}

function LegendItem({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap">
      {children}
    </span>
  );
}

function StripRow({ strip, ticker }: { strip: StripModel; ticker: string }) {
  const ariaLabel = strip.available
    ? `${strip.label}: ${strip.valueLabel}, ${strip.percentileLabel ?? ""} across the screened universe`.trim()
    : `${strip.label}: not available`;

  return (
    <div className="grid grid-cols-[96px_1fr_84px] sm:grid-cols-[120px_1fr_92px] items-center gap-3">
      <span className="text-[12.5px] text-text-dim truncate">{strip.label}</span>

      <div
        className="relative h-[26px] rounded-[5px] bg-white/[0.04] overflow-hidden"
        role="img"
        aria-label={ariaLabel}
      >
        {strip.available ? (
          <>
            {/* middle-50% band (p25–p75) — constant by construction */}
            <span className="absolute inset-y-0 left-1/4 w-1/2 bg-white/[0.06]" />
            {/* universe median tick (p50) */}
            <span
              className="absolute top-1 bottom-1 w-[1.5px] bg-text"
              style={{ left: "50%" }}
            />
            {/* sector median tick */}
            {strip.sectorPct != null && (
              <span
                className="absolute top-1 bottom-1 w-[1.5px] bg-text-muted"
                style={{ left: `${clampLeft(strip.sectorPct)}%` }}
              />
            )}
            {/* the stock's dot */}
            <span
              className="absolute top-1/2 w-[11px] h-[11px] rounded-full bg-cyan border-2 border-bg-card"
              style={{
                left: `${clampLeft(strip.stockPct)}%`,
                transform: "translate(-50%, -50%)",
              }}
            />
          </>
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-text-muted">
            stat unavailable
          </span>
        )}
      </div>

      <span className="font-mono text-[12px] text-right text-text">
        {strip.valueLabel}{" "}
        {strip.percentileLabel && (
          <span className="text-text-muted">{strip.percentileLabel}</span>
        )}
      </span>
    </div>
  );
}
