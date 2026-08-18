"use client";

/**
 * The account's money as one bar: a coloured segment per strategy, with the
 * same colour keying that strategy's card below. It exists because a table of
 * numbers made it "hard to see where one strategy begins and the next ends" —
 * proportion is a shape, so draw the shape.
 *
 * A strategy worth $0 has no width, which is exactly when the boundary matters
 * most, so the legend always lists every strategy with its own figure and a
 * hairline stub stands in for an empty segment.
 */

export type SplitSegment = {
  id: string;
  label: string;
  value: number;
  color: string;
};

export default function SplitBar({
  segments,
  total,
}: {
  segments: SplitSegment[];
  total: number;
}) {
  const safeTotal = total > 0 ? total : 0;
  const pct = (v: number) => (safeTotal > 0 ? (v / safeTotal) * 100 : 0);
  const spoken = segments
    .map((s) => `${s.label} ${pct(s.value).toFixed(0)} percent`)
    .join(", ");

  return (
    <div className="mt-3">
      <div
        role="img"
        aria-label={`Split of the account: ${spoken}`}
        className="flex h-3 w-full overflow-hidden rounded-full bg-white/[0.06]"
      >
        {segments.map((s) => {
          const width = pct(s.value);
          if (width < 0.4) return null;
          return (
            <div
              key={s.id}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${width}%`,
                background: s.color,
                opacity: 0.85,
              }}
            />
          );
        })}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <li
            key={s.id}
            className="flex items-baseline gap-1.5 text-[12px] text-text-dim"
          >
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: s.color }}
            />
            <span className="text-text">{s.label}</span>
            <span className="font-mono text-text-muted">
              {pct(s.value).toFixed(0)}% · ${fmt(s.value)}
            </span>
          </li>
        ))}
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
