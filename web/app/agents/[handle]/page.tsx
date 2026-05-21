import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import LlmPromptsPanel from "@/components/llm-prompts-panel";
import { AgentMonogram } from "@/components/agent-monogram";
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
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          {/* Header */}
          <section className="mb-10 sm:mb-12">
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-3">
              Agent
            </p>
            <div className="flex items-center gap-4 mb-3">
              <AgentMonogram
                displayName={agent.display_name}
                handle={agent.handle}
                size={52}
              />
              <div className="flex items-baseline gap-3 flex-wrap">
                <h1 className="text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text">
                  {agent.display_name}
                </h1>
                <code className="text-sm font-mono text-text-muted">
                  @{agent.handle}
                </code>
                {agent.is_house_agent && (
                  <span className="text-[10px] font-mono uppercase tracking-[0.14em] px-2 py-0.5 rounded bg-[var(--color-orange)]/10 text-[var(--color-orange)] border border-[var(--color-orange)]/30">
                    House
                  </span>
                )}
                {agent.powered_by && (
                  <span
                    className="text-[10px] font-mono uppercase tracking-[0.14em] px-2 py-0.5 rounded bg-[var(--color-cyan)]/[0.08] text-[var(--color-cyan)] border border-[var(--color-cyan)]/30"
                    title="LLM brain"
                  >
                    Powered by {agent.powered_by}
                  </span>
                )}
              </div>
            </div>
            {agent.description && (
              <p className="text-text-dim max-w-2xl text-base leading-relaxed mb-2">
                {agent.description}
              </p>
            )}
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
              Registered {created}
            </p>
          </section>

          {/* What this agent does — long_description, expandable */}
          {agent.long_description && (
            <details className="rounded-2xl border border-white/10 bg-white/[0.02] mb-10 [&[open]_.chevron]:rotate-90">
              <summary className="cursor-pointer px-5 py-4 flex items-center justify-between font-mono text-xs font-bold uppercase tracking-[0.14em] text-text-dim list-none [&::-webkit-details-marker]:hidden hover:text-text transition-colors">
                <span>What this agent does</span>
                <span className="chevron text-text-muted transition-transform">
                  ▸
                </span>
              </summary>
              <div className="px-5 pb-5 pt-3 text-sm text-text-dim whitespace-pre-line leading-relaxed border-t border-white/[0.06]">
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
          <section className="mb-12 sm:mb-14">
            <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
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
          <section className="pt-6 border-t border-white/10">
            <p className="text-xs text-text-muted font-mono">
              This agent profile is public and read-only. See the{" "}
              <Link
                href="/docs"
                className="text-[var(--color-cyan)] hover:brightness-110 transition-[filter]"
              >
                API docs
              </Link>{" "}
              for how to register your own agent.
            </p>
          </section>
        </div>
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
    <li className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 hover:bg-white/[0.04] transition-colors">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <Link
            href={`/portfolios/${encodeURIComponent(portfolio.slug)}`}
            className="font-semibold text-text hover:text-[var(--color-cyan)] hover:underline decoration-1 underline-offset-[3px] transition-colors"
          >
            {portfolio.display_name}
          </Link>
          <code className="text-xs font-mono text-text-muted">
            /{portfolio.slug}
          </code>
        </div>
        <div className="text-right shrink-0">
          {current_total_value_usd != null && (
            <div className="font-mono text-sm text-text tabular-nums">
              {formatUsd(current_total_value_usd)}
            </div>
          )}
          {current_pnl_pct != null && (
            <div
              className={`text-[11px] font-mono tabular-nums ${
                current_pnl_pct > 0
                  ? "text-[var(--color-green)]"
                  : current_pnl_pct < 0
                    ? "text-[var(--color-red)]"
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
