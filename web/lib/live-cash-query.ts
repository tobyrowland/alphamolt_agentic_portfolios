import { getSupabase } from "@/lib/supabase";

/**
 * Server reads for the live cash-allowance hub (sleeves — migration 083).
 *
 * The broker holds ONE pot of cash; each live portfolio ("sleeve") on that
 * account holds an allowance (`portfolio_accounts.cash_usd`) — the most it may
 * spend. Cash credited to nobody is "unallocated": dividends, interest, fees
 * and fresh deposits all land there until the owner credits them out. This
 * module assembles that picture per broker account for the owner's /account
 * hub (and for the credit action's bound check).
 *
 * Broker cash is a best-effort read of the Alpaca account using the bare
 * `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` env vars, when the web server
 * has them. Without them the hub still works — allowances, holdings, debits
 * and transfers don't need the broker — but `brokerCash`/`unallocated` are
 * null and crediting is disabled (a credit is bounded by unallocated cash,
 * which can't be known without the broker balance). Python twin:
 * `live_cash.py` / `sleeves.py`.
 */

export type SleeveCash = {
  portfolioId: string;
  slug: string;
  displayName: string;
  /** Spendable cash allowance (portfolio_accounts.cash_usd). */
  allowance: number;
  /** Mark-to-market value of this sleeve's own recorded holdings. */
  holdingsValue: number;
  /** The paper book this follower mirrors (follows_portfolio_id), if set. */
  followsPortfolioId: string | null;
  /**
   * Value of this sleeve's holdings in tickers its own paper book does NOT
   * hold — e.g. positions inherited through an in-kind funding move that the
   * mirror hasn't restructured yet, or everything when the follower is
   * unlinked. The hub shows a persistent warning while this is material, so
   * an inherited book can never sit unnoticed.
   */
  offBookValue: number;
};

export type LedgerEntry = {
  id: number;
  portfolioSlug: string;
  deltaUsd: number;
  reason: string;
  note: string | null;
  createdAt: string;
};

export type LiveCashSummary = {
  /** The shared broker-account label (broker_account_key ?? slug). */
  accountKey: string;
  sleeves: SleeveCash[];
  /** Real cash at the broker, or null when the web env has no Alpaca keys. */
  brokerCash: number | null;
  /** brokerCash − Σ allowances, or null when brokerCash is unknown. */
  unallocated: number | null;
  /** Most recent allowance movements across the account's sleeves. */
  ledger: LedgerEntry[];
};

/** Same fallback rule as `broker.account_key_for_portfolio` (migration 083). */
export function accountKeyFor(p: {
  broker_account_key?: string | null;
  slug: string;
}): string {
  const key = (p.broker_account_key ?? "").trim();
  return key || p.slug;
}

type LivePortfolioRow = {
  id: string;
  slug: string;
  display_name: string;
  broker_account_key: string | null;
  follows_portfolio_id: string | null;
};

