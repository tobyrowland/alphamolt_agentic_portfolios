/**
 * What a hired agent's strategy does with the portfolio's screen.
 *
 * Keyed off `agents.strategy`, never the display name or the `action` /
 * role tag: `double_down` and `pelosi_mirror` are both tagged buy/buyer, yet
 * neither ever sees the screen — one re-reads the book's own holdings, the
 * other a congressional disclosure feed, and both run BEFORE the snake draft
 * (`agent_strategies.SELF_SOURCED_BUYER_STRATEGIES`). Any surface that
 * describes "where the positions came from" and lumps them in with the screen
 * buyer misdescribes the book in a way a reader cannot detect from the
 * holdings.
 *
 * Shared so the review pack (`portfolio-export-query.ts`) and the public
 * Universe summary (`portfolio-universe.ts`) cannot drift into two different
 * answers about the same agent. A strategy absent from every list degrades to
 * "other", which callers list by name rather than describe wrongly.
 *
 * Pure: no imports, no DB — safe on the client and in the type-stripped tests.
 */

/** Self-sourced buyers, mapped to the feed each one actually reads. */
export const SELF_SOURCED_BUYERS: Record<string, string> = {
  double_down: "the portfolio's own current holdings",
  pelosi_mirror: "a member of Congress's disclosed trades",
};

/** Buyers that draft from the portfolio's screen (top N of the re-rank). */
export const SCREEN_BUYER_STRATEGIES = new Set([
  "llm_watchlist_buyer",
  "watchlist_buyer",
  "ma_sniper",
]);

export const REVIEWER_STRATEGIES = new Set(["portfolio_reviewer"]);

/**
 * Buyers that put each candidate to an LLM one name at a time.
 *
 * Cuts across `StrategyKind`: `double_down` is self-sourced and
 * `llm_watchlist_buyer` drafts from the screen, but both run the same
 * per-name evaluation, and the mechanical buyers in `SCREEN_BUYER_STRATEGIES`
 * (`watchlist_buyer`, `ma_sniper`) run none. Anything describing that call —
 * what it is told, what a PASS costs — is true of exactly this set, so kind
 * alone is the wrong test in both directions.
 */
export const PER_NAME_LLM_BUYERS = new Set([
  "llm_watchlist_buyer",
  "double_down",
]);

export function judgesPerName(strategy: string | null | undefined): boolean {
  return !!strategy && PER_NAME_LLM_BUYERS.has(strategy);
}

export type StrategyKind =
  | "screen-buyer"
  | "self-sourced-buyer"
  | "reviewer"
  | "other";

export function strategyKind(strategy: string | null | undefined): StrategyKind {
  if (!strategy) return "other";
  if (strategy in SELF_SOURCED_BUYERS) return "self-sourced-buyer";
  if (SCREEN_BUYER_STRATEGIES.has(strategy)) return "screen-buyer";
  if (REVIEWER_STRATEGIES.has(strategy)) return "reviewer";
  return "other";
}

/** True only for agents that actually pick from the screen's ranked top N. */
export function draftsFromScreen(strategy: string | null | undefined): boolean {
  return strategyKind(strategy) === "screen-buyer";
}
