/**
 * What each sleeve actually holds, and what the mirror will do about it.
 *
 * The live console used to show cash and nothing else, so answering "why is
 * there $103 of KRMN in my account?" meant opening the broker's own site and
 * then reading `alpaca_mirror.plan_mirror` to find out why no run had ever
 * sold it. Both answers are computable here.
 *
 * This is a TWIN of `plan_mirror`'s decision rule, not a re-imagining of it.
 * A positions table that used its own idea of "on target" would be one more
 * surface asserting something the system does not actually do — the failure
 * this console keeps having. So the thresholds and the arithmetic below are
 * the ones in alpaca_mirror.py, and `tests/test_live_positions.py` pins them
 * against that file's constants.
 *
 * Pure: no fetch, no React, no server actions.
 */

/** `alpaca_mirror.DEFAULT_THRESHOLD` — trade only past 1% of equity drift. */
export const MIRROR_THRESHOLD = 0.01;

/** `alpaca_mirror.MIN_ORDER_USD` — skip dust orders below $1 notional. */
export const MIN_ORDER_USD = 1.0;

export type PaperHolding = { ticker: string; marketValue: number };
export type SleeveHolding = { ticker: string; quantity: number; price: number };

export type PositionRow = {
  ticker: string;
  quantity: number;
  price: number;
  marketValue: number;
  /** Share of the SLEEVE's equity this position is today. */
  currentWeight: number;
  /** Share the paper book says it should be. 0 ⇒ not in the book at all. */
  targetWeight: number;
  /** targetWeight − currentWeight. Positive = underweight. */
  drift: number;
  /** What the next mirror run would do to this name, and why. */
  action: "buy" | "sell" | "hold";
  reason: "on_target" | "within_threshold" | "dust" | "would_trade";
  /** Dollar value of the order the mirror would place (0 when it would not). */
  orderValue: number;
  /** Held but absent from the paper book — target is zero by definition. */
  offBook: boolean;
};

/**
 * Target weights from the paper book, over its TOTAL value including cash.
 *
 * Including cash matters and is easy to get wrong: `plan_mirror` divides by
 * `paper_book.total_value_usd`, so a paper book sitting on 20% cash targets
 * 80% invested in the live sleeve too. Normalising over holdings alone would
 * overstate every target and make a converged sleeve look permanently
 * underweight.
 */
export function targetWeights(
  paperHoldings: PaperHolding[],
  paperCash: number,
): Map<string, number> {
  const holdingsValue = paperHoldings.reduce(
    (s, h) => s + (h.marketValue > 0 ? h.marketValue : 0),
    0,
  );
  const total = holdingsValue + paperCash;
  const out = new Map<string, number>();
  if (!(total > 0)) return out;
  for (const h of paperHoldings) {
    if (h.marketValue > 0) out.set(h.ticker, h.marketValue / total);
  }
  return out;
}

/**
 * One row per position, each carrying the mirror's verdict on it.
 *
 * `equity` is the SLEEVE's own equity (its allowance plus its own recorded
 * holdings) — never the broker account's aggregate. Sizing a sleeve off the
 * aggregate is what made two sleeves liquidate each other (migration 083), and
 * a table that displayed weights against the aggregate would quietly teach the
 * owner the wrong mental model even though it places no orders itself.
 */
export function sleevePositions(
  holdings: SleeveHolding[],
  equity: number,
  targets: Map<string, number>,
  { threshold = MIRROR_THRESHOLD, minOrderUsd = MIN_ORDER_USD } = {},
): PositionRow[] {
  const qtyByTicker = new Map(holdings.map((h) => [h.ticker, h]));
  const tickers = [
    ...new Set([...qtyByTicker.keys(), ...targets.keys()]),
  ].sort();

  const rows: PositionRow[] = [];
  for (const ticker of tickers) {
    const held = qtyByTicker.get(ticker);
    const quantity = held?.quantity ?? 0;
    const price = held?.price ?? 0;
    const marketValue = quantity * price;
    const targetWeight = targets.get(ticker) ?? 0;
    const currentWeight = equity > 0 ? marketValue / equity : 0;
    const drift = targetWeight - currentWeight;

    // Reproduce plan_mirror's own order test rather than approximating it.
    // It sizes in SHARES (`delta = round(target_qty - cur_qty, 4)`) and drops
    // the order when `|delta| * price < MIN_ORDER_USD`, so the share rounding
    // is part of the rule, not a detail. A name the book wants that the sleeve
    // has never held has no price here; its notional is still knowable, so it
    // is reported as a pending buy of that value.
    let action: PositionRow["action"] = "hold";
    let reason: PositionRow["reason"] = "on_target";
    let orderValue = 0;

    if (Math.abs(drift) <= threshold) {
      reason = drift === 0 ? "on_target" : "within_threshold";
    } else {
      const targetValue = targetWeight * equity;
      const notional =
        price > 0
          ? Math.abs(round4(targetValue / price - quantity)) * price
          : Math.abs(targetValue - marketValue);
      if (notional < minOrderUsd) {
        reason = "dust";
      } else {
        action = targetValue > marketValue ? "buy" : "sell";
        reason = "would_trade";
        orderValue = notional;
      }
    }

    if (quantity === 0 && targetWeight === 0) continue;

    rows.push({
      ticker,
      quantity,
      price,
      marketValue,
      currentWeight,
      targetWeight,
      drift,
      action,
      reason,
      orderValue,
      offBook: quantity > 0 && targetWeight === 0,
    });
  }
  return rows;
}

/**
 * The one-line summary above the table.
 *
 * Counts what the owner is actually deciding about: names the mirror will move
 * on its next run, and names it will never move on its own — the second being
 * the category KRMN fell into and that nothing on the old console named.
 */
export function positionsSummary(rows: PositionRow[]): {
  count: number;
  invested: number;
  wouldTrade: number;
  strandedValue: number;
  strandedCount: number;
} {
  let invested = 0;
  let wouldTrade = 0;
  let strandedValue = 0;
  let strandedCount = 0;
  for (const r of rows) {
    invested += r.marketValue;
    if (r.reason === "would_trade") wouldTrade += 1;
    // Off the paper book AND below the threshold: the mirror wants it gone but
    // will never be the thing that removes it.
    if (r.offBook && r.reason !== "would_trade") {
      strandedValue += r.marketValue;
      strandedCount += 1;
    }
  }
  return {
    count: rows.filter((r) => r.quantity > 0).length,
    invested,
    wouldTrade,
    strandedValue,
    strandedCount,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