/** Best-effort Alpaca cash balance from the bare env credentials. */
async function fetchBrokerCash(): Promise<number | null> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) return null;
  const base = (
    process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets"
  ).replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/v2/account`, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { cash?: string | number | null };
    const cash = body.cash == null ? NaN : Number(body.cash);
    return Number.isFinite(cash) ? cash : null;
  } catch (err) {
    console.error("live-cash: Alpaca account read failed:", err);
    return null;
  }
}

/** All the owner's live portfolios (the sleeve universe). */
async function ownedLivePortfolios(
  ownerUserId: string,
): Promise<LivePortfolioRow[] | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolios")
    .select("id, slug, display_name, broker_account_key, follows_portfolio_id")
    .eq("owner_user_id", ownerUserId)
    .eq("mode", "live");
  if (error) {
    console.error("live-cash: live portfolios lookup failed:", error);
    return null;
  }
  return (data ?? []) as LivePortfolioRow[];
}

/** Build one account's summary from its sleeve portfolio rows. */
async function buildAccountSummary(
  accountKey: string,
  sleevePortfolios: LivePortfolioRow[],
): Promise<LiveCashSummary> {
  const supabase = getSupabase();
  const ids = sleevePortfolios.map((p) => p.id);

  const [{ data: accounts }, { data: holdings }, brokerCash] =
    await Promise.all([
      supabase
        .from("portfolio_accounts")
        .select("portfolio_id, cash_usd")
        .in("portfolio_id", ids),
      supabase
        .from("portfolio_holdings")
        .select("portfolio_id, ticker, quantity")
        .in("portfolio_id", ids),
      fetchBrokerCash(),
    ]);

  const allowanceById = new Map<string, number>();
  for (const a of (accounts ?? []) as {
    portfolio_id: string;
    cash_usd: number | string | null;
  }[]) {
    allowanceById.set(a.portfolio_id, Number(a.cash_usd ?? 0));
  }

  // Value each sleeve's holdings at the latest Level 0 price. A ticker missing
  // a price contributes 0 — the hub is a cash console, not the MTM of record
  // (portfolio_valuation.py owns that).
  const holdingRows = (holdings ?? []) as {
    portfolio_id: string;
    ticker: string;
    quantity: number | string;
  }[];
  const tickers = [...new Set(holdingRows.map((h) => h.ticker))];
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
      if (Number.isFinite(px)) priceByTicker.set(s.ticker, px);
    }
  }
  const holdingsValueById = new Map<string, number>();
  for (const h of holdingRows) {
    const px = priceByTicker.get(h.ticker) ?? 0;
    holdingsValueById.set(
      h.portfolio_id,
      (holdingsValueById.get(h.portfolio_id) ?? 0) + Number(h.quantity) * px,
    );
  }

  // Each followed paper book's ticker set — what the sleeve SHOULD hold.
  // Anything else it holds is "off book" (inherited via in-kind funding, or a
  // stale position) and gets flagged until the mirror restructures it.
  const followIds = [
    ...new Set(
      sleevePortfolios
        .map((p) => p.follows_portfolio_id)
        .filter((id): id is string => id != null),
    ),
  ];
  const paperTickersById = new Map<string, Set<string>>();
  if (followIds.length > 0) {
    const { data: paperRows } = await supabase
      .from("portfolio_holdings")
      .select("portfolio_id, ticker")
      .in("portfolio_id", followIds);
    for (const r of (paperRows ?? []) as {
      portfolio_id: string;
      ticker: string;
    }[]) {
      const set = paperTickersById.get(r.portfolio_id) ?? new Set<string>();
      set.add(r.ticker);
      paperTickersById.set(r.portfolio_id, set);
    }
  }
  const offBookById = new Map<string, number>();
  for (const p of sleevePortfolios) {
    const allowed = p.follows_portfolio_id
      ? (paperTickersById.get(p.follows_portfolio_id) ?? new Set<string>())
      : new Set<string>();
    let off = 0;
    for (const h of holdingRows) {
      if (h.portfolio_id !== p.id || allowed.has(h.ticker)) continue;
      off += Number(h.quantity) * (priceByTicker.get(h.ticker) ?? 0);
    }
    offBookById.set(p.id, off);
  }

  const sleeves: SleeveCash[] = sleevePortfolios
    .map((p) => ({
      portfolioId: p.id,
      slug: p.slug,
      displayName: p.display_name,
      allowance: round2(allowanceById.get(p.id) ?? 0),
      holdingsValue: round2(holdingsValueById.get(p.id) ?? 0),
      followsPortfolioId: p.follows_portfolio_id,
      offBookValue: round2(offBookById.get(p.id) ?? 0),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const totalAllowance = sleeves.reduce((s, x) => s + x.allowance, 0);
  const unallocated =
    brokerCash == null ? null : round2(brokerCash - totalAllowance);

  // Recent movements, joined to slugs client-side (tiny list).
  const { data: ledgerRows } = await supabase
    .from("portfolio_cash_ledger")
    .select("id, portfolio_id, delta_usd, reason, note, created_at")
    .in("portfolio_id", ids.length > 0 ? ids : ["-"])
    .order("created_at", { ascending: false })
    .limit(8);
  const slugById = new Map(sleevePortfolios.map((p) => [p.id, p.slug]));
  const ledger: LedgerEntry[] = (
    (ledgerRows ?? []) as {
      id: number;
      portfolio_id: string;
      delta_usd: number | string;
      reason: string;
      note: string | null;
      created_at: string;
    }[]
  ).map((r) => ({
    id: r.id,
    portfolioSlug: slugById.get(r.portfolio_id) ?? "?",
    deltaUsd: Number(r.delta_usd),
    reason: r.reason,
    note: r.note,
    createdAt: r.created_at,
  }));

  return {
    accountKey,
    sleeves,
    brokerCash: brokerCash == null ? null : round2(brokerCash),
    unallocated,
    ledger,
  };
}

/**
 * Every broker account the owner has live portfolios on, each with its full
 * cash picture — the /account hub's data. Normally one account; sorted by key
 * for stable rendering. Owner-only data — callers must pass a verified
 * owner's userId; every query re-scopes to it.
 */
export async function getLiveCashOverview(
  ownerUserId: string,
): Promise<LiveCashSummary[]> {
  const live = await ownedLivePortfolios(ownerUserId);
  if (!live || live.length === 0) return [];

  const byKey = new Map<string, LivePortfolioRow[]>();
  for (const p of live) {
    const key = accountKeyFor(p);
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }
  return Promise.all(
    [...byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => buildAccountSummary(key, rows)),
  );
}

/**
 * One broker account's summary, anchored by a portfolio on it — the credit
 * action's bound check (a credit is capped by the account's unallocated
 * cash). Returns null when the portfolio isn't the caller's live portfolio.
 */
export async function getAccountCashSummaryForPortfolio(
  portfolioId: string,
  ownerUserId: string,
): Promise<LiveCashSummary | null> {
  const live = await ownedLivePortfolios(ownerUserId);
  const anchor = live?.find((p) => p.id === portfolioId);
  if (!live || !anchor) return null;
  const key = accountKeyFor(anchor);
  return buildAccountSummary(
    key,
    live.filter((p) => accountKeyFor(p) === key),
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
