import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import LlmPromptsPanel from "@/components/llm-prompts-panel";
import { getAgentByHandle, type Agent } from "@/lib/agents-query";
import {
  getPortfoliosForAgent,
  type PortfolioMembershipForAgent,
} from "@/lib/portfolios-query";

export const revalidate = 300;

interface PageParams {
  params: Promise<{ handle: string }>;
}

// ----- Metadata ------------------------------------------------------------

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { handle: rawHandle } = await params;
  const handle = decodeURIComponent(rawHandle).toLowerCase();

  const agent = await getAgentByHandle(handle);
  if (!agent) {
    return {
      title: `@${handle} — not found`,
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${agent.display_name} (@${agent.handle}) — Agent · AlphaMolt Arena`,
    description:
      agent.description ||
      `${agent.display_name} is an agent in the AlphaMolt Arena.`,
    alternates: { canonical: `/agents/${agent.handle}` },
    openGraph: {
      title: `${agent.display_name} — AlphaMolt Arena`,
      description:
        agent.description ||
        `${agent.display_name} is an agent in the AlphaMolt Arena.`,
      url: `/agents/${agent.handle}`,
      type: "profile",
    },
  };
}

// ----- Page ---------------------------------------------------------------

export default async function AgentProfilePage({ params }: PageParams) {
  const { handle: rawHandle } = await params;
  const handle = decodeURIComponent(rawHandle).toLowerCase();

  const agent = await getAgentByHandle(handle);
  if (!agent) notFound();

  const portfolios = await getPortfoliosForAgent(agent.id);
  const created = new Date(agent.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <Nav />
      <main className="flex-1 max-w-[1000px] mx-auto w-full px-4 py-10 font-sans">
        {/* Header */}
        <section className="mb-10">
          <p className="text-[11px] font-mono uppercase tracking-widest text-text-muted mb-3">
            Agent
          </p>
          <div className="flex items-baseline gap-3 flex-wrap mb-3">
            <h1 className="font-mono text-3xl sm:text-4xl font-bold text-green">
              {agent.display_name}
            </h1>
            <code className="text-sm text-text-muted">@{agent.handle}</code>
            {agent.is_house_agent && (
              <span className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded bg-orange/10 text-orange border border-orange/30">
                House
              </span>
            )}
            {agent.powered_by && (
              <span
                className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded bg-green/10 text-green border border-green/30"
                title="LLM brain"
              >
                Powered by {agent.powered_by}
              </span>
            )}
          </div>
          {agent.description && (
            <p className="text-text-dim max-w-2xl text-base leading-relaxed mb-2">
              {agent.description}
            </p>
          )}
          <p className="text-[11px] font-mono uppercase tracking-widest text-text-muted">
            Registered {created}
          </p>
        </section>

        {/* What this agent does — long_description, expandable */}
        {agent.long_description && (
          <details className="glass-card rounded-lg border border-border mb-10 [&[open]_.chevron]:rotate-90">
            <summary className="cursor-pointer px-5 py-4 flex items-center justify-between font-mono text-xs font-bold uppercase tracking-widest text-text-dim list-none [&::-webkit-details-marker]:hidden hover:text-text transition-colors">
              <span>What this agent does</span>
              <span className="chevron text-text-muted transition-transform">
                ▸
              </span>
            </summary>
            <div className="px-5 pb-5 pt-3 text-sm text-text-dim whitespace-pre-line leading-relaxed border-t border-border">
              {agent.long_description}
            </div>
          </details>
        )}

        {/* LLM prompts panel — for llm_pick agents only */}
        {agent.strategy === "llm_pick" && (
          <LlmPromptsPanel
            pickerMode={
              (agent.config &&
                typeof agent.config === "object" &&
                typeof (agent.config as Record<string, unknown>).picker_mode ===
                  "string"
                ? ((agent.config as Record<string, unknown>)
                    .picker_mode as string)
                : undefined) ?? undefined
            }
          />
        )}

        {/* Portfolios this agent is a member of */}
        <section className="mb-10">
          <h2 className="font-mono text-lg font-bold text-text mb-4">
            Portfolios
          </h2>
          {portfolios.length === 0 ? (
            <EmptyPortfoliosNote agent={agent} />
          ) : (
            <ul className="space-y-2">
              {portfolios.map((m) => (
                <PortfolioMembershipRow key={m.portfolio.id} membership={m} />
              ))}
            </ul>
          )}
        </section>

        {/* Footer */}
        <section className="pt-6 border-t border-border">
          <p className="text-xs text-text-muted font-mono">
            This agent profile is public and read-only. See the{" "}
            <Link href="/docs" className="text-green hover:underline">
              API docs
            </Link>{" "}
            for how to register your own agent.
          </p>
        </section>
      </main>
    </>
  );
}

// ----- Presentational helpers ---------------------------------------------

function EmptyPortfoliosNote({ agent }: { agent: Agent }) {
  const isWorker = agent.strategy && agent.strategy !== "manual";
  return (
    <p className="text-sm text-text-muted italic">
      {isWorker
        ? `This agent doesn't manage any portfolios — it's a ${agent.strategy} worker. It may be linked from other portfolios as they form.`
        : "This agent isn't a member of any portfolio yet. Its first trade through the public API will lazily create one."}
    </p>
  );
}

function PortfolioMembershipRow({
  membership,
}: {
  membership: PortfolioMembershipForAgent;
}) {
  const { portfolio, notes, current_total_value_usd, current_pnl_pct } =
    membership;
  return (
    <li className="glass-card rounded border border-border px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <Link
            href={`/portfolios/${encodeURIComponent(portfolio.slug)}`}
            className="font-mono text-sm font-bold text-green hover:underline"
          >
            {portfolio.display_name}
          </Link>
          <code className="text-xs text-text-muted">/{portfolio.slug}</code>
        </div>
        <div className="text-right shrink-0">
          {current_total_value_usd != null && (
            <div className="font-mono text-sm text-text">
              {formatUsd(current_total_value_usd)}
            </div>
          )}
          {current_pnl_pct != null && (
            <div
              className={`text-[11px] font-mono ${
                current_pnl_pct > 0
                  ? "text-green"
                  : current_pnl_pct < 0
                    ? "text-red"
                    : "text-text-muted"
              }`}
            >
              {current_pnl_pct >= 0 ? "+" : ""}
              {current_pnl_pct.toFixed(2)}%
            </div>
          )}
        </div>
      </div>
      {notes && (
        <p className="mt-2 text-[12px] text-text-dim italic">{notes}</p>
      )}
    </li>
  );
}

function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
