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
import {
  accountKeyFor,
  getAccountCashSummaryForPortfolio,
} from "@/lib/live-cash-query";
import { uniquePortfolioSlug } from "@/lib/slug";
import {
  planInKindFunding,
  planSplitMoves,
  type InKindPlan,
  type SourceHolding,
} from "@/lib/sleeve-funding";
import { syncLivePortfolioToAlpaca } from "@/lib/live-mirror-mutations";

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
  // broker balance (and every sibling allowance).
  const summary = await getAccountCashSummaryForPortfolio(sleeve.id, user.id);
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
  revalidatePath("/account");
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
  revalidatePath("/account");
  return { ok: true };
}

/**
 * The shared sleeve→sleeve mover: cash when the source's spare cash covers
 * the amount, otherwise cash + an in-kind slice of its positions (migration
 * 084). Dispatches a restructure for the destination when shares moved.
 * Ownership/account checks are the caller's job.
 */
async function moveBetweenSleeves(
  from: OwnedSleeve,
  to: OwnedSleeve,
  amount: number,
): Promise<ActionResult> {
  const fromAllowance = await readAllowance(from.id);
  if (fromAllowance == null) {
    return { ok: false, error: "Could not load the account." };
  }

  if (amount > fromAllowance + CASH_TOLERANCE) {
    const holdings = await sourceHoldingsWithPrices(from.id);
    const plan = planInKindFunding(fromAllowance, holdings, amount);
    if (plan.plannedTotal < amount - 1) {
      return {
        ok: false,
        error:
          `${from.slug} is worth about $${plan.plannedTotal.toFixed(2)} ` +
          `(cash + priceable holdings) — cannot move $${amount.toFixed(2)}.`,
      };
    }
    const moved = await executeInKind(from.id, to.id, plan);
    if (!moved.ok) return moved;
    if (plan.shareMoves.length > 0) await dispatchRestructure(to.id);
    return { ok: true };
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

  const moved = await moveBetweenSleeves(from, to, amount);
  if (!moved.ok) return moved;

  revalidatePath(`/portfolios/${from.slug}`);
  revalidatePath(`/portfolios/${to.slug}`);
  revalidatePath("/account");
  return { ok: true };
}

/**
 * The source sleeve's positions with current Level 0 prices — the input to
 * the in-kind planner. Unpriced names come back with price null and are
 * skipped by the planner (they stay with the source).
 */
async function sourceHoldingsWithPrices(
  portfolioId: string,
): Promise<SourceHolding[]> {
  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from("portfolio_holdings")
    .select("ticker, quantity, avg_cost_usd")
    .eq("portfolio_id", portfolioId);
  if (error) {
    console.error("sourceHoldingsWithPrices failed:", error);
    return [];
  }
  const holdings = (rows ?? []) as {
    ticker: string;
    quantity: number | string;
    avg_cost_usd: number | string | null;
  }[];
  const tickers = holdings.map((h) => h.ticker);
  const priceByTicker = new Map<string, number>();
  if (tickers.length > 0) {
    const { data: secs } = await supabase
      .from("securities")
      .select("ticker, price")
      .in("ticker", tickers);
    for (const s of (secs ?? []) as {
      ticker: string;
      price: number | string | null;
    }[]) {
      const px = s.price == null ? NaN : Number(s.price);
      if (Number.isFinite(px) && px > 0) priceByTicker.set(s.ticker, px);
    }
  }
  return holdings.map((h) => ({
    ticker: h.ticker,
    quantity: Number(h.quantity) || 0,
    avgCost: h.avg_cost_usd == null ? null : Number(h.avg_cost_usd),
    price: priceByTicker.get(h.ticker) ?? null,
  }));
}

/**
 * Execute an in-kind plan atomically via the fund_sleeve_in_kind RPC
 * (migration 084): N guarded holding decrements, destination upserts, cash,
 * baselines and both ledger legs in ONE transaction — a racing heartbeat fill
 * rolls the whole move back rather than corrupting the split.
 */
async function executeInKind(
  fromPortfolioId: string,
  toPortfolioId: string,
  plan: InKindPlan,
): Promise<ActionResult> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("fund_sleeve_in_kind", {
    p_from_portfolio: fromPortfolioId,
    p_to_portfolio: toPortfolioId,
    p_moves: plan.shareMoves.map((m) => ({
      ticker: m.ticker,
      qty: m.qty,
      avg_cost: m.avgCost,
    })),
    p_cash: plan.cashMove,
    p_total: plan.plannedTotal,
  });
  if (error) {
    console.error("fund_sleeve_in_kind failed:", error);
    const retry = /retry/i.test(error.message ?? "");
    return {
      ok: false,
      error: retry
        ? RETRY_MSG
        : `The in-kind move failed and nothing was moved: ${error.message}. ` +
          "Is migration 084 applied?",
    };
  }
  return { ok: true };
}

