"use server";

/**
 * Server Actions for the live cash-allowance panel (sleeves — migration 083).
 *
 * Moves spending allowances between the broker account's unallocated pot and
 * the owner's live portfolios, and between two sleeves. Pure DB writes — cash
 * never moves at the broker (the account total is what it is; these record who
 * may spend it). Rules mirror `sleeves.plan_credit` in Python:
 *
 *   - credit: bounded by the account's UNALLOCATED cash, so it requires the
 *     broker balance to be readable (web env has the ALPACA_* keys);
 *   - debit: bounded by the sleeve's current allowance — an allowance already
 *     spent on shares can't be taken back (sell first; proceeds return to the
 *     sleeve's own allowance);
 *   - transfer: debit + credit in one action. Never needs the broker balance,
 *     because it leaves the total allowance unchanged.
 *
 * Every movement lands in `portfolio_cash_ledger` so balances stay explainable.
 * Writes use an optimistic concurrency check (update WHERE cash_usd = the
 * value we just read) so a racing heartbeat trade can't be silently clobbered.
 */

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";
import { accountKeyFor, getLiveCashSummary } from "@/lib/live-cash-query";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Sub-cent differences are rounding, not real money (sleeves.CASH_TOLERANCE). */
const CASH_TOLERANCE = 0.01;

type OwnedSleeve = { id: string; slug: string; accountKey: string };

/** The caller's own live portfolio, or null. */
async function resolveOwnedSleeve(
  portfolioId: string,
  userId: string,
): Promise<OwnedSleeve | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .select("id, slug, broker_account_key")
    .eq("id", portfolioId)
    .eq("owner_user_id", userId)
    .eq("mode", "live")
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("resolveOwnedSleeve failed:", error);
    return null;
  }
  return { id: data.id, slug: data.slug, accountKey: accountKeyFor(data) };
}

/** Current allowance for a portfolio (0 when no account row exists yet). */
async function readAllowance(portfolioId: string): Promise<number | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolio_accounts")
    .select("cash_usd")
    .eq("portfolio_id", portfolioId)
    .maybeSingle();
  if (error) {
    console.error("readAllowance failed:", error);
    return null;
  }
  return Number((data as { cash_usd: number | string | null } | null)?.cash_usd ?? 0);
}

/**
 * Set a sleeve's allowance from `expectedCurrent` to `next`, refusing if the
 * stored value moved in between (a heartbeat fill lands in the same column).
 */
async function writeAllowance(
  portfolioId: string,
  expectedCurrent: number,
  next: number,
): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolio_accounts")
    .update({ cash_usd: next })
    .eq("portfolio_id", portfolioId)
    .eq("cash_usd", expectedCurrent)
    .select("portfolio_id");
  if (error) {
    console.error("writeAllowance failed:", error);
    return false;
  }
  return (data ?? []).length === 1;
}

async function logLedger(
  portfolioId: string,
  deltaUsd: number,
  balanceAfter: number,
  reason: string,
  note: string | null,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("portfolio_cash_ledger").insert({
    portfolio_id: portfolioId,
    delta_usd: Math.round(deltaUsd * 100) / 100,
    balance_after: Math.round(balanceAfter * 100) / 100,
    reason,
    note,
  });
  // The balance change already landed; a ledger failure is logged, not fatal.
  if (error) console.error("portfolio_cash_ledger insert failed:", error);
}

