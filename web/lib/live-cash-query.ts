import { getSupabase } from "@/lib/supabase";

/**
 * Server reads for the live cash-allowance panel (sleeves — migration 083).
 *
 * The broker holds ONE pot of cash; each live portfolio ("sleeve") on that
 * account holds an allowance (`portfolio_accounts.cash_usd`) — the most it may
 * spend. Cash credited to nobody is "unallocated": dividends, interest, fees
 * and fresh deposits all land there until the owner credits them out. This
 * module assembles that picture for the owner's UI.
 *
 * Broker cash is a best-effort read of the Alpaca account using the bare
 * `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` env vars, when the web server
 * has them. Without them the panel still works — allowances, holdings and
 * transfers don't need the broker — but `brokerCash`/`unallocated` are null and
 * crediting is disabled (a credit is bounded by unallocated cash, which can't
 * be known without the broker balance). Python twin: `live_cash.py` /
 * `sleeves.py`.
 */

export type SleeveCash = {
  portfolioId: string;
  slug: string;
  displayName: string;
  /** Spendable cash allowance (portfolio_accounts.cash_usd). */
  allowance: number;
  /** Mark-to-market value of this sleeve's own recorded holdings. */
  holdingsValue: number;
  /** Whether this row is the portfolio the viewer is looking at. */
  isCurrent: boolean;
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

/**
 * The full cash picture for the broker account this live portfolio uses.
 * Owner-only data — callers must pass a verified owner's userId; every query
 * here re-scopes to it. Returns null when the portfolio isn't the caller's
 * live portfolio.
 */
export async function getLiveCashSummary(
  portfolioId: string,
  ownerUserId: string,
): Promise<LiveCashSummary | null> {
  const supabase = getSupabase();

  const { data: current, error: curErr } = await supabase
    .from("portfolios")
    .select("id, slug, display_name, broker_account_key")
    .eq("id", portfolioId)
    .eq("owner_user_id", ownerUserId)
    .eq("mode", "live")
    .maybeSingle();
  if (curErr || !current) {
    if (curErr) console.error("live-cash: portfolio lookup failed:", curErr);
    return null;
  }
  const accountKey = accountKeyFor(current);

  // Every live portfolio of this owner; filter to the same account key in JS
  // because the key is a COALESCE over two columns.
  const { data: liveRows, error: liveErr } = await supabase
    .from("portfolios")
    .select("id, slug, display_name, broker_account_key")
    .eq("owner_user_id", ownerUserId)
    .eq("mode", "live");
  if (liveErr) {
    console.error("live-cash: live portfolios lookup failed:", liveErr);
    return null;
  }
  const sleevePortfolios = (liveRows ?? []).filter(
    (p) => accountKeyFor(p) === accountKey,
  );
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
  // a price contributes 0 — the panel is a cash console, not the MTM of
  // record (portfolio_valuation.py owns that).
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

  const sleeves: SleeveCash[] = sleevePortfolios
    .map((p) => ({
      portfolioId: p.id,
      slug: p.slug,
      displayName: p.display_name,
      allowance: round2(allowanceById.get(p.id) ?? 0),
      holdingsValue: round2(holdingsValueById.get(p.id) ?? 0),
      isCurrent: p.id === current.id,
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