/**
 * Fire the mirror for a freshly funded sleeve so inherited positions are
 * restructured into its own paper book as soon as the market allows — the
 * first of the guarantees that an in-kind-funded sleeve can't just sit on
 * another strategy's shares. Best-effort: a dispatch failure is reported in
 * the notice, and the hub's "restructure pending" warning + the daily mirror
 * cron remain the backstops.
 */
async function dispatchRestructure(portfolioId: string): Promise<boolean> {
  try {
    const res = await syncLivePortfolioToAlpaca({
      portfolioId,
      source: "restructure",
    });
    return res.ok;
  } catch (err) {
    console.error("restructure dispatch failed:", err);
    return false;
  }
}

/** Live followers per user — belt-and-braces cap, mirrors MAX_PAPER_PORTFOLIOS. */
const MAX_LIVE_PORTFOLIOS = 5;

/**
 * "Go live": create a live follower for one of the caller's paper books as a
 * NEW SLEEVE of an existing broker account, funded in the same step.
 *
 * The new row's broker_account_key is set explicitly to the funding sleeve's
 * account key — never left NULL. A NULL key falls back to the new slug, which
 * would make the account look like TWO distinct broker accounts and (under the
 * bare ALPACA_* credentials) stop the mirror for every live portfolio.
 *
 * One follower per paper book: the heartbeat's live↔paper pairing is keyed by
 * paper id and refuses duplicates, so this refuses them first, and the UI only
 * offers unfollowed books.
 *
 * Funding reuses the transfer mechanics (allowance debit/credit + ledger) and
 * also sets the new sleeve's starting_cash to the funded amount, so its P&L
 * baseline is the real capital it started with — not the $0 it was born with.
 * If the funding leg fails after creation, the sleeve is kept (unfunded) and
 * the error says to finish with the Move control; it is never deleted.
 *
 * This flow only ADDS a sleeve to an account that already has a live
 * portfolio. A user's first go-live stays operator-driven
 * (bootstrap_live_portfolio.py) — deliberate, per migration 083.
 */
export async function createLiveFollower(input: {
  paperPortfolioId: string;
  fundFromPortfolioId: string;
  amount: number;
}): Promise<
  ActionResult & { slug?: string; movedInKind?: boolean; restructureDispatched?: boolean }