function parseAmount(raw: number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

const RETRY_MSG =
  "The allowance changed while saving (an agent may have traded). Refresh and try again.";

/** Move unallocated broker cash into one sleeve's allowance. */
export async function creditAllowance(input: {
  portfolioId: string;
  amount: number;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const sleeve = await resolveOwnedSleeve(input.portfolioId, user.id);
  if (!sleeve) return { ok: false, error: "That isn't your live portfolio." };
  const amount = parseAmount(input.amount);
  if (!amount) return { ok: false, error: "Enter an amount above zero." };

  // A credit spends the account's unallocated cash, so it needs the live
  // broker balance. getLiveCashSummary reads it (and every sibling allowance).
  const summary = await getLiveCashSummary(sleeve.id, user.id);
  if (!summary) return { ok: false, error: "Could not load the account." };
  if (summary.unallocated == null) {
    return {
      ok: false,
      error:
        "The broker balance isn't readable from the website (no Alpaca keys " +
        "in the web environment), so credits are disabled here. Use " +
        "live_cash.py --credit instead.",
    };
  }
  if (amount > summary.unallocated + CASH_TOLERANCE) {
    return {
      ok: false,
      error: `Only $${summary.unallocated.toFixed(2)} is unallocated — cannot credit $${amount.toFixed(2)}.`,
    };
  }

  const current = summary.sleeves.find((s) => s.portfolioId === sleeve.id);
  if (!current) return { ok: false, error: "Could not load the account." };
  const next = Math.round((current.allowance + amount) * 100) / 100;
  if (!(await writeAllowance(sleeve.id, current.allowance, next))) {
    return { ok: false, error: RETRY_MSG };
  }
  await logLedger(sleeve.id, amount, next, "credit", "web");
  revalidatePath(`/portfolios/${sleeve.slug}`);
  return { ok: true };
}

/** Return part of a sleeve's allowance to the unallocated pot. */
export async function debitAllowance(input: {
  portfolioId: string;
  amount: number;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  const sleeve = await resolveOwnedSleeve(input.portfolioId, user.id);
  if (!sleeve) return { ok: false, error: "That isn't your live portfolio." };
  const amount = parseAmount(input.amount);
  if (!amount) return { ok: false, error: "Enter an amount above zero." };

  const allowance = await readAllowance(sleeve.id);
  if (allowance == null) return { ok: false, error: "Could not load the account." };
  if (amount > allowance + CASH_TOLERANCE) {
    return {
      ok: false,
      error: `Allowance is $${allowance.toFixed(2)} — cannot debit $${amount.toFixed(2)}. Sell holdings to free up more.`,
    };
  }

  const next = Math.round((allowance - amount) * 100) / 100;
  if (!(await writeAllowance(sleeve.id, allowance, next))) {
    return { ok: false, error: RETRY_MSG };
  }
  await logLedger(sleeve.id, -amount, next, "debit", "web");
  revalidatePath(`/portfolios/${sleeve.slug}`);
  return { ok: true };
}

/**
 * Move allowance from one sleeve to another on the SAME broker account.
 * Total allowance is unchanged, so no broker read is needed. Debit runs first;
 * if the credit leg then fails, the amount is parked as unallocated and the
 * error says so (never double-counted).
 */
export async function transferAllowance(input: {
  fromPortfolioId: string;
  toPortfolioId: string;
  amount: number;
}): Promise<ActionResult> {
  const { user } = await requireUser();
  if (input.fromPortfolioId === input.toPortfolioId) {
    return { ok: false, error: "Pick two different portfolios." };
  }
  const [from, to] = await Promise.all([
    resolveOwnedSleeve(input.fromPortfolioId, user.id),
    resolveOwnedSleeve(input.toPortfolioId, user.id),
  ]);
  if (!from || !to) return { ok: false, error: "That isn't your live portfolio." };
  if (from.accountKey !== to.accountKey) {
    return {
      ok: false,
      error:
        "Those portfolios use different broker accounts — an allowance can " +
        "only move within one account.",
    };
  }
  const amount = parseAmount(input.amount);
  if (!amount) return { ok: false, error: "Enter an amount above zero." };

  const fromAllowance = await readAllowance(from.id);
  if (fromAllowance == null) {
    return { ok: false, error: "Could not load the account." };
  }
  if (amount > fromAllowance + CASH_TOLERANCE) {
    return {
      ok: false,
      error: `${from.slug} has $${fromAllowance.toFixed(2)} — cannot move $${amount.toFixed(2)}.`,
    };
  }

  const fromNext = Math.round((fromAllowance - amount) * 100) / 100;
  if (!(await writeAllowance(from.id, fromAllowance, fromNext))) {
    return { ok: false, error: RETRY_MSG };
  }
  await logLedger(from.id, -amount, fromNext, "transfer-out", `web → ${to.slug}`);

  const toAllowance = await readAllowance(to.id);
  const toNext = Math.round(((toAllowance ?? 0) + amount) * 100) / 100;
  if (
    toAllowance == null ||
    !(await writeAllowance(to.id, toAllowance, toNext))
  ) {
    return {
      ok: false,
      error:
        `Moved $${amount.toFixed(2)} out of ${from.slug}, but crediting ` +
        `${to.slug} failed — the amount is sitting unallocated. Credit it ` +
        `from the panel (or live_cash.py) once the page refreshes.`,
    };
  }
  await logLedger(to.id, amount, toNext, "transfer-in", `web ← ${from.slug}`);

  revalidatePath(`/portfolios/${from.slug}`);
  revalidatePath(`/portfolios/${to.slug}`);
  return { ok: true };
}
