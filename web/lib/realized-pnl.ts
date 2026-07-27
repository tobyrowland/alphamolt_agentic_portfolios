/**
 * Realized P&L for a sell, reconstructed at read time from the immutable trade
 * tape — so it needs no schema change and applies to every historical sell.
 *
 * The cost basis is a weighted average that is left unchanged on sells, exactly
 * the convention the trading layer writes with (`portfolio.py`: "avg_cost_usd
 * unchanged on sells") and that `badges.reconstruct_round_trips` replays. Each
 * sell's realized gain/loss is `(sell_price − avg_cost) × qty_sold`, and the
 * return is `sell_price / avg_cost − 1`.
 *
 * `realizedPnlByTrade` reconstructs over ONE book's trades (one portfolio, or
 * one agent account). A surface that mixes books — e.g. the per-company tape,
 * where each sell belongs to a different portfolio — must group by book first
 * and call this per group (the cost basis is per book).
 */

export interface RealizedPnl {
  /** Realized dollar gain (+) or loss (−) on this sell. */
  usd: number;
  /** Return vs cost basis, in percent; null when the basis is unknown/zero. */
  pct: number | null;
}

export interface PnlTrade {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  price_usd: number;
  executed_at: string;
}

/**
 * Map of sell-trade id → realized P&L, replaying the given book's trades in
 * chronological order (buys before sells within the same instant, matching the
 * Python reconstruction). Buys produce no entry.
 */
export function realizedPnlByTrade(trades: PnlTrade[]): Map<string, RealizedPnl> {
  const byTicker = new Map<string, PnlTrade[]>();
  for (const t of trades) {
    if (!t.ticker) continue;
    let bucket = byTicker.get(t.ticker);
    if (!bucket) {
      bucket = [];
      byTicker.set(t.ticker, bucket);
    }
    bucket.push(t);
  }

  const out = new Map<string, RealizedPnl>();
  for (const bucket of byTicker.values()) {
    bucket.sort((a, b) => {
      const da = Date.parse(a.executed_at);
      const db = Date.parse(b.executed_at);
      if (da !== db) return da - db;
      // Same instant: apply buys before sells (can't sell what isn't held yet).
      return (a.side === "buy" ? 0 : 1) - (b.side === "buy" ? 0 : 1);
    });

    let qty = 0; // open shares
    let cost = 0; // total cost of open shares (qty × weighted-avg cost)
    for (const t of bucket) {
      const q = Number(t.quantity);
      const px = Number(t.price_usd);
      if (!(q > 0) || !Number.isFinite(px)) continue;
      if (t.side === "buy") {
        qty += q;
        cost += q * px;
      } else {
        if (qty <= 1e-9) continue; // nothing open to sell (bad data) — skip
        const sellQty = Math.min(q, qty);
        const avg = cost / qty;
        out.set(t.id, {
          usd: (px - avg) * sellQty,
          pct: avg > 0 ? (px / avg - 1) * 100 : null,
        });
        qty -= sellQty;
        cost -= avg * sellQty;
      }
    }
  }
  return out;
}

const MINUS = "−"; // proper minus sign, matches the site's numeric styling

/** "+$1,240" / "−$320" — signed, whole dollars, thousands-separated. */
export function formatPnlUsd(usd: number): string {
  const sign = usd < 0 ? MINUS : "+";
  return `${sign}$${Math.abs(Math.round(usd)).toLocaleString("en-US")}`;
}

/** "+12.4%" / "−4.1%" — signed, one decimal. */
export function formatPnlPct(pct: number): string {
  const sign = pct < 0 ? MINUS : "+";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** "+$1,240 (+12.4%)" — the money, plus the return when known. */
export function formatRealizedPnl(pnl: RealizedPnl): string {
  const money = formatPnlUsd(pnl.usd);
  return pnl.pct == null ? money : `${money} (${formatPnlPct(pnl.pct)})`;
}