> {
  const { user } = await requireUser();
  const supabase = getSupabase();

  const amount = parseAmount(input.amount);
  if (!amount) return { ok: false, error: "Enter an amount above zero." };

  // The paper book to follow — must be the caller's own arena book.
  const { data: paper, error: paperErr } = await supabase
    .from("portfolios")
    .select("id, slug, display_name")
    .eq("id", input.paperPortfolioId)
    .eq("owner_user_id", user.id)
    .eq("mode", "paper")
    .maybeSingle();
  if (paperErr || !paper) {
    if (paperErr) console.error("createLiveFollower paper lookup:", paperErr);
    return { ok: false, error: "Pick one of your own paper portfolios." };
  }

  // One follower per paper book (the heartbeat pairing is keyed by paper id).
  const { data: existingFollower, error: followErr } = await supabase
    .from("portfolios")
    .select("slug")
    .eq("follows_portfolio_id", paper.id)
    .eq("mode", "live")
    .maybeSingle();
  if (followErr) {
    console.error("createLiveFollower follower check:", followErr);
    return { ok: false, error: "Could not verify that portfolio. Try again." };
  }
  if (existingFollower) {
    return {
      ok: false,
      error: `${paper.display_name} already has a live follower (${existingFollower.slug}).`,
    };
  }

  // Funding source — the caller's own existing sleeve; its account key is
  // what makes the new row a sleeve of the SAME broker account.
  const source = await resolveOwnedSleeve(input.fundFromPortfolioId, user.id);
  if (!source) {
    return { ok: false, error: "The funding source isn't your live portfolio." };
  }

  const { count: liveCount } = await supabase
    .from("portfolios")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", user.id)
    .eq("mode", "live");
  if ((liveCount ?? 0) >= MAX_LIVE_PORTFOLIOS) {
    return {
      ok: false,
      error: `Live portfolio limit reached (${MAX_LIVE_PORTFOLIOS}).`,
    };
  }

  // Work out HOW the source can afford the funding BEFORE creating anything:
  // spare cash alone when it covers the amount, otherwise cash + an in-kind
  // slice of the source's positions (migration 084). Refuse only when even a
  // full in-kind plan falls materially short — the source isn't worth it.
  const sourceAllowance = await readAllowance(source.id);
  if (sourceAllowance == null) {
    return { ok: false, error: "Could not load the account." };
  }
  const cashOnly = amount <= sourceAllowance + CASH_TOLERANCE;
  let inKindPlan: InKindPlan | null = null;
  if (!cashOnly) {
    const holdings = await sourceHoldingsWithPrices(source.id);
    inKindPlan = planInKindFunding(sourceAllowance, holdings, amount);
    if (inKindPlan.plannedTotal < amount - 1) {
      return {
        ok: false,
        error:
          `${source.slug} is worth about $${inKindPlan.plannedTotal.toFixed(2)} ` +
          `(cash + priceable holdings) — cannot fund $${amount.toFixed(2)}.`,
      };
    }
  }

  // Create the follower row (private by DB CHECK; mode='live'; explicit
  // account key) + its zero-cash account, matching bootstrap_live_portfolio.py.
  const slug = await uniquePortfolioSlug(`${paper.display_name} live`);
  const today = new Date().toISOString().slice(0, 10);
  const { data: created, error: insertErr } = await supabase
    .from("portfolios")
    .insert({
      slug,
      display_name: `${paper.display_name} (Live)`,
      owner_user_id: user.id,
      owner_agent_id: null,
      is_public: false,
      mode: "live",
      description: null,
      follows_portfolio_id: paper.id,
      broker_account_key: source.accountKey,
    })
    .select("id")
    .maybeSingle();
  if (insertErr || !created) {
    console.error("createLiveFollower insert failed:", insertErr);
    return { ok: false, error: "Could not create the live portfolio. Try again." };
  }
  const newId = (created as { id: string }).id;
  const { error: seedErr } = await supabase.from("portfolio_accounts").upsert({
    portfolio_id: newId,
    cash_usd: 0,
    starting_cash: 0,
    inception_date: today,
  });
  if (seedErr) {
    console.error("createLiveFollower account seed failed:", seedErr);
    return {
      ok: false,
      error:
        `${paper.display_name} (Live) was created but its cash account ` +
        "could not be initialised — refresh and fund it with the Move control.",
    };
  }

  const kept =
    `${paper.display_name} (Live) was created unfunded — ` +
    "fund it with the Move control once the page refreshes.";

  if (cashOnly) {
    // Funding leg — transfer semantics (source allowance → new sleeve), plus
    // starting_cash so the P&L baseline is the funded amount.
    const sourceNext = Math.round((sourceAllowance - amount) * 100) / 100;
    if (!(await writeAllowance(source.id, sourceAllowance, sourceNext))) {
      return { ok: false, error: `${RETRY_MSG} ${kept}` };
    }
    await logLedger(source.id, -amount, sourceNext, "transfer-out", `go-live → ${slug}`);

    const { error: fundErr } = await supabase
      .from("portfolio_accounts")
      .update({ cash_usd: amount, starting_cash: amount })
      .eq("portfolio_id", newId)
      .eq("cash_usd", 0);
    if (fundErr) {
      console.error("createLiveFollower funding failed:", fundErr);
      return {
        ok: false,
        error:
          `Moved $${amount.toFixed(2)} out of ${source.slug}, but crediting the ` +
          `new sleeve failed — the amount is sitting unallocated. ${kept}`,
      };
    }
    await logLedger(newId, amount, amount, "transfer-in", `go-live ← ${source.slug}`);
  } else if (inKindPlan) {
    // In-kind funding: cash + a proportional slice of the source's shares,
    // atomically (migration 084). On failure nothing moved — the sleeve
    // stays unfunded and the Move control finishes the job.
    const moved = await executeInKind(source.id, newId, inKindPlan);
    if (!moved.ok) {
      return { ok: false, error: `${moved.error} ${kept}` };
    }
  }

  // Guarantee 1: restructure the inherited positions into the new sleeve's
  // own paper book as soon as the market allows. Best-effort — the hub's
  // "restructure pending" warning + the daily mirror cron are the backstops.
  const movedInKind =
    !cashOnly && !!inKindPlan && inKindPlan.shareMoves.length > 0;
  const restructureDispatched = movedInKind
    ? await dispatchRestructure(newId)
    : false;

  revalidatePath("/account");
  revalidatePath(`/portfolios/${slug}`);
  revalidatePath(`/portfolios/${source.slug}`);
  return { ok: true, slug, movedInKind, restructureDispatched };
}

