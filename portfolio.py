"""
Portfolio Manager — virtual trading layer for competing agents.

Each registered agent in the `agents` table can open an `agent_accounts` row
with $1M of starting cash, then buy/sell equities from the `companies`
universe. Current positions live in `agent_holdings`, every fill is journaled
to `agent_trades`, and daily mark-to-market snapshots land in
`agent_portfolio_history` (powering the `agent_leaderboard` view).

v1 simplifications — intentional:
    - Prices are read straight from `companies.price` and treated as USD even
      for non-US listings (some prices are native currency). Accuracy will
      improve when we restrict the universe or add FX conversion.
    - No fees, slippage, shorting, margin, splits, or dividends.
    - Single-writer per agent is assumed — no row-level locking. If this
      grows an HTTP surface, wrap cash debit + holding upsert in a
      transactional RPC to avoid double-spend.
    - Stale prices silently reuse the last close.

Usage (programmatic):

    from db import SupabaseDB
    from portfolio import PortfolioManager

    db = SupabaseDB()
    pm = PortfolioManager(db)
    pm.open_account(agent_id)
    pm.buy(agent_id, "NVDA", 10)
    pm.sell(agent_id, "NVDA", 4)
    print(pm.get_portfolio(agent_id))
"""

from __future__ import annotations

import logging
import time
from datetime import date
from typing import Any

from db import SupabaseDB

logger = logging.getLogger(__name__)

DEFAULT_STARTING_CASH = 1_000_000.00


class PortfolioError(Exception):
    """Raised when a portfolio operation cannot be executed."""


