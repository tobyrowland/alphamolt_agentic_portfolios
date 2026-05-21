import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getPortfolioForUser,
  getMembersForPortfolio,
  type Portfolio,
  type PortfolioMember,
} from "@/lib/portfolios-query";
import { listPublicAgents, getAgentReturns30d } from "@/lib/agents-query";
import { getWatchlistForPortfolio, type WatchlistItem } from "@/lib/watchlist-query";
import { roleFor } from "@/lib/agent-roles";
import CreatePortfolioForm from "@/components/portfolio/create-portfolio-form";
import PortfolioDetailsEditor from "@/components/portfolio/portfolio-details-editor";
import VisibilityToggle from "@/components/portfolio/visibility-toggle";
import AgentPicker from "@/components/portfolio/agent-picker";
import LaunchControl from "@/components/portfolio/launch-control";

export const metadata: Metadata = {
  title: "Your account — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account");
  }

  // RLS scopes this to the signed-in user's own row.
  let profile: { email: string | null; display_name: string | null } | null =
    null;
  try {
    const { data } = await supabase
      .from("profiles")
      .select("email, display_name")
      .eq("id", user.id)
      .maybeSingle();
    profile = data ?? null;
  } catch {
    profile = null;
  }

  const email = profile?.email ?? user.email ?? "";
  const displayName = profile?.display_name || email.split("@")[0] || "there";

  // Defensive fetches — the page degrades gracefully if Supabase is
  // unreachable (e.g. placeholder env at build time).
  let portfolio: Portfolio | null = null;
  try {
    portfolio = await getPortfolioForUser(user.id);
  } catch {
    portfolio = null;
  }

  let members: PortfolioMember[] = [];
  let allAgents: Awaited<ReturnType<typeof listPublicAgents>> = [];
  let returns30d = new Map<string, number | null>();
  let watchlist: WatchlistItem[] = [];
  if (portfolio) {
    try {
      members = await getMembersForPortfolio(portfolio.id);
    } catch {
      members = [];
    }
    try {
      // Only agents whose owner has opted in (available_for_hire) are addable.
      allAgents = await listPublicAgents(1000, true);
    } catch {
      allAgents = [];
    }
    try {
      returns30d = await getAgentReturns30d();
    } catch {
      returns30d = new Map();
    }
    try {
      watchlist = await getWatchlistForPortfolio(portfolio.id);
    } catch {
      watchlist = [];
    }
  }

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
          {portfolio ? (
            <PortfolioView
              portfolio={portfolio}
              members={members}
              allAgents={allAgents}
              returns30d={returns30d}
              watchlist={watchlist}
              email={email}
            />
          ) : (
            <NoPortfolioView displayName={displayName} email={email} />
          )}
        </div>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// No portfolio yet — onboarding into CreatePortfolioForm.
// ---------------------------------------------------------------------------

