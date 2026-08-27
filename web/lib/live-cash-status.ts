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

/**
 * A two-or-three word tag to sit where the missing number would be.
 *
 * The full note explains; this one is READ. The explanation shipped as 11px
 * grey text at the foot of the panel while the symptom — "broker cash —" — sat
 * at the top in its own row, so the answer was present and still invisible.
 * A diagnostic nobody's eye lands on is not a diagnostic.
 */
export function brokerCashTag(status: BrokerCashStatus): string | null {
  switch (status) {
    case "ok":
      return null;
    case "not_configured":
      return "not configured";
    case "rejected":
      return "keys rejected";
    case "unreachable":
      return "unreachable";
  }
}

/** The one-line reason a credit is refused, for the server action. */
export function creditBlockedReason(status: BrokerCashStatus): string {
  const note = brokerCashNote(status);
  const detail = note ?? "The broker balance is unknown.";
  return `${detail} Use \`live_cash.py --credit\` in the meantime.`;
}

/**
 * The heading for the credit/debit panel: what the pot is called, and how much
 * is in it.
 *
 * Both halves are fixes for the same report. The hub named this quantity
 * "unassigned" at the top of the account and "spare account cash" inside the
 * strategy card, with nothing connecting the two — so the panel appeared to
 * describe a different pot. And it was headed with the NAME of an amount while
 * never showing the amount, even though the component already had the figure
 * in scope for its own disabled check. The owner had to leave the panel,
 * scroll up, and translate a second term to learn what they could type in.
 *
 * One word, and the number where it is spent. `null` when the balance could
 * not be read — `brokerCashNote` explains that case, and inventing a figure
 * here would contradict it.
 */
export function spareCashLabel(unallocated: number | null): string {
  if (unallocated == null) return "UNASSIGNED CASH";
  const amount = unallocated.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `UNASSIGNED CASH  $${amount}`;
}

/**
 * What a credit is capped at, as a sentence, or null when nothing limits it.
 *
 * `sleeves.plan_credit` refuses a credit larger than the unallocated pot, and
 * a refusal after typing is a worse experience than a ceiling stated before.
 */
export function creditCeilingHint(unallocated: number | null): string | null {
  if (unallocated == null) return null;
  if (unallocated <= 0) {
    return "nothing unassigned — debit a strategy first, or add funds at the broker";
  }
  return null;
}
