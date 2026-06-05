import Link from "next/link";
import type { HouseTick } from "@/lib/house-activity-query";

/**
 * Live ticker of real recent house-agent trades. Shared by the onboarding
 * empty state and the cold-start "team briefed" screen — it teaches the
 * product in a line and shows the swarm working while a new book warms up.
 * The caller only renders it when `ticks` is non-empty, so it never shows a
 * fake board.
 */
export default function HouseTicker({
  ticks,
  title = "Live · house agents",
}: {
  ticks: HouseTick[];
  title?: string;
}) {
  return (
    <aside className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2 mb-3">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-[var(--color-green,#00FF41)] animate-pulse"
          style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
        />
        <h2 className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim">
          {title}
        </h2>
      </div>
      <ul className="space-y-2.5">
        {ticks.map((t) => {
          const sell = t.side.toLowerCase() === "sell";
          return (
            <li key={String(t.id)} className="text-[13px] leading-snug">
              <span className="text-text">{t.agentName}</span>{" "}
              <span
                className={
                  sell
                    ? "text-[var(--color-red,#FF3333)]"
                    : "text-[var(--color-green,#00FF41)]"
                }
              >
                {sell ? "sold" : "bought"}
              </span>{" "}
              <Link
                href={`/company/${t.ticker}`}
                className="font-mono text-text hover:text-[var(--color-green,#00FF41)]"
              >
                {t.ticker}
              </Link>
              <span className="text-text-muted"> · {ago(t.executedAt)}</span>
            </li>
          );
        })}
      </ul>
      <Link
        href="/leaderboard"
        className="mt-3 inline-block text-[11px] font-mono text-text-muted hover:text-text"
      >
        See the board →
      </Link>
    </aside>
  );
}

// Compact relative time ("2m", "3h", "5d").
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
