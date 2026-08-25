/**
 * Owner-configured sell discipline — client-safe types + defaults.
 *
 * TypeScript twin of `thesis_policy.py`, kept in lock-step: `DEFAULTS` and
 * `RELATIVE_FIELDS` must match that module exactly, since the Python side is
 * what actually enforces the rules at heartbeat time and this side only
 * renders and saves them.
 *
 * Stored on `portfolios.thesis_policy` (migration 086). Portfolio-level rather
 * than per-agent because the BUYER authors break signals and the REVIEWER
 * enforces them — a knob on either alone could not bind both.
 */

export interface ThesisPolicy {
  /** The reviewer ignores positions younger than this. 0 disables. */
  grace_period_days: number;
  /** A SELL needs a break signal that is actually firing. */
  require_fired_break_signal: boolean;
  /** Price-relative fields may only carry change-since-buy operators. */
  relative_fields_change_only: boolean;
  /**
   * Sells before this instant are exempt from the 90-day re-buy cooldown.
   * ISO-8601, or null for no exemption.
   *
   * NOT rendered by the Sell discipline panel — it is an operator-set,
   * self-expiring correction, not a standing preference. It lives in this type
   * purely so `resolvePolicy` CARRIES it: the save action writes the whole
   * resolved object, so a key this side did not know about would be silently
   * dropped the next time the owner touched the panel. Python validates it
   * (including rejecting a future date); this side only passes it through.
   */
  rebuy_cooldown_ignores_sells_before: string | null;
}

export const DEFAULTS: ThesisPolicy = {
  grace_period_days: 30,
  require_fired_break_signal: true,
  relative_fields_change_only: true,
  rebuy_cooldown_ignores_sells_before: null,
};

export const MAX_GRACE_DAYS = 365;

/** Fields whose value is a function of the share price. Mirrors Python. */
export const RELATIVE_FIELDS = [
  "perf_52w_vs_spy",
  "price_pct_of_52w_high",
  "price",
  "ps_now",
  "composite_score",
] as const;

/**
 * Overlay a stored (untrusted, owner-edited) value on the defaults.
 * Total: any bad shape or out-of-range value degrades to its default.
 */
export function resolvePolicy(raw: unknown): ThesisPolicy {
  const policy: ThesisPolicy = { ...DEFAULTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return policy;
  const source = raw as Record<string, unknown>;

  const days = source.grace_period_days;
  if (typeof days === "number" && Number.isFinite(days)) {
    policy.grace_period_days = Math.max(0, Math.min(MAX_GRACE_DAYS, Math.trunc(days)));
  }
  for (const key of ["require_fired_break_signal", "relative_fields_change_only"] as const) {
    if (typeof source[key] === "boolean") policy[key] = source[key] as boolean;
  }

  // Carried, not interpreted — Python is the enforcer. Shape-check only, so a
  // non-string can never reach the column.
  const exempt = source.rebuy_cooldown_ignores_sells_before;
  if (typeof exempt === "string" && exempt.trim()) {
    policy.rebuy_cooldown_ignores_sells_before = exempt.trim();
  }
  return policy;
}

/** True when the policy is exactly the defaults (used to render a "default" hint). */
export function isDefault(policy: ThesisPolicy): boolean {
  return (
    policy.grace_period_days === DEFAULTS.grace_period_days &&
    policy.require_fired_break_signal === DEFAULTS.require_fired_break_signal &&
    policy.relative_fields_change_only === DEFAULTS.relative_fields_change_only &&
    policy.rebuy_cooldown_ignores_sells_before ===
      DEFAULTS.rebuy_cooldown_ignores_sells_before
  );
}
