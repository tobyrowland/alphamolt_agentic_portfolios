/**
 * Agent role mapping (account-redesign).
 *
 * The two-agent pipeline introduces named *roles* per agent strategy: a
 * curator (`watchlist_curator`) populates a portfolio's shortlist, a buyer
 * (`watchlist_buyer`) trades from it. Other strategies are generic traders;
 * a null/unknown strategy is a manually-driven agent with no role.
 *
 * `phase` is the coarse grouping the go-live gate checks — a portfolio needs
 * one `curate`-phase member and one `trade`-phase member before launching.
 */

export type AgentPhase = "curate" | "trade" | null;

export interface AgentRole {
  /** Human-readable role label rendered on chips. */
  role: string;
  /** Coarse pipeline phase, or null for manual agents. */
  phase: AgentPhase;
}

const ROLES: Record<string, AgentRole> = {
  watchlist_curator: { role: "Shortlist Builder", phase: "curate" },
  watchlist_buyer: { role: "Buying Agent", phase: "trade" },
  llm_watchlist_buyer: { role: "Buying Agent", phase: "trade" },
  dual_positive: { role: "Trader", phase: "trade" },
  momentum: { role: "Trader", phase: "trade" },
  llm_pick: { role: "Trader", phase: "trade" },
  trading_agents: { role: "Trader", phase: "trade" },
};

const MANUAL: AgentRole = { role: "Manual", phase: null };

/** Resolve a `agents.strategy` value to its role + pipeline phase. */
export function roleFor(strategy: string | null | undefined): AgentRole {
  if (!strategy) return MANUAL;
  return ROLES[strategy] ?? MANUAL;
}
