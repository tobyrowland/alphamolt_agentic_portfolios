import Link from "next/link";
import { formatNumber } from "@/lib/constants";

/**
 * A single executed trade, joined to the agent that executed it. Shared
 * shape for the company-page trade tape and the portfolio-page recent
 * trades section.
 */
export interface Trade {
  id: string;
  handle: string;
  display_name: string;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  price_usd: number;
  executed_at: string;
  note: string | null;
}

/**
 * Reverse-chronological list of trades rendered as a glass card. The
 * caller supplies its own `<h2>` heading (and wrapping `<section>`) so
 * the same component reads naturally on both the company page ("Recent
 * AI Agent Trades in NVDA") and the portfolio page ("Recent trades").
 */
export function TradeTape({
  trades,
  totalTrades,
  emptyLabel = "No trades recorded yet.",
  showTicker = true,
}: {
  trades: Trade[];
  totalTrades: number;
  emptyLabel?: string;
  showTicker?: boolean;
}) {
  if (trades.length === 0) {
    return (
      <div className="glass-card rounded-lg p-4 text-sm text-text-muted">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="glass-card rounded-lg overflow-hidden">
      <ul className="divide-y divide-border/40">
        {trades.map((t) => (
          <TradeRow key={t.id} trade={t} showTicker={showTicker} />
        ))}
      </ul>
      {totalTrades > trades.length && (
        <p className="px-4 py-3 text-xs font-mono text-text-muted border-t border-border/40">
          Showing the {trades.length} most recent of{" "}
          {totalTrades.toLocaleString("en-US")} trades.
        </p>
      )}
    </div>
  );
}

function TradeRow({
  trade,
  showTicker,
}: {
  trade: Trade;
  showTicker: boolean;
}) {
  const isBuy = trade.side === "buy";
  const stripeColor = isBuy ? "#00FF41" : "#FF3333";
  const sideLabel = isBuy ? "BOUGHT" : "SOLD";
  const ago = formatRelative(trade.executed_at);

  return (
    <li
      className="pl-3 pr-4 py-3 flex flex-col gap-1"
      style={{ borderLeft: `3px solid ${stripeColor}` }}
    >
      <div className="flex flex-wrap items-baseline gap-2 text-sm font-mono">
        <Link
          href={`/agents/${trade.handle}`}
          className="text-text font-bold hover:text-green"
        >
          [{trade.display_name}]
        </Link>
        <span className="font-bold" style={{ color: stripeColor }}>
          {sideLabel}
        </span>
        {showTicker && (
          <Link
            href={`/company/${trade.ticker}`}
            className="text-text font-bold hover:text-green"
          >
            {trade.ticker}
          </Link>
        )}
        <span className="text-text-dim">
          {formatNumber(trade.quantity, { decimals: 0 })} @ $
          {trade.price_usd.toFixed(2)}
        </span>
        <span className="text-text-muted text-xs">· {ago}</span>
      </div>
      {trade.note && (
        <p className="text-xs text-text-muted italic pl-1 leading-relaxed">
          {trade.note}
        </p>
      )}
    </li>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.max(0, Math.floor(diffMs / (1000 * 60)));
  return `${mins}m ago`;
}
