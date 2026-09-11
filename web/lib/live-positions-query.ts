import { getSupabase } from "@/lib/supabase";
import {
  type PositionRow,
  positionsSummary,
  sleevePositions,
  targetWeights,
} from "@/lib/live-positions";

/**
 * Per-sleeve positions for the /live console.
 *
 * Kept separate from `live-cash-query.ts` on purpose: that module is the cash
 * console and says so ("not the MTM of record"). This one answers a different
 * question — what is actually held, against what the paper book wants — and
 * the /account hub does not need it, so it is not loaded there.
 *
 * Owner-only data. Callers pass sleeve ids they have already verified belong
 * to the signed-in user; nothing here re-opens that question.
 */

export type SleevePositions = {
  portfolioId: string;
  /** Equity the weights are measured against: allowance + own holdings. */
  equity: number;
  rows: PositionRow[];
  summary: ReturnType<typeof positionsSummary>;
  /** False when the sleeve follows no paper book — every target is unknown,
   *  not zero, so the table must not claim the whole book should be sold. */
  hasPaperBook: boolean;
  /** As-of stamp for the prices behind every figure on the page. */
  pricedAt: string | null;
};

type SleeveInput = {
  portfolioId: string;
  followsPortfolioId: string | null;
  allowance: number;
};

/**
 * Assemble the positions view for a set of sleeves.
 *
 * One round trip per table rather than per sleeve: holdings for the sleeves
 * and their paper books come back together, prices in one `securities` read.
 */
export async function getLivePositions(
  sleeves: SleeveInput[],
): Promise<Map<string, SleevePositions>> {
  const out = new Map<string, SleevePositions>();
  if (sleeves.length === 0) return out;

  const supabase = getSupabase();
  const sleeveIds = sleeves.map((s) => s.portfolioId);
  const paperIds = [
    ...new Set(
      sleeves
        .map((s) => s.followsPortfolioId)
        .filter((id): id is string => id != null),
    ),
  ];

  const [holdingsRes, accountsRes] = await Promise.all([
    supabase
      .from("portfolio_holdings")
      .select("portfolio_id, ticker, quantity")
      .in("portfolio_id", [...sleeveIds, ...paperIds]),
    paperIds.length > 0
      ? supabase
          .from("portfolio_accounts")
          .select("portfolio_id, cash_usd")
          .in("portfolio_id", paperIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (holdingsRes.error) {
    console.error("live-positions: holdings read failed:", holdingsRes.error);
    return out;
  }

  const holdings = (holdingsRes.data ?? []) as {
    portfolio_id: string;
    ticker: string;
    quantity: number | string;
  }[];

  // Price every ticker once, from the Level 0 price layer — the same column
  // portfolio.ts marks holdings at, so the console can never disagree with the
  // portfolio pages about what a position is worth.
  const tickers = [...new Set(holdings.map((h) => h.ticker))];
  const price = new Map<string, number>();
  let pricedAt: string | null = null;
  if (tickers.length > 0) {
    const { data } = await supabase
      .from("securities")
      .select("ticker, price, updated_at")
      .in("ticker", tickers);
    for (const s of (data ?? []) as {
      ticker: string;
      price: number | string | null;
      updated_at: string | null;
    }[]) {
      const px = s.price == null ? NaN : Number(s.price);
      if (Number.isFinite(px)) price.set(s.ticker, px);
      if (s.updated_at && (pricedAt == null || s.updated_at > pricedAt)) {
        pricedAt = s.updated_at;
      }
    }
  }

  const paperCash = new Map<string, number>();
  for (const a of (accountsRes.data ?? []) as {
    portfolio_id: string;
    cash_usd: number | string | null;
  }[]) {
    paperCash.set(a.portfolio_id, Number(a.cash_usd ?? 0));
  }

  const byPortfolio = new Map<string, typeof holdings>();
  for (const h of holdings) {
    const list = byPortfolio.get(h.portfolio_id) ?? [];
    list.push(h);
    byPortfolio.set(h.portfolio_id, list);
  }

  for (const sleeve of sleeves) {
    const own = (byPortfolio.get(sleeve.portfolioId) ?? []).map((h) => ({
      ticker: h.ticker,
      quantity: Number(h.quantity),
      price: price.get(h.ticker) ?? 0,
    }));
    const equity =
      sleeve.allowance +
      own.reduce((s, h) => s + h.quantity * h.price, 0);

    const paperId = sleeve.followsPortfolioId;
    const targets = paperId
      ? targetWeights(
          (byPortfolio.get(paperId) ?? []).map((h) => ({
            ticker: h.ticker,
            marketValue: Number(h.quantity) * (price.get(h.ticker) ?? 0),
          })),
          paperCash.get(paperId) ?? 0,
        )
      : new Map<string, number>();

    const rows = sleevePositions(own, equity, targets);
    out.set(sleeve.portfolioId, {
      portfolioId: sleeve.portfolioId,
      equity,
      rows,
      summary: positionsSummary(rows),
      hasPaperBook: paperId != null,
      pricedAt,
    });
  }
  return out;
}
