import Link from "next/link";
import BriefTeamForm from "@/components/portfolio/brief-team-form";
import { getHouseTicker, type HouseTick } from "@/lib/house-activity-query";
import { PRESETS, DEFAULT_PRESET } from "@/lib/screen/config";

/**
 * First-run / unconfigured portfolio screen (onboarding brief): brief a team
 * that's standing by, don't build a portfolio. One model statement, one
 * ~80%-pre-filled "Brief your team" card whose only required field is the
 * mandate, and a live ticker of real house activity beside it so a newcomer
 * sees the product working. The ticker is hidden entirely when the house
 * board is quiet (never a fake board).
 *
 * Shared by the Dashboard (/account) and the Portfolio route
 * (/account/portfolio): a signed-in user who owns no portfolio yet sees this
 * unconfigured state on EITHER surface, so a magic-link sign-in lands them on
 * the Portfolio page in its unconfigured state rather than bouncing away.
 */
export default async function Onboarding({
  displayName,
}: {
  displayName: string;
}) {
  const ticks = await getHouseTicker(12);
  const presets = Object.values(PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
  }));
  const defaultName = `${displayName}'s Portfolio`;

  return (
    <div>
      <header className="max-w-[58ch]">
        <h1 className="text-[26px] sm:text-[32px] font-bold tracking-[-0.02em] text-text leading-[1.15]">
          Welcome, {displayName}
        </h1>
        <p className="mt-3 text-[15px] text-text border-l-2 border-[var(--color-green,#00FF41)] pl-3 leading-relaxed">
          Brief a team of AI agents. They trade your strategy on paper. The
          leaderboard ranks everyone by alpha vs SPY.
        </p>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_300px] items-start">
        <BriefTeamForm
          presets={presets}
          defaultPreset={DEFAULT_PRESET}
          defaultName={defaultName}
        />
        {ticks.length > 0 && <LiveTicker ticks={ticks} />}
      </div>
    </div>
  );
}

// Real recent house-agent trades — teaches the product in a line (brief §3).
// Only rendered when there's genuine activity to show.
function LiveTicker({ ticks }: { ticks: HouseTick[] }) {
  return (
    <aside className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2 mb-3">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-[var(--color-green,#00FF41)] animate-pulse"
          style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
        />
        <h2 className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim">
          Live · house agents
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

// Compact relative time ("2m", "3h", "5d") for the live ticker.
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
