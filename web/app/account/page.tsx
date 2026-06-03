import type { Metadata } from "next";
import type { ReactNode } from "react";
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
import { roleFor } from "@/lib/agent-roles";
import CreatePortfolioForm from "@/components/portfolio/create-portfolio-form";
import PortfolioDetailsEditor from "@/components/portfolio/portfolio-details-editor";
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
  }

  return (
    <>
      <Nav />
      <main className="flex-1 w-full relative">
        {/* Ambient backdrop — same off-axis cyan/green glows as the
            homepage hero, calmer opacity, scoped behind the header so
            the form region below stays a clean dark canvas. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[440px] -z-10 opacity-80"
          style={{
            background:
              "radial-gradient(60% 65% at 16% 8%, rgba(0,255,65,0.05), transparent 70%), radial-gradient(48% 55% at 86% 4%, rgba(0,242,255,0.06), transparent 70%)",
          }}
        />
        <div className="max-w-[820px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          {portfolio ? (
            <PortfolioView
              portfolio={portfolio}
              members={members}
              allAgents={allAgents}
              returns30d={returns30d}
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
// Portfolio exists — ultra-minimal single-column path: mandate → agents → launch.
// ---------------------------------------------------------------------------

function PortfolioView({
  portfolio,
  members,
  allAgents,
  returns30d,
  email,
}: {
  portfolio: Portfolio;
  members: PortfolioMember[];
  allAgents: Awaited<ReturnType<typeof listPublicAgents>>;
  returns30d: Map<string, number | null>;
  email: string;
}) {
  const live = portfolio.launched_at != null;
  const phases = members.map((m) => roleFor(m.strategy).phase);
  const hasCurator = phases.includes("curate");
  const hasBuyer = phases.includes("trade");
  const hasMandate = (portfolio.description ?? "").trim().length > 0;

  const step1 = hasMandate;
  const step2 = hasCurator && hasBuyer;
  const step3 = live;

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

  const daysLive = live
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(portfolio.launched_at!).getTime()) /
            86_400_000,
        ),
      )
    : 0;

  return (
    <div className="space-y-7 sm:space-y-9">
      <header>
        <DashboardStateBadge live={live} daysLive={daysLive} />
        <h1 className="mt-4 text-[34px] sm:text-[44px] font-bold tracking-[-0.025em] text-text leading-[1.05]">
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(110deg, var(--color-cyan) 0%, #6FF8A0 45%, var(--color-green) 100%)",
            }}
          >
            {portfolio.display_name}
          </span>
        </h1>
        <p className="mt-4 text-base sm:text-lg text-text-muted leading-relaxed max-w-[60ch]">
          {live
            ? "Your team of agents is trading the shared $1M paper book to your mandate. Tune the setup below at any time."
            : "Two steps, then go live. Write your mandate, add the agents, launch."}
        </p>
        <ProgressSteps
          steps={[
            { label: "Write mandate", done: step1 },
            { label: "Add agents", done: step2 },
            { label: "Go live", done: step3 },
          ]}
        />
      </header>

      <SetupCard
        step={1}
        glyph="clipboard"
        title="Write the mandate"
        intro="Your investment brief — the agents trade to it. Pick an example to start, then edit and save."
      >
        <PortfolioDetailsEditor
          portfolioId={portfolio.id}
          initialName={portfolio.display_name}
          initialMandate={portfolio.description ?? ""}
        />
      </SetupCard>

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

      <LaunchControl
        launchedAt={portfolio.launched_at}
        hasCurator={hasCurator}
        hasBuyer={hasBuyer}
        publicPath={`/portfolios/${portfolio.slug}`}
      />

      <SignOutRow email={email} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared layout bits — match the homepage's visual language.
// ---------------------------------------------------------------------------

function DashboardStateBadge({
  live,
  daysLive,
}: {
  live: boolean;
  daysLive: number;
}) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.08] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-green)]">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-[var(--color-green)] animate-pulse"
          style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
        />
        Live
        {daysLive > 0 && (
          <>
            <span aria-hidden className="text-[var(--color-green)]/40">
              ·
            </span>
            <span className="font-mono">
              {daysLive}d
            </span>
          </>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-cyan)]/30 bg-[var(--color-cyan)]/[0.07] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-cyan)]">
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-[var(--color-cyan)]"
        style={{ boxShadow: "0 0 6px rgba(0,242,255,0.8)" }}
      />
      Setup in progress
    </span>
  );
}

function ProgressSteps({
  steps,
}: {
  steps: { label: string; done: boolean }[];
}) {
  return (
    <ol className="mt-6 grid gap-2.5 sm:grid-cols-3">
      {steps.map((s, i) => (
        <li
          key={s.label}
          className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 ${
            s.done
              ? "border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.05]"
              : "border-white/10 bg-white/[0.02]"
          }`}
        >
          <span
            aria-hidden
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold font-mono ${
              s.done
                ? "bg-[var(--color-green)]/20 text-[var(--color-green)]"
                : "border border-[var(--color-cyan)]/30 bg-[var(--color-cyan)]/[0.08] text-[var(--color-cyan)]"
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
      className="group rounded-2xl border border-white/10 p-5 sm:p-6 transition-colors hover:border-white/15"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <div className="flex items-start gap-3 mb-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-cyan)]/25 bg-[var(--color-cyan)]/[0.07]">
          <Glyph
            name={glyph}
            className="w-[18px] h-[18px] text-[var(--color-cyan)]"
          />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {step != null && (
              <span className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--color-cyan)]">
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

type GlyphName = "clipboard" | "branch";

function SectionBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-cyan)]/25 bg-[var(--color-cyan)]/[0.07] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-cyan)]">
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-[var(--color-cyan)]"
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