/**
 * "+ Add strategy" for the split editor: create an UNFUNDED live follower for
 * one of the caller's paper books, as a sleeve of the account that
 * `accountPortfolioId` (an existing sleeve of the caller's) belongs to. No
 * money moves — the new row appears in the split editor at $0 and gets funded
 * by Apply split. Same guards as createLiveFollower.
 */
export async function createFollowerShell(input: {
  paperPortfolioId: string;
  accountPortfolioId: string;
}): Promise<ActionResult & { slug?: string; portfolioId?: string }> {
  const { user } = await requireUser();
  const supabase = getSupabase();

  const anchor = await resolveOwnedSleeve(input.accountPortfolioId, user.id);
  if (!anchor) return { ok: false, error: "That isn't your live portfolio." };

  const { data: paper, error: paperErr } = await supabase
    .from("portfolios")
    .select("id, slug, display_name")
    .eq("id", input.paperPortfolioId)
    .eq("owner_user_id", user.id)
    .eq("mode", "paper")
    .maybeSingle();
  if (paperErr || !paper) {
    if (paperErr) console.error("createFollowerShell paper lookup:", paperErr);
    return { ok: false, error: "Pick one of your own paper portfolios." };
  }

  const { data: existingFollower } = await supabase
    .from("portfolios")
    .select("slug")
    .eq("follows_portfolio_id", paper.id)
    .eq("mode", "live")
    .maybeSingle();
  if (existingFollower) {
    return {
      ok: false,
      error: `${paper.display_name} already has a live follower (${existingFollower.slug}).`,
    };
  }

  const { count: liveCount } = await supabase
    .from("portfolios")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", user.id)
    .eq("mode", "live");
  if ((liveCount ?? 0) >= 5) {
    return { ok: false, error: "Live portfolio limit reached (5)." };
  }

  const slug = await uniquePortfolioSlug(`${paper.display_name} live`);
  const { data: created, error: insertErr } = await supabase
    .from("portfolios")
    .insert({
      slug,
      display_name: `${paper.display_name} (Live)`,
      owner_user_id: user.id,
      owner_agent_id: null,
      is_public: false,
      mode: "live",
      description: null,
      follows_portfolio_id: paper.id,
      broker_account_key: anchor.accountKey,
    })
    .select("id")
    .maybeSingle();
  if (insertErr || !created) {
    console.error("createFollowerShell insert failed:", insertErr);
    return { ok: false, error: "Could not create the live portfolio. Try again." };
  }
  const newId = (created as { id: string }).id;
  const { error: seedErr } = await supabase.from("portfolio_accounts").upsert({
    portfolio_id: newId,
    cash_usd: 0,
    starting_cash: 0,
    inception_date: new Date().toISOString().slice(0, 10),
  });
  if (seedErr) console.error("createFollowerShell account seed failed:", seedErr);

  revalidatePath("/account");
  return { ok: true, slug, portfolioId: newId };
}

/**
 * The split editor's Apply: per-sleeve target worths in, the pairwise moves
 * out, executed via the shared mover (cash when it covers, cash + in-kind
 * shares when it doesn't — migration 084). One requirement keeps it honest:
 * the targets must redistribute the pot, not resize it, so they have to sum
 * to (about) the sleeves' current combined worth. Rows the caller doesn't
 * change simply arrive with target == current and plan no move.
 */
