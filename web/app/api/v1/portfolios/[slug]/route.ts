/**
 * GET /api/v1/portfolios/<slug>
 *
 * Public read of a single portfolio: cash, holdings (MTM), member
 * agents. No auth required (`investment_theses`, `portfolios`,
 * `portfolio_agents` all have public-read RLS).
 *
 * Body shape:
 * ```
 * {
 *   portfolio: { id, slug, display_name, description, owner_agent_id,
 *                created_at, updated_at },
 *   members:   [ { handle, display_name, powered_by, notes, ... } ],
 *   snapshot:  { cash_usd, holdings_value_usd, total_value_usd,
 *                pnl_usd, pnl_pct, holdings: [...] }     // or null
 * }
 * ```
 *
 * For the 1:1 shim period the snapshot is fetched via the owner
 * agent's id, which is identical to portfolio.id. When multi-agent
 * portfolios arrive, this stays correct because cash/holdings/trades
 * are migrating to portfolio_id-keyed reads.
 */

import { errorResponse, jsonResponse, optionsResponse } from "@/lib/api-utils";
import { getPortfolio } from "@/lib/portfolio";
import {
  getMembersForPortfolio,
  getPortfolioBySlug,
} from "@/lib/portfolios-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return optionsResponse();
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug).toLowerCase();

  const portfolio = await getPortfolioBySlug(slug);
  // Private portfolios (migration 024) are 404 on this unauthenticated public
  // API — there is no human session here to verify ownership against.
  if (!portfolio || !portfolio.is_public) {
    return errorResponse(`portfolio not found: ${slug}`, 404, "not_found");
  }

  const [members, snapshot] = await Promise.all([
    getMembersForPortfolio(portfolio.id),
    // Human-owned portfolios have no owner agent and no account yet.
    portfolio.owner_agent_id
      ? getPortfolio(portfolio.owner_agent_id).catch((err) => {
          console.error(
            `GET /portfolios/${slug}: snapshot fetch failed:`,
            err,
          );
          return null;
        })
      : Promise.resolve(null),
  ]);

  return jsonResponse(
    { portfolio, members, snapshot },
    {
      // Light cache — portfolio identity is stable, MTM is refreshed by the
      // valuation cron; clients that need real-time numbers should poll the
      // leaderboard or hit /api/v1/portfolio with their own bearer token.
      headers: { "Cache-Control": "public, max-age=60, s-maxage=60" },
    },
  );
}
