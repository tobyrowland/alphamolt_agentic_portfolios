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

// ---------------------------------------------------------------------------
// Allocation — the split expressed as proportions
// ---------------------------------------------------------------------------

/**
 * The owner's intent is a proportion ("this strategy runs a third of the
 * account"), not a dollar figure, and typing dollars made them do the
 * balancing arithmetic by hand — workable with two strategies, hopeless with
 * five. These helpers hold the invariant instead: the allocation always sums
 * to 100%, so there is no such thing as an unbalanced edit to refuse.
 *
 * Pure and rounding-exact; `tests/test_split_allocation.py` pins them.
 */

/** Percentages the current worths represent. Sums to 100 (0 when empty). */
export function currentAllocation(currents: number[]): number[] {
  const total = currents.reduce((s, c) => s + c, 0);
  if (total <= 0) return currents.map(() => 0);
  return normalize(currents.map((c) => (c / total) * 100));
}

/**
 * Set one strategy's share and let the others absorb the difference pro rata,
 * so the total stays exactly 100%. The edited index keeps precisely the number
 * that was typed — any rounding residual is pushed onto the largest of the
 * others, never onto the field under the cursor.
 */
export function rebalanceAllocation(
  pcts: number[],
  index: number,
  next: number,
): number[] {
  if (pcts.length === 0) return [];
  const target = clamp(next, 0, 100);
  if (pcts.length === 1) return [100];

  const out = pcts.slice();
  out[index] = target;
  const remaining = 100 - target;
  const otherIdx = pcts.map((_, i) => i).filter((i) => i !== index);
  const othersSum = otherIdx.reduce((s, i) => s + Math.max(pcts[i], 0), 0);

  if (othersSum <= 0) {
    // Everything else is at zero — nothing to scale, so share the remainder
    // out equally rather than leaving the allocation short of 100%.
    const each = remaining / otherIdx.length;
    for (const i of otherIdx) out[i] = each;
  } else {
    for (const i of otherIdx) {
      out[i] = (Math.max(pcts[i], 0) / othersSum) * remaining;
    }
  }
  return normalize(out, index);
}

/**
 * Percentages → dollar targets against the pot. The residual from rounding to
 * cents lands on the largest target, so the targets sum to `total` exactly and
 * the server's "a split redistributes the pot, it can't resize it" check can
 * never trip on our own rounding.
 */
export function allocationToTargets(pcts: number[], total: number): number[] {
  const targets = pcts.map((p) => round2((p / 100) * total));
  if (targets.length === 0) return targets;
  const residual = round2(total - targets.reduce((s, t) => s + t, 0));
  if (residual !== 0) {
    let biggest = 0;
    for (let i = 1; i < targets.length; i++) {
      if (targets[i] > targets[biggest]) biggest = i;
    }
    targets[biggest] = round2(targets[biggest] + residual);
  }
  return targets;
}

export type SleeveImpact = {
  portfolioId: string;
  /** Signed change in what this strategy runs. */
  delta: number;
  /** How much of that travels as cash (always ≤ |delta|). */
  cash: number;
  /** The remainder, which travels as share records and owes a restructure. */
  positions: number;
};

/**
 * What a set of targets actually does to each strategy, in the two currencies
 * the owner cares about: cash, and positions that will have to be traded into
 * the receiving strategy's own picks. Mirrors the execution order — spare cash
 * leaves a source before any of its shares do.
 */
export type SplitLeg = SplitMove & {
  /** Part of the move covered by the source's spare cash. */
  cash: number;
  /** Part that travels as share records, and owes a restructure. */
  positions: number;
};

export function splitImpact(
  rows: (SplitRow & { allowance: number })[],
): { legs: SplitLeg[]; impacts: Map<string, SleeveImpact> } {
  const moves = planSplitMoves(rows);
  const legs: SplitLeg[] = [];
  const impacts = new Map<string, SleeveImpact>(
    rows.map((r) => [
      r.portfolioId,
      { portfolioId: r.portfolioId, delta: 0, cash: 0, positions: 0 },
    ]),
  );
  const spare = new Map(rows.map((r) => [r.portfolioId, Math.max(r.allowance, 0)]));

  for (const m of moves) {
    const available = spare.get(m.fromPortfolioId) ?? 0;
    const cash = round2(Math.min(available, m.amount));
    const positions = round2(m.amount - cash);
    spare.set(m.fromPortfolioId, round2(available - cash));
    legs.push({ ...m, cash, positions });

    const from = impacts.get(m.fromPortfolioId);
    if (from) {
      from.delta = round2(from.delta - m.amount);
      from.cash = round2(from.cash - cash);
      from.positions = round2(from.positions - positions);
    }
    const to = impacts.get(m.toPortfolioId);
    if (to) {
      to.delta = round2(to.delta + m.amount);
      to.cash = round2(to.cash + cash);
      to.positions = round2(to.positions + positions);
    }
  }
  return { legs, impacts };
}

/** Round to 2dp and force the set to sum to exactly 100, sparing `keep`. */
function normalize(pcts: number[], keep = -1): number[] {
  const out = pcts.map((p) => Math.round(clamp(p, 0, 100) * 100) / 100);
  const residual = Math.round((100 - out.reduce((s, p) => s + p, 0)) * 100) / 100;
  if (residual === 0 || out.length === 0) return out;
  let target = -1;
  for (let i = 0; i < out.length; i++) {
    if (i === keep) continue;
    if (target === -1 || out[i] > out[target]) target = i;
  }
  if (target === -1) target = 0;
  out[target] = Math.round(clamp(out[target] + residual, 0, 100) * 100) / 100;
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
