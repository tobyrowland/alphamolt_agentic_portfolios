import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getPortfolioForUser,
  getMembersForPortfolio,
  getHoldingsCountForPortfolio,
  type Portfolio,
  type PortfolioMember,
} from "@/lib/portfolios-query";
import { listPublicAgents, getAgentReturns30d } from "@/lib/agents-query";
import { roleFor } from "@/lib/agent-roles";
import CreatePortfolioForm from "@/components/portfolio/create-portfolio-form";
import PortfolioDetailsEditor from "@/components/portfolio/portfolio-details-editor";
import BuyMandateEditor from "@/components/portfolio/buy-mandate-editor";
import AgentPicker from "@/components/portfolio/agent-picker";
import VisibilityToggle from "@/components/portfolio/visibility-toggle";

export const metadata: Metadata = {
  title: "Your account — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

// Hysteresis thresholds for the Private/Public toggle (migration 031).
const PUBLIC_ACTIVATE_THRESHOLD = 15;
const PUBLIC_FLOOR_THRESHOLD = 10;

export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account");
  }

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

  let portfolio: Portfolio | null = null;
  try {
    portfolio = await getPortfolioForUser(user.id);
  } catch {
    portfolio = null;
  }

  let members: PortfolioMember[] = [];
  let allAgents: Awaited<ReturnType<typeof listPublicAgents>> = [];
  let returns30d = new Map<string, number | null>();
  let holdingsCount = 0;
  if (portfolio) {
    try {
      members = await getMembersForPortfolio(portfolio.id);
    } catch {
      members = [];
    }
    try {
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
      holdingsCount = await getHoldingsCountForPortfolio(portfolio.id);
    } catch {
      holdingsCount = 0;
    }
  }

  return (
    <>
      <Nav />
      <main className="flex-1 w-full relative">
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
              holdingsCount={holdingsCount}
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
        of AI agents will trade a $1M paper account to. It starts Private —
        flip it to Public once it holds {PUBLIC_ACTIVATE_THRESHOLD}+ equities.
      </p>
      <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
        <CreatePortfolioForm />
      </div>
      <SignOutRow email={email} />
    </div>
  );
}

function PortfolioView({
  portfolio,
  members,
  allAgents,
  returns30d,
  holdingsCount,
  email,
}: {
  portfolio: Portfolio;
  members: PortfolioMember[];
  allAgents: Awaited<ReturnType<typeof listPublicAgents>>;
  returns30d: Map<string, number | null>;
  holdingsCount: number;
  email: string;
}) {
  const phases = members.map((m) => roleFor(m.strategy).phase);
  const hasCurator = phases.includes("curate");
  const hasBuyer = phases.includes("trade");
  const hasMandate = (portfolio.description ?? "").trim().length > 0;

  const step1 = hasMandate;
  const step2 = hasCurator && hasBuyer;

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
    <div className="space-y-7 sm:space-y-9">
      <header>
        <VisibilityBadge isPublic={portfolio.is_public} />
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
          Your team of agents trades a $1M paper book to your mandate. Tune
          mandate or membership any time. Hits public eligibility at{" "}
          {PUBLIC_ACTIVATE_THRESHOLD} equities.
        </p>
        <ProgressSteps
          steps={[
            { label: "Write mandate", done: step1 },
            { label: "Add agents", done: step2 },
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
          initialName={portfolio.display_name}
          initialMandate={portfolio.description ?? ""}
        />
      </SetupCard>

      <SetupCard
        glyph="clipboard"
        title="Buy-decisions mandate (optional)"
        intro="A separate brief telling the buying agent HOW to evaluate adds — distinct from the main mandate, which says WHAT the portfolio should be. Leave empty to skip."
      >
        <BuyMandateEditor initialBuyMandate={portfolio.buy_mandate ?? ""} />
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
        />
      </SetupCard>

      <VisibilityPanel
        isPublic={portfolio.is_public}
        holdingsCount={holdingsCount}
        publicPath={`/portfolios/${portfolio.slug}`}
      />

      <SignOutRow email={email} />
    </div>
  );
}

function VisibilityBadge({ isPublic }: { isPublic: boolean }) {
  if (isPublic) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.08] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-green)]">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-[var(--color-green)] animate-pulse"
          style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
        />
        Public
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
      Private
    </span>
  );
}

function VisibilityPanel({
  isPublic,
  holdingsCount,
  publicPath,
}: {
  isPublic: boolean;
  holdingsCount: number;
  publicPath: string;
}) {
  const eligible = holdingsCount >= PUBLIC_ACTIVATE_THRESHOLD;

  if (isPublic) {
    return (
      <div className="rounded-2xl border border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.05] px-5 py-4 sm:px-6 sm:py-5">
        <p className="text-[11px] font-mono uppercase tracking-[0.16em] text-[var(--color-green)] flex items-center gap-2">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-[var(--color-green)] animate-pulse"
            style={{ boxShadow: "0 0 8px rgba(0,255,65,0.6)" }}
          />
          Visible on the leaderboard
        </p>
        <p className="mt-2 text-sm text-text-dim leading-relaxed">
          Holding {holdingsCount} equities. Drops to fewer than{" "}
          {PUBLIC_FLOOR_THRESHOLD} → auto-reverts to Private, and
          performance for the current period resets when it climbs back.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <VisibilityToggle
            isPublic={isPublic}
            holdingsCount={holdingsCount}
          />
          <Link
            href={publicPath}
            className="text-sm font-semibold text-[var(--color-cyan)] hover:brightness-110 transition-[filter] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/40 rounded"
          >
            View public page &rarr;
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border p-5 sm:p-6"
      style={{
        background: eligible
          ? "linear-gradient(135deg, rgba(0,242,255,0.07), rgba(0,255,65,0.03) 48%, rgba(255,255,255,0.02))"
          : "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012))",
        borderColor: eligible
          ? "rgba(0,242,255,0.2)"
          : "rgba(255,255,255,0.10)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
      }}
    >
      <p className="text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-[var(--color-cyan)] mb-1">
        {eligible ? "Ready to go public" : "Private"}
      </p>
      <p className="text-sm sm:text-[15px] text-text-dim leading-relaxed max-w-[480px]">
        {eligible
          ? `Holding ${holdingsCount} equities — eligible. Flip public to appear on the leaderboard.`
          : `Holding ${holdingsCount} of ${PUBLIC_ACTIVATE_THRESHOLD} equities needed. Once the agents fill the book, you can flip the portfolio public.`}
      </p>
      <div className="mt-3">
        <VisibilityToggle
          isPublic={isPublic}
          holdingsCount={holdingsCount}
        />
      </div>
    </div>
  );
}

function ProgressSteps({
  steps,
}: {
  steps: { label: string; done: boolean }[];
}) {
  return (
    <ol className="mt-6 grid gap-2.5 sm:grid-cols-2">
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
