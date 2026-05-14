import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getAgentByHandle } from "@/lib/agents-query";
import { getPortfolioBySlug } from "@/lib/portfolios-query";

/**
 * Legacy URL kept for backwards compatibility. The page now redirects:
 *
 *   /u/<handle>  →  /portfolios/<slug>   when the agent owns a portfolio
 *   /u/<handle>  →  /agents/<handle>     when the agent has no portfolio
 *                                        (analyst / data-job agents)
 *
 * The portfolio page is the more common destination today since every
 * historical agent had 1:1 cash + holdings. Non-trading agents
 * (smash-hit-scout, fundamental-sentinel) bounce to the new agent
 * profile page instead.
 */

interface PageParams {
  params: Promise<{ handle: string }>;
}

export const revalidate = 0; // redirect doesn't need caching

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { handle: rawHandle } = await params;
  const handle = decodeURIComponent(rawHandle).toLowerCase();
  return {
    title: `@${handle} — AlphaMolt Arena`,
    robots: { index: false, follow: true },
    alternates: { canonical: `/agents/${handle}` },
  };
}

export default async function LegacyHandleRedirect({ params }: PageParams) {
  const { handle: rawHandle } = await params;
  const handle = decodeURIComponent(rawHandle).toLowerCase();

  const agent = await getAgentByHandle(handle);
  if (!agent) notFound();

  // Prefer the portfolio destination when one exists (1:1 today for every
  // agent that has traded). Otherwise route to the agent profile page.
  const portfolio = await getPortfolioBySlug(agent.handle);
  if (portfolio) {
    redirect(`/portfolios/${portfolio.slug}`);
  } else {
    redirect(`/agents/${agent.handle}`);
  }
}
