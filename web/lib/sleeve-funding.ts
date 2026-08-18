/**
 * Pure planner for in-kind sleeve funding — the TS twin of
 * `sleeves.plan_in_kind` (keep the two in lock-step).
 *
 * Funding $total from a source sleeve: spare cash first (up to total), then a
 * proportional slice of every priced position for the remainder. Legs worth
 * under $1 are dropped as dust; `plannedTotal` reports what the plan actually
 * moves so callers can refuse when the source simply isn't worth enough,
 * rather than part-funding by surprise.
 *
 * Pure module (no DB, no server-only imports) so it stays unit-testable and
 * importable from the "use server" mutations file.
 */

export type SourceHolding = {
  ticker: string;
  quantity: number;
  avgCost: number | null;
  price: number | null;
};

export type InKindMove = {
  ticker: string;
  qty: number;
  avgCost: number;
  /** qty × current price at plan time — informational. */
  approxValue: number;
};

export type InKindPlan = {
  cashMove: number;
  shareMoves: InKindMove[];
  /** cashMove + Σ approxValue — compare against the requested total. */
  plannedTotal: number;
};

const MIN_LEG_USD = 1.0;

export function planInKindFunding(
  sourceCash: number,
  holdings: SourceHolding[],
  total: number,
): InKindPlan {
  const want = round2(total);
  const cashMove = round2(Math.min(Math.max(sourceCash, 0), want));
  const remainder = round2(want - cashMove);
  if (remainder <= 0) {
    return { cashMove, shareMoves: [], plannedTotal: cashMove };
  }

  const priced = holdings.filter(
    (h) => h.quantity > 0 && h.price != null && h.price > 0,
  );
  const holdingsValue = priced.reduce(
    (s, h) => s + h.quantity * (h.price as number),
    0,
  );
  if (holdingsValue <= 0) {
    return { cashMove, shareMoves: [], plannedTotal: cashMove };
  }

  const fraction = Math.min(remainder / holdingsValue, 1);
  const shareMoves: InKindMove[] = [];
  for (const h of [...priced].sort((a, b) => a.ticker.localeCompare(b.ticker))) {
    const price = h.price as number;
    const qty = Math.round(h.quantity * fraction * 10000) / 10000;
    const value = round2(qty * price);
    if (qty <= 0 || value < MIN_LEG_USD) continue;
    shareMoves.push({
      ticker: h.ticker,
      qty,
      avgCost: Math.round((h.avgCost ?? price) * 10000) / 10000,
      approxValue: value,
    });
  }

  const plannedTotal = round2(
    cashMove + shareMoves.reduce((s, m) => s + m.approxValue, 0),
  );
  return { cashMove, shareMoves, plannedTotal };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Split planning — "how much should each strategy run?" → concrete moves
// ---------------------------------------------------------------------------

export type SplitRow = {
  portfolioId: string;
  /** Current worth: cash allowance + holdings value. */
  current: number;
  /** Owner-entered target worth. */
  target: number;
};

export type SplitMove = { fromPortfolioId: string; toPortfolioId: string; amount: number };

/**
 * Turn per-sleeve targets into pairwise moves: sleeves over target give,
 * sleeves under target receive, matched greedily largest-first. Deltas under
 * $1 are ignored as noise. Pure; targets are assumed to sum to (about) the
 * same total as `current` — the caller validates that before planning.
 */
export function planSplitMoves(rows: SplitRow[]): SplitMove[] {
  const givers = rows
    .map((r) => ({ id: r.portfolioId, amt: round2(r.current - r.target) }))
    .filter((g) => g.amt > 1)
    .sort((a, b) => b.amt - a.amt);
  const takers = rows
    .map((r) => ({ id: r.portfolioId, amt: round2(r.target - r.current) }))
    .filter((t) => t.amt > 1)
    .sort((a, b) => b.amt - a.amt);

  const moves: SplitMove[] = [];
  let gi = 0;
  let ti = 0;
  while (gi < givers.length && ti < takers.length) {
    const step = round2(Math.min(givers[gi].amt, takers[ti].amt));
    if (step > 1) {
      moves.push({
        fromPortfolioId: givers[gi].id,
        toPortfolioId: takers[ti].id,
        amount: step,
      });
    }
    givers[gi].amt = round2(givers[gi].amt - step);
    takers[ti].amt = round2(takers[ti].amt - step);
    if (givers[gi].amt <= 1) gi++;
    if (takers[ti].amt <= 1) ti++;
  }
  return moves;
}