export async function applyLiveSplit(input: {
  targets: { portfolioId: string; target: number }[];
  /**
   * The pot the caller's targets were typed against. Prices are re-read here,
   * so the fresh total can differ from the one on screen (a daily price stamp
   * landing mid-session is enough). When it does, the targets are rescaled to
   * the fresh pot instead of the whole action failing with a "targets add up
   * to $X but the portfolios are worth $Y" refusal — which is a split's
   * proportions surviving a price tick, not a change of intent.
   */
  assumedTotal?: number;
}): Promise<ActionResult & { movesExecuted?: number }> {
  const { user } = await requireUser();
  if (!input.targets || input.targets.length < 2) {
    return { ok: false, error: "The split needs at least two portfolios." };
  }

  // Resolve every row as the caller's own sleeve; all must share one account.
  const sleeves = await Promise.all(
    input.targets.map((t) => resolveOwnedSleeve(t.portfolioId, user.id)),
  );
  if (sleeves.some((s) => s == null)) {
    return { ok: false, error: "That isn't your live portfolio." };
  }
  const resolved = sleeves as OwnedSleeve[];
  const keys = new Set(resolved.map((s) => s.accountKey));
  if (keys.size > 1) {
    return { ok: false, error: "Those portfolios use different broker accounts." };
  }

  // Current worth per sleeve = allowance + priceable holdings value.
  const rows: import("@/lib/sleeve-funding").SplitRow[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const s = resolved[i];
    const allowance = await readAllowance(s.id);
    if (allowance == null) return { ok: false, error: "Could not load the account." };
    const holdings = await sourceHoldingsWithPrices(s.id);
    const held = holdings.reduce(
      (sum, h) => sum + (h.price != null && h.price > 0 ? h.quantity * h.price : 0),
      0,
    );
    const target = Number(input.targets[i].target);
    if (!Number.isFinite(target) || target < 0) {
      return { ok: false, error: "Targets must be zero or above." };
    }
    rows.push({
      portfolioId: s.id,
      current: Math.round((allowance + held) * 100) / 100,
      target: Math.round(target * 100) / 100,
    });
  }

  const totalCurrent = rows.reduce((s, r) => s + r.current, 0);
  let totalTarget = rows.reduce((s, r) => s + r.target, 0);

  // The caller's targets were typed against the pot as it was rendered. If
  // prices moved since, rescale the targets to the fresh pot (proportions are
  // the intent; the exact dollars are not) — but only for a small drift, so a
  // genuinely wrong set of numbers is still refused.
  const assumed = Number(input.assumedTotal);
  if (
    Number.isFinite(assumed) &&
    assumed > 0 &&
    totalCurrent > 0 &&
    Math.abs(totalCurrent - assumed) <= assumed * 0.02 &&
    Math.abs(totalTarget - assumed) <= Math.max(1, assumed * 0.001)
  ) {
    const scale = totalCurrent / assumed;
    for (const r of rows) r.target = Math.round(r.target * scale * 100) / 100;
    totalTarget = rows.reduce((s, r) => s + r.target, 0);
  }

  if (Math.abs(totalCurrent - totalTarget) > Math.max(1, totalCurrent * 0.001)) {
    return {
      ok: false,
      error:
        `Targets add up to $${totalTarget.toFixed(2)} but the account's ` +
        `portfolios are worth $${totalCurrent.toFixed(2)} — a split ` +
        "redistributes the pot, it can't resize it. Refresh the page to pick " +
        "up the current numbers and set the targets again.",
    };
  }

  const moves = planSplitMoves(rows);
  if (moves.length === 0) {
    return { ok: false, error: "Targets match the current split — nothing to move." };
  }

  const byId = new Map(resolved.map((s) => [s.id, s]));
  let executed = 0;
  for (const m of moves) {
    const from = byId.get(m.fromPortfolioId);
    const to = byId.get(m.toPortfolioId);
    if (!from || !to) continue;
    const result = await moveBetweenSleeves(from, to, m.amount);
    if (!result.ok) {
      return {
        ok: false,
        error:
          executed > 0
            ? `${result.error} (${executed} of ${moves.length} moves completed — ` +
              "the numbers on screen are correct; adjust targets and Apply again.)"
            : result.error,
        movesExecuted: executed,
      };
    }
    executed++;
  }

  revalidatePath("/account");
  for (const s of resolved) revalidatePath(`/portfolios/${s.slug}`);
  return { ok: true, movesExecuted: executed };
}