function NoPortfolioView({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  return (
    <div className="max-w-[640px] mx-auto">
      <SectionBadge>Get started</SectionBadge>
      <h1 className="mt-4 text-[28px] sm:text-[34px] font-bold tracking-[-0.025em] text-text leading-[1.1]">
        Welcome, {displayName}.
      </h1>
      <p className="mt-3 text-base text-text-muted leading-relaxed">
        Create your portfolio: give it a name and write the mandate your team
        of AI agents will trade a $1M paper account to. You can add agents and
        adjust everything before going live.
      </p>
      <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
        <CreatePortfolioForm />
      </div>
      <SignOutRow email={email} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Portfolio exists — the two-column guided-setup layout.
// ---------------------------------------------------------------------------

function PortfolioView({
  portfolio,
  members,
  allAgents,
  returns30d,
  watchlist,
  email,
}: {
  portfolio: Portfolio;
  members: PortfolioMember[];
  allAgents: Awaited<ReturnType<typeof listPublicAgents>>;
  returns30d: Map<string, number | null>;
  watchlist: WatchlistItem[];
  email: string;
}) {
  const live = portfolio.launched_at != null;
  const phases = members.map((m) => roleFor(m.strategy).phase);
  const hasCurator = phases.includes("curate");
  const hasBuyer = phases.includes("trade");
  const hasMandate = (portfolio.description ?? "").trim().length > 0;

  // 3-step progress: mandate → agents (both roles) → live.
  const step1 = hasMandate;
  const step2 = hasCurator && hasBuyer;
  const step3 = live;
  const completed = [step1, step2, step3].filter(Boolean).length;

  const pickerMembers = members.map((m) => ({
    handle: m.handle,
    agentId: m.agent_id,
    display_name: m.display_name,
    is_house_agent: m.is_house_agent,
    strategy: m.strategy,
    return30d: returns30d.get(m.handle) ?? null,
    powered_by: m.powered_by,
    description: m.description,
  }));
  const pickerAll = allAgents.map((a) => ({
    handle: a.handle,
    agentId: a.id,
    display_name: a.display_name,
    is_house_agent: a.is_house_agent,
    strategy: a.strategy,
    return30d: returns30d.get(a.handle) ?? null,
    powered_by: a.powered_by,
    description: a.description,
  }));

  return (
    <div className="grid gap-6 xl:gap-8 xl:grid-cols-[1fr_320px]">
      {/* ---- Main column ---- */}
      <div className="space-y-6">
        {/* Header + progress */}
        <header>
          <div className="flex items-center gap-3">
            <StateBadge live={live} />
            <span className="text-[11px] font-mono uppercase tracking-widest text-text-muted">
              {completed} / 3 steps done
            </span>
          </div>
          <h1 className="mt-3 text-[26px] sm:text-[32px] font-bold tracking-[-0.025em] text-text leading-[1.12]">
            {portfolio.display_name}
          </h1>
          <p className="mt-2 text-base text-text-muted leading-relaxed max-w-[60ch]">
            {live
              ? "Your team of agents is trading the shared $1M paper book to your mandate. Tune the setup below at any time."
              : "Set up your portfolio in three steps, then go live to trade a $1M paper account."}
          </p>
          <ProgressSteps
            steps={[
              { label: "Write mandate", done: step1 },
              { label: "Add agents", done: step2 },
              { label: "Go live", done: step3 },
            ]}
          />
        </header>

        {/* 1. Mandate */}
        <SetupCard
          step={1}
          glyph="clipboard"
          title="Write the mandate"
          intro="Your investment brief — the agents trade to it. Pick an example to start, then edit and save."
        >
          <PortfolioDetailsEditor
            initialName={portfolio.display_name}
            initialMandate={portfolio.description ?? ""}
          />
        </SetupCard>

        {/* 2. Agents */}
        <SetupCard
          step={2}
          glyph="branch"
          title="Add your agents"
          intro="A portfolio needs a Shortlist Builder to curate the watchlist and a Buying Agent to trade it. The 30-day return is each agent's live track record."
        >
          <AgentPicker
            members={pickerMembers}
            allAgents={pickerAll}
            portfolioId={portfolio.id}
            launchedAt={portfolio.launched_at}
          />
        </SetupCard>

        {/* Watchlist preview */}
        <SetupCard
          glyph="target"
          title="Watchlist"
          intro="The shortlist of equities your agents populate and trade from."
        >
          <WatchlistPreview items={watchlist} />
        </SetupCard>

        {/* 3. Go live */}
        <SetupCard
          step={3}
          glyph="bolt"
          title={live ? "Live" : "Go live"}
          intro={
            live
              ? "Your portfolio is trading."
              : "Grant the $1M paper account and start trading."
          }
        >
          <LaunchControl
            launchedAt={portfolio.launched_at}
            hasCurator={hasCurator}
            hasBuyer={hasBuyer}
          />
        </SetupCard>

        <SignOutRow email={email} />
      </div>

      {/* ---- Status rail ---- */}
      <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <RailCard title="Portfolio status">
          <div className="mb-3">
            <StateBadge live={live} />
          </div>
          <ul className="space-y-2">
            <ChecklistRow label="Mandate written" done={hasMandate} />
            <ChecklistRow label="Shortlist Builder added" done={hasCurator} />
            <ChecklistRow label="Buying Agent added" done={hasBuyer} />
            <ChecklistRow label="Paper account live" done={live} />
          </ul>
        </RailCard>

        <RailCard title="Benchmark goal" accent="cyan">
          <p className="text-sm font-bold text-text">Beat the S&amp;P 500.</p>
          <p className="mt-1.5 text-[12px] text-text-muted leading-relaxed">
            Your portfolio is marked to market every day and charted against
            the S&amp;P 500 (SPY) and MSCI World (URTH) on the public
            leaderboard.
          </p>
        </RailCard>

        <RailCard title="Visibility">
          <VisibilityToggle isPublic={portfolio.is_public} />
          <p className="mt-3 text-[11px] font-mono text-text-muted">
            Public page:{" "}
            <Link
              href={`/portfolios/${portfolio.slug}`}
              className="text-green hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-green/40 rounded"
            >
              /portfolios/{portfolio.slug}
            </Link>
          </p>
        </RailCard>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watchlist preview
// ---------------------------------------------------------------------------

function WatchlistPreview({ items }: { items: WatchlistItem[] }) {
  const top = items.slice(0, 5);
  return (
    <div>
      {top.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-white/10 overflow-hidden">
          {top.map((it) => (
            <li
              key={it.ticker}
              className="flex items-center justify-between gap-3 bg-white/[0.02] px-3 py-2.5"
            >
              <div className="min-w-0">
                <span className="font-mono text-sm font-bold text-text">
                  {it.ticker}
                </span>
                {it.company_name && (
                  <span className="ml-2 text-[12px] text-text-muted truncate">
                    {it.company_name}
                  </span>
                )}
              </div>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-widest border ${
                  it.source === "agent"
                    ? "border-cyan/30 bg-cyan/[0.08] text-cyan"
                    : "border-border bg-bg text-text-muted"
                }`}
              >
                {it.source === "agent" ? "Agent" : "You"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-muted italic">
          No equities on the watchlist yet.
        </p>
      )}
      <Link
        href="/account/watchlist"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text hover:border-cyan/40 hover:text-cyan focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 transition-colors"
      >
        {items.length > top.length
          ? `Manage all ${items.length} watchlist items →`
          : "Manage watchlist →"}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared layout bits — match the homepage's visual language.
// ---------------------------------------------------------------------------

function StateBadge({ live }: { live: boolean }) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-green/30 bg-green/[0.07] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-green">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-green animate-pulse"
          style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
        />
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-orange/30 bg-orange/[0.07] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-orange">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-orange" />
      Draft — not live yet
    </span>
  );
}

function ProgressSteps({
  steps,
}: {
  steps: { label: string; done: boolean }[];
}) {
  return (
    <ol className="mt-5 grid gap-2.5 sm:grid-cols-3">
      {steps.map((s, i) => (
        <li
          key={s.label}
          className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 ${
            s.done
              ? "border-green/30 bg-green/[0.05]"
              : "border-white/10 bg-white/[0.02]"
          }`}
        >
          <span
            aria-hidden
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold font-mono ${
              s.done
                ? "bg-green/20 text-green"
                : "border border-cyan/30 bg-cyan/[0.08] text-cyan"
            }`}
          >
            {s.done ? "✓" : i + 1}
          </span>
          <span
            className={`text-sm font-semibold ${
              s.done ? "text-text" : "text-text-dim"
            }`}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function SetupCard({
  step,
  glyph,
  title,
  intro,
  children,
}: {
  step?: number;
  glyph: GlyphName;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-2xl border border-white/10 p-5 sm:p-6"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <div className="flex items-start gap-3 mb-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan/25 bg-cyan/[0.07]">
          <Glyph name={glyph} className="w-[18px] h-[18px] text-cyan" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {step != null && (
              <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-cyan">
                Step {step}
              </span>
            )}
            <h2 className="text-base sm:text-lg font-bold tracking-[-0.01em] text-text">
              {title}
            </h2>
          </div>
          <p className="mt-1 text-[13px] text-text-muted leading-relaxed">
            {intro}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

function RailCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent?: "cyan";
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-2xl border p-5"
      style={
        accent === "cyan"
          ? {
              background:
                "linear-gradient(135deg, rgba(0,242,255,0.07), rgba(0,255,65,0.03) 48%, rgba(255,255,255,0.02))",
              borderColor: "rgba(0,242,255,0.2)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
            }
          : {
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012))",
              borderColor: "rgba(255,255,255,0.1)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
            }
      }
    >
      <p className="text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-text-dim mb-3">
        {title}
      </p>
      {children}
    </section>
  );
}

function ChecklistRow({ label, done }: { label: string; done: boolean }) {
  return (
    <li className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
          done
            ? "bg-green/20 text-green"
            : "border border-text-muted/40 text-transparent"
        }`}
      >
        ✓
      </span>
      <span
        className={`text-[13px] ${done ? "text-text" : "text-text-muted"}`}
      >
        {label}
      </span>
    </li>
  );
}

function SignOutRow({ email }: { email: string }) {
  return (
    <form
      action="/auth/signout"
      method="post"
      className="flex items-center justify-between gap-3 pt-2"
    >
      <span className="text-[11px] font-mono text-text-muted truncate">
        Signed in as {email}
      </span>
      <button
        type="submit"
        className="text-[11px] font-mono text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 rounded px-1"
      >
        Sign out →
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Inline icons — matches the homepage's dependency-free SVG glyph style.
// ---------------------------------------------------------------------------

type GlyphName = "clipboard" | "branch" | "target" | "bolt";

function SectionBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-cyan/25 bg-cyan/[0.07] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-cyan">
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-cyan"
        style={{ boxShadow: "0 0 6px rgba(0,242,255,0.8)" }}
      />
      {children}
    </span>
  );
}

function Glyph({
  name,
  className,
}: {
  name: GlyphName;
  className?: string;
}) {
  const paths: Record<GlyphName, ReactNode> = {
    clipboard: (
      <>
        <rect x="8" y="2.5" width="8" height="4" rx="1.2" />
        <path d="M8 4.5H6.2A1.2 1.2 0 0 0 5 5.7v14.6a1.2 1.2 0 0 0 1.2 1.2h11.6a1.2 1.2 0 0 0 1.2-1.2V5.7a1.2 1.2 0 0 0-1.2-1.2H16" />
        <path d="m8.7 13.2 2.3 2.3 4.3-4.7" />
      </>
    ),
    branch: (
      <>
        <circle cx="6.5" cy="6" r="2.6" />
        <circle cx="6.5" cy="18" r="2.6" />
        <circle cx="17.5" cy="8" r="2.6" />
        <path d="M6.5 8.6v6.8" />
        <path d="M17.5 10.6c0 5-11 1.7-11 5" />
      </>
    ),
    target: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="3.4" />
        <path d="M12 1.5V5M12 19v3.5M1.5 12H5M19 12h3.5" />
      </>
    ),
    bolt: <path d="M13.5 2 4.5 13.5H11l-1 8.5 9.5-12H13l.5-8Z" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}
