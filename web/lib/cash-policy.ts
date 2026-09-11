/**
 * TypeScript twin of `cash_policy.py` (migration 088) — the owner-configured
 * cash policy for a portfolio's shared pot.
 *
 * `DEFAULTS` must match that module exactly: `setPortfolioCashPolicy` writes
 * the WHOLE object returned by `resolvePolicy`, so any key Python defines but
 * this side does not know about is silently DELETED the next time the owner
 * touches the panel — a data-loss bug with no error and no log. Pinned by
 * tests/test_cash_policy.py through tests/ts_cash_policy_runner.mjs.
 *
 * `reserve_pct` is a PERCENT of NAV (2.0 == 2%), not a fraction. Python owns
 * the single conversion to a fraction at the one call site that needs it.
 */

export interface CashPolicy {
  /** Percent of NAV the screen draft stops buying at, leaving the rest for
   *  buyers that run before it (e.g. Double-Down) on the next heartbeat. */
  reserve_pct: number;
}

/** 2.0 is exactly `snake_draft_plan`'s own pre-088 default, so an untouched
 *  portfolio behaves identically to how it did before the column existed. */
export const DEFAULTS: CashPolicy = {
  reserve_pct: 2.0,
};

export const MAX_RESERVE_PCT = 50;

/**
 * Overlay a stored (untrusted, owner-edited) value on the defaults.
 * Total: any bad shape or out-of-range value degrades to its default.
 */
export function resolvePolicy(raw: unknown): CashPolicy {
  const policy: CashPolicy = { ...DEFAULTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return policy;
  const source = raw as Record<string, unknown>;

  const pct = source.reserve_pct;
  if (typeof pct === "number" && Number.isFinite(pct)) {
    policy.reserve_pct = Math.max(0, Math.min(MAX_RESERVE_PCT, pct));
  }
  return policy;
}

/** True when the policy is exactly the defaults. */
export function isDefault(policy: CashPolicy): boolean {
  return policy.reserve_pct === DEFAULTS.reserve_pct;
}

/**
 * One line for the panel's collapsed header, plus whether the owner has moved
 * anything off the defaults. Same reasoning as the Sell discipline header:
 * collapsing must not hide a setting that is actively shaping what the agents
 * do, so the state is stated whether the panel is open or shut.
 *
 * The dollar figure is what makes this legible — "3%" means nothing until you
 * see it is $31,600, which is two Double-Down adds or half a new position.
 */
export function describeCashPolicy(
  policy: CashPolicy,
  totalValueUsd?: number | null,
): { summary: string; customised: boolean } {
  const pct = policy.reserve_pct;
  const nav = typeof totalValueUsd === "number" && totalValueUsd > 0
    ? totalValueUsd
    : null;
  const money = nav
    ? ` (${(nav * pct / 100).toLocaleString("en-US", {
        style: "currency", currency: "USD", maximumFractionDigits: 0,
      })})`
    : "";
  const summary = pct <= 0
    ? "no cash held back — the screen buyer may spend it all"
    : `${pct}% held back for other agents${money}`;
  return { summary, customised: !isDefault(policy) };
}
