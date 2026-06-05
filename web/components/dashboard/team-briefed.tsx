import Link from "next/link";
import HouseTicker from "@/components/dashboard/house-ticker";
import type { DashPortfolio } from "@/lib/dashboard-query";
import type { HouseTick } from "@/lib/house-activity-query";

/**
 * The "second screen" (onboarding brief §5 follow-up): what the owner sees the
 * instant their team goes live, before the swarm has traded. The normal
 * dashboard would show an empty pulse chart + a "—" card + "No trades yet" —
 * all setup, no payoff. This replaces that cold start with a reward + an
 * orientation: the team is briefed and standing by, here's the brief you
 * wrote, here's what happens next, and here's the swarm already working while
 * you wait. It yields to the real pulse+map the moment the first trade lands.
 */
export default function TeamBriefed({
  portfolio,
  ticks,
}: {
  portfolio: DashPortfolio;
  ticks: HouseTick[];
}) {
  const buyer = portfolio.roster.find((m) => m.role === "buyer");
  const reviewer = portfolio.roster.find((m) => m.role === "reviewer");
  const universe = portfolio.universeLabel ?? "your universe";
  const run = nextRun();

  return (
    <div className="space-y-8">
      {/* Reward header */}
      <header>
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-green,#00FF41)]/30 bg-[var(--color-green,#00FF41)]/[0.08] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-green,#00FF41)]">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-[var(--color-green,#00FF41)] animate-pulse"
            style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
          />
          Standing by
        </span>
        <h1 className="mt-4 text-[26px] sm:text-[32px] font-bold tracking-[-0.02em] text-text leading-[1.12]">
          {portfolio.name} is briefed.
        </h1>
        <p className="mt-2 text-[15px] text-text-muted max-w-[60ch] leading-relaxed">
          Your team has a $1,000,000 paper book and your mandate. Nothing to do
          now — they trade on their own cadence while you&apos;re away. The
          first picks land on the next run.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px] items-start">
        <div className="space-y-6">
          {/* What happens next */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-4">
              What happens next
            </h2>
            <ol className="space-y-4">
              <Step
                n={1}
                title={`${buyer ? buyer.name : "Your buyer"} scans ${universe}`}
                body="It ranks the universe against your mandate and drafts the names that clear its conviction bar — sized against your cash."
                now
              />
              <Step
                n={2}
                title="First picks land on the next run"
                body={`The swarm rebalances on a daily cadence — next at ${run.label} (in ~${run.inHours}h). You'll see trades appear here the moment they fill.`}
              />
              <Step
                n={3}
                title={`${reviewer ? reviewer.name : "Your reviewer"} watches every thesis`}
                body="It sells a name when its thesis breaks against your mandate. Your book goes public once it holds 15 equities."
              />
            </ol>
          </section>

          {/* The brief you wrote */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim">
                Your brief
              </h2>
              <Link
                href={`/portfolios/${portfolio.slug}`}
                className="text-[11px] font-mono text-[var(--color-cyan,#00F2FF)] hover:brightness-110"
              >
                edit →
              </Link>
            </div>

            <Field label="Mandate">
              {portfolio.mandate ? (
                <p className="text-sm text-text leading-relaxed">
                  {portfolio.mandate}
                </p>
              ) : (
                <p className="text-sm text-text-muted italic">
                  No mandate set — your team has nothing to trade to yet.
                </p>
              )}
            </Field>

            <Field label="Universe">
              <span className="text-sm text-text">{universe}</span>
            </Field>

            <Field label="Team">
              {portfolio.roster.length > 0 ? (
                <ul className="space-y-1">
                  {portfolio.roster.map((m) => (
                    <li key={m.name} className="text-sm text-text">
                      <span className="font-semibold">{m.name}</span>
                      <span className="text-text-muted">
                        {" "}
                        — {m.role ?? "member"}
                        {m.poweredBy ? ` · ${m.poweredBy}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-muted italic">
                  No agents rostered yet —{" "}
                  <Link
                    href={`/portfolios/${portfolio.slug}`}
                    className="text-[var(--color-cyan,#00F2FF)] hover:brightness-110"
                  >
                    add a buyer + reviewer
                  </Link>
                  .
                </p>
              )}
            </Field>
          </section>

          {/* Doors out — for while they wait */}
          <nav
            aria-label="Explore"
            className="flex flex-wrap gap-4 text-sm text-text-muted"
          >
            <Link
              href={`/portfolios/${portfolio.slug}`}
              className="hover:text-text"
            >
              View portfolio →
            </Link>
            <Link href="/screener" className="hover:text-text">
              Tune the screen →
            </Link>
            <Link href="/leaderboard" className="hover:text-text">
              See the leaderboard →
            </Link>
          </nav>
        </div>

        {/* The swarm, already working — only when there's real activity */}
        {ticks.length > 0 && (
          <HouseTicker ticks={ticks} title="Meanwhile · the swarm" />
        )}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  body,
  now,
}: {
  n: number;
  title: string;
  body: string;
  now?: boolean;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold font-mono ${
          now
            ? "bg-[var(--color-green,#00FF41)]/20 text-[var(--color-green,#00FF41)]"
            : "border border-white/15 text-text-muted"
        }`}
      >
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text">
          {title}
          {now && (
            <span className="ml-2 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-green,#00FF41)]">
              now
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[13px] text-text-muted leading-relaxed">
          {body}
        </p>
      </div>
    </li>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-2 border-t border-white/5 first:border-t-0">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--color-green,#00FF41)] mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

// Next scheduled swarm rebalance — the agent_heartbeat cron runs daily at
// 07:00 UTC; a fresh portfolio's members are due on the next one. Reported in
// UTC (the schedule's own frame) plus a rough hours-away so it reads as soon.
function nextRun(): { label: string; inHours: number } {
  const now = new Date();
  const run = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      7,
      0,
      0,
    ),
  );
  if (run.getTime() <= now.getTime()) run.setUTCDate(run.getUTCDate() + 1);
  const inHours = Math.max(1, Math.round((run.getTime() - now.getTime()) / 3.6e6));
  return { label: "07:00 UTC", inHours };
}
