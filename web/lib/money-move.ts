/**
 * Moving money between the buckets of one live broker account.
 *
 * The hub used to offer three different operations with three mental models:
 * percentage steppers that re-split between strategies (a *target*, applied in
 * a second step, which moved the strategies you didn't touch), a Credit box
 * that brought money in from the unassigned pot, and a Debit box that sent it
 * back. Two of the three were hidden behind a disclosure, and the always-
 * visible one was the most complicated.
 *
 * They are all the same act: take an amount out of one bucket and put it in
 * another. The unassigned pot is simply a bucket that no strategy trades. So
 * the UI offers one verb — from, to, amount — and this module decides which of
 * the three existing server actions carries it out.
 *
 * Pure: no server actions, no React, no fetch (pinned in tests/test_money_move.py).
 */

/** The id of the pot no strategy trades. Not a portfolio, so not a UUID. */
export const UNASSIGNED_ID = "unassigned";

export type Bucket = {
  id: string;
  name: string;
  /** Everything the bucket holds: cash allowance plus positions at market. */
  value: number;
  /** The cash part. For the pot, all of it. */
  cash: number;
};

export type MoveRoute =
  | { kind: "credit"; portfolioId: string }
  | { kind: "debit"; portfolioId: string }
  | { kind: "transfer"; fromPortfolioId: string; toPortfolioId: string };

/**
 * Which server action carries a move, or null when there is nothing to carry.
 *
 * Deliberately total over the four combinations rather than assuming the UI
 * filters them: pot→pot and strategy→itself are no-ops, and returning null for
 * them keeps that judgement in one tested place instead of in a disabled-button
 * expression.
 */
export function routeMove(fromId: string, toId: string): MoveRoute | null {
  if (!fromId || !toId || fromId === toId) return null;
  if (fromId === UNASSIGNED_ID) return { kind: "credit", portfolioId: toId };
  if (toId === UNASSIGNED_ID) return { kind: "debit", portfolioId: fromId };
  return { kind: "transfer", fromPortfolioId: fromId, toPortfolioId: toId };
}

/**
 * The most that can leave `from` on its way to `to`, right now.
 *
 * Not one number, because the ceiling is a property of the ROUTE, not of the
 * bucket:
 *
 *  - out of the pot — all of it; it is cash by definition.
 *  - strategy → pot — its CASH only. Freeing money that is currently in shares
 *    would mean selling them, and a cash movement must never quietly become a
 *    trade (`live_cash` enforces the same bound server-side).
 *  - strategy → strategy — its whole value. This route moves shares in kind
 *    (migration 084): cash first, then a proportional slice of the positions,
 *    with nothing traded, so the ceiling is the sleeve's equity rather than its
 *    cash.
 *
 * A UI that offered one ceiling for all three would either forbid legitimate
 * in-kind moves or promise sales it will not make.
 */
export function maxMovable(from: Bucket, to: Bucket): number {
  const route = routeMove(from.id, to.id);
  if (!route) return 0;
  const ceiling = route.kind === "debit" ? from.cash : from.value;
  return Math.max(0, round2(ceiling));
}

/**
 * Why this move cannot be made, in the owner's words, or null when it can.
 *
 * Stated before submitting. Every one of these is also enforced server-side —
 * this is not the guard, it is the explanation that saves a round trip and a
 * refusal the owner has to interpret.
 */
export function moveRefusal(
  from: Bucket | null,
  to: Bucket | null,
  amount: number,
): string | null {
  if (!from || !to) return "Pick where the money comes from and where it goes.";
  if (from.id === to.id) return "Pick two different places.";
  if (!Number.isFinite(amount) || amount <= 0) return null; // nothing typed yet
  const ceiling = maxMovable(from, to);
  if (ceiling <= 0) {
    return to.id === UNASSIGNED_ID
      ? `${from.name} holds no spare cash — its money is in shares.`
      : `${from.name} has nothing to move.`;
  }
  if (amount > ceiling) {
    return to.id === UNASSIGNED_ID && from.id !== UNASSIGNED_ID
      ? `${from.name} has ${money(ceiling)} in cash — the rest is in shares, which this won't sell.`
      : `${from.name} only has ${money(ceiling)}.`;
  }
  return null;
}

/**
 * Both sides of the move, before and after — the thing the old UI never showed.
 *
 * Only the two buckets involved: a move never touches the others, and listing
 * them unchanged would imply it might.
 */
export function previewAfter(
  from: Bucket,
  to: Bucket,
  amount: number,
): { id: string; name: string; before: number; after: number }[] {
  if (!Number.isFinite(amount) || amount <= 0) return [];
  if (!routeMove(from.id, to.id)) return [];
  return [
    { id: from.id, name: from.name, before: from.value, after: round2(from.value - amount) },
    { id: to.id, name: to.name, before: to.value, after: round2(to.value + amount) },
  ];
}

/**
 * What actually happens at the broker — which is nothing, on every route.
 *
 * Worth saying on the screen. The owner is moving real money inside a real
 * account and reasonably expects that to mean something is bought or sold; on
 * every one of these routes it does not, and the difference between "assigned"
 * and "invested" is the single thing most likely to be misread here.
 */
export function moveExplainer(from: Bucket, to: Bucket): string {
  const route = routeMove(from.id, to.id);
  if (!route) return "";
  if (route.kind === "credit") {
    return `Nothing is bought or sold. ${to.name} spends it on its next sync.`;
  }
  if (route.kind === "debit") {
    return `Nothing is sold. The cash stops being ${from.name}'s to spend.`;
  }
  return (
    `Nothing is traded. Cash moves first, then a slice of ${from.name}'s ` +
    `shares — ${to.name} trades them into its own picks on its next sync.`
  );
}

/**
 * The headline: how much money, and what that figure actually covers.
 *
 * When the broker balance cannot be read, the unassigned pot is unknown, so
 * the ACCOUNT total is unknown too — only what the strategies hold is. Saying
 * "$X at your broker" then states a number that is short by an unknown amount.
 * The same failure as everything else fixed on this screen: asserting a fact
 * the page does not have.
 */
export function accountHeadline(
  strategiesTotal: number,
  unallocated: number | null,
): { amount: number; caption: string } {
  if (unallocated == null) {
    return { amount: round2(strategiesTotal), caption: "in your strategies" };
  }
  return {
    amount: round2(strategiesTotal + unallocated),
    caption: "at your broker",
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