class PortfolioManager:
    """Thin trading layer on top of SupabaseDB."""

    def __init__(self, db: SupabaseDB):
        self.db = db

    # ------------------------------------------------------------------
    # Accounts
    # ------------------------------------------------------------------

    def open_account(
        self,
        agent_id: str,
        starting_cash: float = DEFAULT_STARTING_CASH,
    ) -> dict:
        """Idempotently create an `agent_accounts` row for an agent.

        If an account already exists, returns it unchanged. Otherwise inserts
        a new row with the given starting cash balance.
        """
        existing = self.db.get_agent_account(agent_id)
        if existing:
            logger.info(
                "Account already exists for agent %s (cash=%.2f)",
                agent_id,
                float(existing.get("cash_usd") or 0),
            )
            return existing

        row = {
            "starting_cash": starting_cash,
            "cash_usd": starting_cash,
            "inception_date": date.today().isoformat(),
        }
        self.db.upsert_agent_account(agent_id, row)
        logger.info(
            "Opened account for agent %s with $%.2f starting cash",
            agent_id,
            starting_cash,
        )
        return self.db.get_agent_account(agent_id)

    # ------------------------------------------------------------------
    # Pricing
    # ------------------------------------------------------------------

    def get_price(self, ticker: str) -> float:
        """Return the latest `companies.price` for a ticker (treated as USD)."""
        company = self.db.get_company(ticker)
        if not company:
            raise PortfolioError(f"Unknown ticker: {ticker}")
        price = SupabaseDB.safe_float(company.get("price"))
        if price is None or price <= 0:
            raise PortfolioError(
                f"No usable price for {ticker} (companies.price is null or <=0)"
            )
        return price

    # ------------------------------------------------------------------
    # Trading
    # ------------------------------------------------------------------

    def buy(
        self,
        agent_id: str,
        ticker: str,
        quantity: float,
        note: str = "",
    ) -> dict:
        """Buy `quantity` of `ticker` at the latest price. Cash-settled.

        Rejects if the ticker has no usable price, if quantity <= 0, or if
        the agent lacks the cash to cover the fill. Weighted-average cost
        basis is updated on each buy.
        """
        if quantity <= 0:
            raise PortfolioError(f"buy quantity must be > 0, got {quantity}")

        account = self._require_account(agent_id)
        price = self.get_price(ticker)
        gross = round(quantity * price, 2)
        cash = float(account["cash_usd"])

        if gross > cash:
            raise PortfolioError(
                f"Insufficient cash: need ${gross:.2f}, have ${cash:.2f}"
            )

        new_cash = round(cash - gross, 2)

        # Update / create the holding with weighted-average cost basis.
        existing = self.db.get_agent_holding(agent_id, ticker)
        if existing:
            old_qty = float(existing["quantity"])
            old_cost = float(existing["avg_cost_usd"])
            new_qty = old_qty + quantity
            new_avg_cost = round(
                (old_qty * old_cost + quantity * price) / new_qty, 4
            )
            self.db.upsert_agent_holding(
                {
                    "agent_id": agent_id,
                    "ticker": ticker,
                    "quantity": new_qty,
                    "avg_cost_usd": new_avg_cost,
                    "first_bought_at": existing["first_bought_at"],
                }
            )
        else:
            self.db.upsert_agent_holding(
                {
                    "agent_id": agent_id,
                    "ticker": ticker,
                    "quantity": quantity,
                    "avg_cost_usd": round(price, 4),
                }
            )

        # Debit cash.
        self.db.upsert_agent_account(agent_id, {"cash_usd": new_cash})

        # Journal the trade.
        trade = {
            "agent_id": agent_id,
            "ticker": ticker,
            "side": "buy",
            "quantity": quantity,
            "price_usd": round(price, 4),
            "gross_usd": gross,
            "cash_after_usd": new_cash,
            "note": note,
        }
        self.db.insert_agent_trade(trade)
        logger.info(
            "BUY %s %s @ $%.4f  gross=$%.2f  cash=%.2f",
            agent_id[:8],
            ticker,
            price,
            gross,
            new_cash,
        )
        return trade

    def sell(
        self,
        agent_id: str,
        ticker: str,
        quantity: float,
        note: str = "",
    ) -> dict:
        """Sell `quantity` of `ticker` at the latest price. Cash-settled.

        Rejects if the agent doesn't hold the ticker or lacks the quantity.
        Deletes the holdings row when quantity reaches 0.
        """
        if quantity <= 0:
            raise PortfolioError(f"sell quantity must be > 0, got {quantity}")

        account = self._require_account(agent_id)
        holding = self.db.get_agent_holding(agent_id, ticker)
        if not holding:
            raise PortfolioError(f"No position in {ticker} for agent {agent_id}")

        held = float(holding["quantity"])
        if quantity > held + 1e-9:
            raise PortfolioError(
                f"Cannot sell {quantity} of {ticker}: holding only {held}"
            )

        price = self.get_price(ticker)
        gross = round(quantity * price, 2)
        new_cash = round(float(account["cash_usd"]) + gross, 2)

        remaining = round(held - quantity, 6)
        if remaining <= 1e-9:
            self.db.delete_agent_holding(agent_id, ticker)
        else:
            # avg_cost_usd unchanged on sells (weighted-avg convention).
            self.db.upsert_agent_holding(
                {
                    "agent_id": agent_id,
                    "ticker": ticker,
                    "quantity": remaining,
                    "avg_cost_usd": float(holding["avg_cost_usd"]),
                    "first_bought_at": holding["first_bought_at"],
                }
            )

        self.db.upsert_agent_account(agent_id, {"cash_usd": new_cash})

        trade = {
            "agent_id": agent_id,
            "ticker": ticker,
            "side": "sell",
            "quantity": quantity,
            "price_usd": round(price, 4),
            "gross_usd": gross,
            "cash_after_usd": new_cash,
            "note": note,
        }
        self.db.insert_agent_trade(trade)
        logger.info(
            "SELL %s %s @ $%.4f  gross=$%.2f  cash=%.2f",
            agent_id[:8],
            ticker,
            price,
            gross,
            new_cash,
        )
        return trade

    # ------------------------------------------------------------------
    # Atomic variants — wrap cash-deduct + holding-upsert + trade-insert
    # in a single Postgres transaction with row-level locks via the
    # `execute_atomic_buy` / `execute_atomic_sell` RPCs (migration 019).
    # Required when multiple processes might mutate the same agent
    # concurrently — e.g. the per-ticker matrix workflow that splits
    # one heartbeat across N parallel GHA runners.
    # ------------------------------------------------------------------

    def buy_atomic(
        self,
        agent_id: str,
        ticker: str,
        quantity: float,
        note: str = "",
    ) -> dict:
        """Atomic buy via the `execute_atomic_buy` Supabase RPC.

        Same cash-settlement and weighted-avg-cost semantics as ``buy``,
        but the RPC takes ``SELECT FOR UPDATE`` locks on agent_accounts
        + agent_holdings so concurrent callers cannot oversell cash.

        Returns the RPC result dict. ``status='ok'`` means the trade
        landed; ``status='insufficient_cash'`` means the lock-window
        view of cash didn't cover the buy and no rows were written.
        Raises ``PortfolioError`` on missing price or invalid quantity.
        """
        if quantity <= 0:
            raise PortfolioError(f"buy quantity must be > 0, got {quantity}")
        price = self.get_price(ticker)
        result = self.db.client.rpc(
            "execute_atomic_buy",
            {
                "p_agent_id": agent_id,
                "p_ticker": ticker,
                "p_quantity": quantity,
                "p_price_usd": round(price, 4),
                "p_note": note,
            },
        ).execute()
        data = result.data or {}
        if data.get("status") == "ok":
            logger.info(
                "BUY %s %s @ $%.4f  gross=$%.2f  cash=%.2f  [atomic trade_id=%s]",
                agent_id[:8],
                ticker,
                price,
                float(data.get("gross_usd", 0)),
                float(data.get("new_cash_usd", 0)),
                data.get("trade_id"),
            )
        else:
            logger.warning(
                "BUY %s %s rejected by RPC: %s",
                agent_id[:8], ticker, data,
            )
        return data

    def sell_atomic(
        self,
        agent_id: str,
        ticker: str,
        quantity: float,
        note: str = "",
    ) -> dict:
        """Atomic sell via the `execute_atomic_sell` Supabase RPC.

        Same semantics as ``sell`` but with row-level locks. Returns
        the RPC result dict. ``status='ok'`` is success;
        ``status='no_position'`` and ``status='insufficient_quantity'``
        are recoverable rejections (no rows mutated).
        """
        if quantity <= 0:
            raise PortfolioError(f"sell quantity must be > 0, got {quantity}")
        price = self.get_price(ticker)
        result = self.db.client.rpc(
            "execute_atomic_sell",
            {
                "p_agent_id": agent_id,
                "p_ticker": ticker,
                "p_quantity": quantity,
                "p_price_usd": round(price, 4),
                "p_note": note,
            },
        ).execute()
        data = result.data or {}
        if data.get("status") == "ok":
            logger.info(
                "SELL %s %s @ $%.4f  gross=$%.2f  cash=%.2f  [atomic trade_id=%s]",
                agent_id[:8],
                ticker,
                price,
                float(data.get("gross_usd", 0)),
                float(data.get("new_cash_usd", 0)),
                data.get("trade_id"),
            )
        else:
            logger.warning(
                "SELL %s %s rejected by RPC: %s",
                agent_id[:8], ticker, data,
            )
        return data

    # ------------------------------------------------------------------
    # Valuation
    # ------------------------------------------------------------------

    def get_portfolio(self, agent_id: str) -> dict:
        """Return current portfolio with mark-to-market valuation.

        Returns:
            {
                "agent_id": ...,
                "cash_usd": float,
                "starting_cash": float,
                "holdings": [{ticker, quantity, avg_cost_usd, price_usd,
                              market_value_usd, unrealized_pnl_usd}, ...],
                "holdings_value_usd": float,
                "total_value_usd": float,
                "pnl_usd": float,
                "pnl_pct": float,
            }
        """
        account = self._require_account(agent_id)
        holdings = self.db.get_agent_holdings(agent_id)

        cash = float(account["cash_usd"])
        starting = float(account["starting_cash"])

        enriched = []
        holdings_value = 0.0
        for h in holdings:
            qty = float(h["quantity"])
            avg_cost = float(h["avg_cost_usd"])
            try:
                price = self.get_price(h["ticker"])
            except PortfolioError:
                # Price unavailable — fall back to avg cost so the row still
                # shows up. Flagged so the caller can surface it.
                price = avg_cost
            mv = round(qty * price, 2)
            holdings_value += mv
            enriched.append(
                {
                    "ticker": h["ticker"],
                    "quantity": qty,
                    "avg_cost_usd": avg_cost,
                    "price_usd": round(price, 4),
                    "market_value_usd": mv,
                    "unrealized_pnl_usd": round((price - avg_cost) * qty, 2),
                }
            )

        holdings_value = round(holdings_value, 2)
        total = round(cash + holdings_value, 2)
        pnl = round(total - starting, 2)
        pnl_pct = round((pnl / starting) * 100, 4) if starting else 0.0

        return {
            "agent_id": agent_id,
            "cash_usd": cash,
            "starting_cash": starting,
            "holdings": enriched,
            "holdings_value_usd": holdings_value,
            "total_value_usd": total,
            "pnl_usd": pnl,
            "pnl_pct": pnl_pct,
        }

    def snapshot_all(
        self,
        as_of: date | None = None,
        dry_run: bool = False,
        agent_handle: str | None = None,
    ) -> dict[str, Any]:
        """Compute and persist daily MTM snapshots for every agent account.

        Returns a stats dict suitable for `SupabaseDB.log_run()`.
        """
        start_ts = time.time()
        snapshot_date = (as_of or date.today()).isoformat()

        if agent_handle:
            agent = self.db.get_agent_by_handle(agent_handle)
            if not agent:
                raise PortfolioError(f"Unknown agent handle: {agent_handle}")
            account = self.db.get_agent_account(agent["id"])
            accounts = [account] if account else []
        else:
            accounts = self.db.get_all_agent_accounts()

        updated = 0
        errors = 0
        skipped = 0
        details: list[dict] = []

        for acc in accounts:
            agent_id = acc["agent_id"]
            try:
                portfolio = self.get_portfolio(agent_id)
                row = {
                    "agent_id": agent_id,
                    "snapshot_date": snapshot_date,
                    "cash_usd": portfolio["cash_usd"],
                    "holdings_value_usd": portfolio["holdings_value_usd"],
                    "total_value_usd": portfolio["total_value_usd"],
                    "pnl_usd": portfolio["pnl_usd"],
                    "pnl_pct": portfolio["pnl_pct"],
                    "num_positions": len(portfolio["holdings"]),
                }
                if dry_run:
                    logger.info("[dry-run] %s", row)
                    skipped += 1
                else:
                    self.db.upsert_portfolio_snapshot(row)
                    updated += 1
                details.append(
                    {
                        "agent_id": agent_id,
                        "total_value_usd": portfolio["total_value_usd"],
                        "pnl_pct": portfolio["pnl_pct"],
                        "num_positions": len(portfolio["holdings"]),
                    }
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Snapshot failed for %s: %s", agent_id, exc)
                errors += 1
                details.append({"agent_id": agent_id, "error": str(exc)})

        return {
            "updated": updated,
            "skipped": skipped,
            "errors": errors,
            "duration_secs": round(time.time() - start_ts, 1),
            "details": {"snapshot_date": snapshot_date, "agents": details},
        }

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _require_account(self, agent_id: str) -> dict:
        account = self.db.get_agent_account(agent_id)
        if not account:
            raise PortfolioError(
                f"No agent_accounts row for {agent_id} — call open_account() first"
            )
        return account
