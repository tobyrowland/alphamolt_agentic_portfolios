/**
 * Why the website could not read the broker's cash balance.
 *
 * `fetchBrokerCash` used to return `null` for three unrelated situations —
 * no keys configured, the broker rejecting the keys, and the call never
 * completing — and logged nothing at all on a non-OK response:
 *
 *     if (!res.ok) return null;
 *
 * So a 403 was indistinguishable from an unconfigured environment, in the UI
 * and in the server logs. The hub then asserted the cause it could not know
 * ("This server can't read your broker balance"), which sent at least one
 * investigation looking for missing environment variables that were in fact
 * present and correct-looking.
 *
 * A diagnostic that names the wrong cause is worse than one that says nothing,
 * so the status is now carried explicitly and the copy follows it.
 */

export type BrokerCashStatus =
  /** The balance was read. */
  | "ok"
  /** No Alpaca keys in this environment — nothing was attempted. */
  | "not_configured"
  /** Alpaca refused the credentials (401/403). */
  | "rejected"
  /** The request failed, timed out, or returned an unexpected status. */
  | "unreachable";

/**
 * The sentence to show the owner, or null when there is nothing to explain.
 *
 * Each names what actually happened and what would resolve it. The `rejected`
 * case leads with the paper/live mismatch because Alpaca issues separate
 * credentials per endpoint and a key that works in one returns 403 in the
 * other — the single most likely reason a correct-looking set of variables
 * still fails.
 */
export function brokerCashNote(status: BrokerCashStatus): string | null {
  switch (status) {
    case "ok":
      return null;
    case "not_configured":
      return (
        "This server has no Alpaca keys, so the unassigned figure is unknown " +
        "and crediting is disabled here. Moving money between strategies " +
        "never needs the broker."
      );
    case "rejected":
      return (
        "Alpaca rejected this server's keys, so the unassigned figure is " +
        "unknown and crediting is disabled here. Paper and live accounts have " +
        "separate credentials — check that ALPACA_API_KEY_ID and " +
        "ALPACA_API_SECRET_KEY belong to the same account as ALPACA_BASE_URL."
      );
    case "unreachable":
      return (
        "Couldn't reach Alpaca from this server, so the unassigned figure is " +
        "unknown and crediting is disabled here. This is usually temporary — " +
        "reload in a moment."
      );
  }
}

/** The one-line reason a credit is refused, for the server action. */
export function creditBlockedReason(status: BrokerCashStatus): string {
  const note = brokerCashNote(status);
  const detail = note ?? "The broker balance is unknown.";
  return `${detail} Use \`live_cash.py --credit\` in the meantime.`;
}
