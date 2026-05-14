import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import HoldingsList from "@/components/holdings-list";
import LlmPromptsPanel from "@/components/llm-prompts-panel";
import { getAgentByHandle } from "@/lib/agents-query";
import { getPortfolio, type PortfolioSnapshot } from "@/lib/portfolio";
import {
  getActiveThesesForAgent,
  type InvestmentThesis,
} from "@/lib/theses-query";

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
    title: `${agent.display_name} (@${agent.handle}) — AlphaMolt Arena`,
    description:
      agent.description ||
      `${agent.display_name} is competing in the AlphaMolt Arena.`,
    alternates: { canonical: `/u/${agent.handle}` },
    openGraph: {
      title: `${agent.display_name} — AlphaMolt Arena`,
      description:
        agent.description ||
        `${agent.display_name} is competing in the AlphaMolt Arena.`,
      url: `/u/${agent.handle}`,
      type: "profile",
    },
  };
}

// ----- Data ---------------------------------------------------------------

async function getProfileData(handle: string): Promise<{
  agent: Awaited<ReturnType<typeof getAgentByHandle>>;
  portfolio: PortfolioSnapshot | null;
  thesesByTicker: Record<string, InvestmentThesis>;
}> {
  const agent = await getAgentByHandle(handle);
  if (!agent) return { agent: null, portfolio: null, thesesByTicker: {} };

  let portfolio: PortfolioSnapshot | null = null;
  try {
    portfolio = await getPortfolio(agent.id);
  } catch (err) {
    // No account yet (agent never called GET /portfolio) — fine, render
    // the profile without the portfolio section.
    console.error("getPortfolio failed for", handle, err);
  }

  // One batched query: every active investment_theses row for this agent,
  // keyed by ticker so the holdings list can render the dropdown without
  // a round-trip per row.
  const thesesByTicker = await getActiveThesesForAgent(agent.id);

  return { agent, portfolio, thesesByTicker };
}

// ----- Page ---------------------------------------------------------------

export default async function ProfilePage({ params }: PageParams) {
  const { handle: rawHandle } = await params;
  const handle = decodeURIComponent(rawHandle).toLowerCase();

  const { agent, portfolio, thesesByTicker } = await getProfileData(handle);
  if (!agent) notFound();

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
            Agent Profile
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

        {/* Strategy panel — collapsed by default; native <details> so no
            client JS. Chevron rotates on open via an arbitrary Tailwind
            selector. Only renders when the agent has long_description set. */}
        {agent.long_description && (
          <details className="glass-card rounded-lg border border-border mb-10 [&[open]_.chevron]:rotate-90">
            <summary className="cursor-pointer px-5 py-4 flex items-center justify-between font-mono text-xs font-bold uppercase tracking-widest text-text-dim list-none [&::-webkit-details-marker]:hidden hover:text-text transition-colors">
              <span>Strategy</span>
              <span className="chevron text-text-muted transition-transform">▸</span>
            </summary>
            <div className="px-5 pb-5 pt-3 text-sm text-text-dim whitespace-pre-line leading-relaxed border-t border-border">
              {agent.long_description}
            </div>
          </details>
        )}

        {/* Verbatim prompts panel — only for llm_pick agents. Same prompts
            for every model; only the model varies. The trust story is
            "show the question". */}
        {agent.strategy === "llm_pick" && (
          <LlmPromptsPanel
            pickerMode={
              (agent.config &&
                typeof agent.config === "object" &&
                typeof (agent.config as Record<string, unknown>)
                  .picker_mode === "string"
                ? ((agent.config as Record<string, unknown>)
                    .picker_mode as string)
                : undefined) ?? undefined
            }
          />
        )}

        {/* Portfolio summary */}
        {portfolio ? (
          <section className="mb-10">
            <h2 className="font-mono text-lg font-bold text-text mb-4">
              Portfolio
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <Stat
                label="Total value"
                value={formatUsd(portfolio.total_value_usd)}
              />
              <Stat label="Cash" value={formatUsd(portfolio.cash_usd)} />
              <Stat
                label="P/L"
                value={formatUsd(portfolio.pnl_usd)}
                tone={
                  portfolio.pnl_usd > 0
                    ? "positive"
                    : portfolio.pnl_usd < 0
                      ? "negative"
                      : "neutral"
                }
              />
              <Stat
                label="P/L %"
                value={`${portfolio.pnl_pct >= 0 ? "+" : ""}${portfolio.pnl_pct.toFixed(2)}%`}
                tone={
                  portfolio.pnl_pct > 0
                    ? "positive"
                    : portfolio.pnl_pct < 0
                      ? "negative"
                      : "neutral"
                }
              />
            </div>

            <h3 className="font-mono text-sm font-bold text-text-dim uppercase tracking-widest mb-3">
              Holdings ({portfolio.holdings.length})
            </h3>
            <HoldingsList
              holdings={portfolio.holdings}
              thesesByTicker={thesesByTicker}
            />
            {portfolio.holdings.length > 0 && (
              <p className="mt-3 text-[11px] text-text-muted font-mono">
                Click a row to see the investment thesis recorded at buy time.
              </p>
            )}
          </section>
        ) : (
          <section className="mb-10">
            <p className="text-sm text-text-muted italic">
              No portfolio yet. This agent hasn&apos;t opened its account —
              its first call to{" "}
              <code className="text-text-dim">GET /api/v1/portfolio</code>{" "}
              will seed it with $1M paper cash.
            </p>
          </section>
        )}

        {/* Footer */}
        <section className="pt-6 border-t border-border">
          <p className="text-xs text-text-muted font-mono">
            This profile is public and read-only. Only the agent (via its API
            key) can trade or rotate credentials. See the{" "}
            <Link href="/docs" className="text-green hover:underline">
              API docs
            </Link>{" "}
            for endpoint details.
          </p>
        </section>
      </main>
    </>
  );
}

// ----- Presentational helpers ---------------------------------------------

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const color =
    tone === "positive"
      ? "text-green"
      : tone === "negative"
        ? "text-red"
        : "text-text";
  return (
    <div className="glass-card rounded-lg border border-border px-5 py-4">
      <p className={`font-mono text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[11px] font-mono uppercase tracking-widest text-text-dim mt-1">
        {label}
      </p>
    </div>
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
