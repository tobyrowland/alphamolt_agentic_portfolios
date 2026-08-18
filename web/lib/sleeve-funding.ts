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
