"use client";

/**
 * The account's money as one bar: a coloured segment per strategy, keyed to
 * that strategy's row below. Proportion is a shape, so it is drawn rather than
 * tabulated.
 *
 * While a split is being edited the bar shows the PROPOSED shape, with the
 * current one as a thin ghost beneath it — the change is the thing the owner
 * is judging, and a bar that only ever shows the present makes them hold the
 * comparison in their head.
 *
 * A strategy worth $0 has no width, which is exactly when its boundary matters
 * most, so the legend always lists every strategy by name and figure.
 */

export type SplitSegment = {
  id: string;
  label: string;
  /** What it runs today. */
  value: number;
  /** What it would run if the current edit were applied. */
  target: number;
  color: string;
};

export default function SplitBar({
  segments,
  total,
  dirty,
}: {
  segments: SplitSegment[];
  total: number;
  /** An edit is in progress — draw the proposal, keep today as a ghost. */
  dirty?: boolean;
}) {
  const safe = total > 0 ? total : 0;
  const pct = (v: number) => (safe > 0 ? (v / safe) * 100 : 0);
  const shown = (s: SplitSegment) => (dirty ? s.target : s.value);
  const spoken = segments
    .map((s) => `${s.label} ${pct(shown(s)).toFixed(0)} percent`)
    .join(", ");

  return (
    <div className="mt-3">
      <div
        role="img"
        aria-label={`${dirty ? "Proposed split" : "Split"} of the account: ${spoken}`}
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
      >
        {segments.map((s) => {
          const width = pct(shown(s));
          if (width < 0.4) return null;
          return (
            <div
              key={s.id}
              className="h-full transition-[width] duration-200 first:rounded-l-full last:rounded-r-full motion-reduce:transition-none"
              style={{ width: `${width}%`, background: s.color, opacity: 0.85 }}
            />
          );
        })}
      </div>

      {dirty && (
        <div className="mt-1 flex items-center gap-2">
          <div className="flex h-1 flex-1 overflow-hidden rounded-full bg-white/[0.04]">
            {segments.map((s) => {
              const width = pct(s.value);
              if (width < 0.4) return null;
              return (
                <div
                  key={s.id}
                  className="h-full"
                  style={{ width: `${width}%`, background: s.color, opacity: 0.3 }}
                />
              );
            })}
          </div>
          <span className="font-mono text-[9.5px] uppercase tracking-wider text-text-muted">
            now
          </span>
        </div>
      )}

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => {
          const from = pct(s.value);
          const to = pct(s.target);
          const moved = dirty && Math.abs(to - from) >= 0.5;
          return (
            <li
              key={s.id}
              className="flex items-baseline gap-1.5 text-[11.5px] text-text-dim"
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: s.color }}
              />
              <span className="text-text">{s.label}</span>
              <span className="font-mono tabular-nums text-text-muted">
                {moved ? (
                  <>
                    {from.toFixed(0)}%
                    <span className="mx-1 text-text-muted/60">→</span>
                    <span className="text-amber-200">{to.toFixed(0)}%</span>
                  </>
                ) : (
                  <>
                    {from.toFixed(0)}% · ${fmt(s.value)}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
