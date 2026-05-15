import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getPortfolioForUser,
  getMembersForPortfolio,
} from "@/lib/portfolios-query";
import { listPublicAgents } from "@/lib/agents-query";
import CreatePortfolioForm from "@/components/portfolio/create-portfolio-form";
import PortfolioDetailsEditor from "@/components/portfolio/portfolio-details-editor";
import VisibilityToggle from "@/components/portfolio/visibility-toggle";
import AgentPicker from "@/components/portfolio/agent-picker";

export const metadata: Metadata = {
  title: "Your account — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const SECTION_HEADING =
  "font-mono text-sm font-bold text-text-dim uppercase tracking-widest mb-3";

export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account");
  }

  // RLS scopes this to the signed-in user's own row.
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, display_name")
    .eq("id", user.id)
    .maybeSingle();

  const email = profile?.email ?? user.email ?? "";
  const displayName = profile?.display_name || email.split("@")[0] || "there";

  const portfolio = await getPortfolioForUser(user.id);
  const members = portfolio
    ? await getMembersForPortfolio(portfolio.id)
    : [];
  const allAgents = portfolio ? await listPublicAgents(1000) : [];

  return (
    <>
      <Nav />
      <main className="flex-1 max-w-[760px] mx-auto w-full px-4 py-10 font-sans">
        <header className="mb-8">
          <p className="text-xs font-mono uppercase tracking-widest text-text-muted mb-2">
            Account
          </p>
          <h1 className="font-mono text-3xl font-bold text-green mb-3">
            Welcome, {displayName}
          </h1>
          <p className="text-text-dim leading-relaxed">
            You&apos;re signed in as{" "}
            <span className="text-text font-mono">{email}</span>.
          </p>
        </header>

        {portfolio ? (
          <div className="space-y-8">
            <div className="rounded-lg border border-border bg-bg px-4 py-3">
              <p className="text-[11px] font-mono text-orange uppercase tracking-widest mb-1">
                Configured draft
              </p>
              <p className="text-sm text-text-dim leading-relaxed">
                Your portfolio isn&apos;t trading yet — agent execution is
                coming soon. For now you can shape its mandate and assemble
                the team of agents that will run it.
              </p>
            </div>

            <section>
              <h2 className={SECTION_HEADING}>Portfolio</h2>
              <PortfolioDetailsEditor
                initialName={portfolio.display_name}
                initialMandate={portfolio.description ?? ""}
              />
            </section>

            <section>
              <h2 className={SECTION_HEADING}>Agents</h2>
              <p className="text-[11px] font-mono text-text-muted mb-3 -mt-1">
                The agents that will operate this portfolio, working to your
                mandate.
              </p>
              <AgentPicker
                members={members.map((m) => ({
                  handle: m.handle,
                  display_name: m.display_name,
                  is_house_agent: m.is_house_agent,
                }))}
                allAgents={allAgents.map((a) => ({
                  handle: a.handle,
                  display_name: a.display_name,
                  is_house_agent: a.is_house_agent,
                }))}
              />
            </section>

            <section>
              <h2 className={SECTION_HEADING}>Visibility</h2>
              <VisibilityToggle isPublic={portfolio.is_public} />
            </section>

            <p className="text-xs font-mono text-text-muted">
              Public page:{" "}
              <Link
                href={`/portfolios/${portfolio.slug}`}
                className="text-green hover:underline"
              >
                /portfolios/{portfolio.slug}
              </Link>
            </p>
          </div>
        ) : (
          <section>
            <h2 className={SECTION_HEADING}>Create your portfolio</h2>
            <p className="text-sm text-text-dim mb-4 leading-relaxed -mt-1">
              Give it a name and write the mandate your agents will work to.
              You can add agents and adjust everything afterwards.
            </p>
            <CreatePortfolioForm />
          </section>
        )}

        <form action="/auth/signout" method="post" className="mt-10">
          <button
            type="submit"
            className="text-xs font-mono text-text-muted hover:text-text"
          >
            Sign out &rarr;
          </button>
        </form>
      </main>
    </>
  );
}
