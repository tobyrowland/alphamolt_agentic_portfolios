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


def _thesis_kwargs(thesis: dict | None) -> dict:
    """Normalise the optional ``thesis`` kwarg into ``record_thesis`` args.

    Accepts ``None`` (snapshot-only), or a dict with any subset of
    ``thesis_text`` / ``extend_signals`` / ``break_signals``. Unknown
    keys are ignored so callers can pass extra metadata without breaking.
    """
    if not thesis:
        return {}
    return {
        "thesis_text": thesis.get("thesis_text"),
        "extend_signals": thesis.get("extend_signals"),
        "break_signals": thesis.get("break_signals"),
    }


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

        Also creates a 1:1 `portfolios` row (slug = agent.handle,
        display_name = agent.display_name) and a `portfolio_agents`
        row linking the agent as the sole member. Idempotent.

        If an account already exists, returns it unchanged but still
        ensures the portfolio + membership exist (helps backfill old
        accounts created before migration 021).
        """
        existing = self.db.get_agent_account(agent_id)
        if existing:
            logger.info(
                "Account already exists for agent %s (cash=%.2f)",
                agent_id,
                float(existing.get("cash_usd") or 0),
            )
            self._ensure_portfolio_for_agent(agent_id)
            return existing

        row = {
            "starting_cash": starting_cash,
            "cash_usd": starting_cash,
            "inception_date": date.today().isoformat(),
            # portfolio_id is set after we create/fetch the portfolio below
        }
        self.db.upsert_agent_account(agent_id, row)
        logger.info(
            "Opened account for agent %s with $%.2f starting cash",
            agent_id,
            starting_cash,
        )
        portfolio_id = self._ensure_portfolio_for_agent(agent_id)
        # Backfill portfolio_id on the just-created account row.
        self.db.upsert_agent_account(agent_id, {"portfolio_id": portfolio_id})
        return self.db.get_agent_account(agent_id)

    def _ensure_portfolio_for_agent(self, agent_id: str) -> str:
        """Ensure (portfolios, portfolio_agents) rows exist for an agent.

        Returns the portfolio_id. Idempotent — if a portfolio already
        exists (owned by this agent or fetched as their default
        membership) it's reused without changes.
        """
        existing = self.db.get_portfolio_by_agent_id(agent_id)
        if existing:
            return existing["id"]

        agent = self.db.client.table("agents").select("*").eq("id", agent_id).limit(1).execute().data
        if not agent:
            raise PortfolioError(f"No agents row for id={agent_id}")
        a = agent[0]
        portfolio = self.db.create_portfolio(
            portfolio_id=agent_id,                 # 1:1 shim: portfolio_id = agent_id
            slug=a["handle"],
            display_name=a["display_name"],
            owner_agent_id=agent_id,
            description=a.get("description"),
        )
        self.db.add_portfolio_member(
            portfolio_id=portfolio["id"],
            agent_id=agent_id,
            notes=None,
        )
        logger.info(
            "Created portfolio %s (slug=%s) owned by agent %s",
            portfolio["id"], portfolio["slug"], agent_id,
        )
        return portfolio["id"]

    def _portfolio_for_agent(self, agent_id: str) -> str:
        """Resolve the portfolio_id an agent's trade should be attributed to.

        First call after migration 021 creates the portfolio lazily. After
        that the lookup is a cheap single-row fetch. Raises
        ``PortfolioError`` if no portfolio can be resolved (shouldn't
        happen once open_account has been called).
        """
        existing = self.db.get_portfolio_by_agent_id(agent_id)
        if existing:
            return existing["id"]
        return self._ensure_portfolio_for_agent(agent_id)

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
        *,
        thesis: dict | None = None,
    ) -> dict:
        """Buy `quantity` of `ticker` at the latest price. Cash-settled.

        Rejects if the ticker has no usable price, if quantity <= 0, or if
        the agent lacks the cash to cover the fill. Weighted-average cost
        basis is updated on each buy.

        Every successful BUY records an ``investment_theses`` row with
        a frozen snapshot of the equity's state (mandatory). When
        ``thesis`` is provided, the row also stores the agent's
        narrative + extend/break signals; otherwise it's a
        snapshot-only ``source='auto'`` row.
        """
        if quantity <= 0:
            raise PortfolioError(f"buy quantity must be > 0, got {quantity}")

        account = self._require_account(agent_id)
        portfolio_id = self._portfolio_for_agent(agent_id)
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
                    "portfolio_id": portfolio_id,
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
                    "portfolio_id": portfolio_id,
                    "ticker": ticker,
                    "quantity": quantity,
                    "avg_cost_usd": round(price, 4),
                }
            )

        # Debit cash.
        self.db.upsert_agent_account(agent_id, {
            "cash_usd": new_cash,
            "portfolio_id": portfolio_id,
        })

        # Journal the trade.
        trade = {
            "agent_id": agent_id,
            "portfolio_id": portfolio_id,
            "ticker": ticker,
            "side": "buy",
            "quantity": quantity,
            "price_usd": round(price, 4),
            "gross_usd": gross,
            "cash_after_usd": new_cash,
            "note": note,
        }
        trade_id = self.db.insert_agent_trade(trade)
        logger.info(
            "BUY %s %s @ $%.4f  gross=$%.2f  cash=%.2f",
            agent_id[:8],
            ticker,
            price,
            gross,
            new_cash,
        )

        # Mandatory snapshot capture; agent thesis text passed through if provided.
        try:
            import theses
            theses.record_thesis(
                self.db,
                agent_id=agent_id,
                portfolio_id=portfolio_id,
                ticker=ticker,
                trade_id=trade_id,
                **_thesis_kwargs(thesis),
            )
        except Exception as exc:  # noqa: BLE001 — never block a trade on thesis I/O
            logger.warning(
                "BUY %s %s: thesis record failed (trade still succeeded): %s",
                agent_id[:8], ticker, exc,
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
        portfolio_id = self._portfolio_for_agent(agent_id)
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
        position_zeroed = remaining <= 1e-9
        if position_zeroed:
            self.db.delete_agent_holding(agent_id, ticker)
        else:
            # avg_cost_usd unchanged on sells (weighted-avg convention).
            self.db.upsert_agent_holding(
                {
                    "agent_id": agent_id,
                    "portfolio_id": portfolio_id,
                    "ticker": ticker,
                    "quantity": remaining,
                    "avg_cost_usd": float(holding["avg_cost_usd"]),
                    "first_bought_at": holding["first_bought_at"],
                }
            )

        self.db.upsert_agent_account(agent_id, {
            "cash_usd": new_cash,
            "portfolio_id": portfolio_id,
        })

        trade = {
            "agent_id": agent_id,
            "portfolio_id": portfolio_id,
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

        # Close any open theses if the position is fully exited. Idempotent.
        if position_zeroed:
            try:
                import theses
                theses.close_theses_for_position(
                    self.db,
                    agent_id=agent_id,
                    portfolio_id=portfolio_id,
                    ticker=ticker,
                )
            except Exception as exc:  # noqa: BLE001 — never block a sell on thesis I/O
                logger.warning(
                    "SELL %s %s: thesis close failed (sell still succeeded): %s",
                    agent_id[:8], ticker, exc,
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
        *,
        thesis: dict | None = None,
    ) -> dict:
        """Atomic buy via the `execute_atomic_buy` Supabase RPC.

        Same cash-settlement and weighted-avg-cost semantics as ``buy``,
        but the RPC takes ``SELECT FOR UPDATE`` locks on agent_accounts
        + agent_holdings so concurrent callers cannot oversell cash.

        Returns the RPC result dict. ``status='ok'`` means the trade
        landed; ``status='insufficient_cash'`` means the lock-window
        view of cash didn't cover the buy and no rows were written.
        Raises ``PortfolioError`` on missing price or invalid quantity.

        On ``status='ok'``, records an ``investment_theses`` row with
        the snapshot (always) + optional ``thesis`` payload (when
        provided). Same contract as ``buy``.
        """
        if quantity <= 0:
            raise PortfolioError(f"buy quantity must be > 0, got {quantity}")
        price = self.get_price(ticker)
        # Resolve the portfolio up-front so thesis recording links correctly.
        # As of migration 022 the atomic_buy RPC itself reads portfolio_id
        # from agent_accounts and writes it on every row, so no post-trade
        # backfill is needed.
        portfolio_id = self._portfolio_for_agent(agent_id)
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
            try:
                import theses
                theses.record_thesis(
                    self.db,
                    agent_id=agent_id,
                    portfolio_id=portfolio_id,
                    ticker=ticker,
                    trade_id=data.get("trade_id"),
                    **_thesis_kwargs(thesis),
                )
            except Exception as exc:  # noqa: BLE001 — never block a trade on thesis I/O
                logger.warning(
                    "BUY %s %s: thesis record failed (trade still succeeded): %s",
                    agent_id[:8], ticker, exc,
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
        portfolio_id = self._portfolio_for_agent(agent_id)
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
            # Close any open theses if the position is fully exited.
            # The atomic sell RPC returns the post-trade quantity in
            # ``remaining_quantity`` (see migrations/019).
            if float(data.get("remaining_quantity", 0) or 0) <= 1e-9:
                try:
                    import theses
                    theses.close_theses_for_position(
                        self.db,
                        agent_id=agent_id,
                        portfolio_id=portfolio_id,
                        ticker=ticker,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "SELL %s %s: thesis close failed (sell still succeeded): %s",
                        agent_id[:8], ticker, exc,
                    )
        else:
            logger.warning(
                "SELL %s %s rejected by RPC: %s",
                agent_id[:8], ticker, data,
            )
        return data

    # ------------------------------------------------------------------
    # Portfolio-level trading (migration 025) — shared-pot cash + holdings
    # for human-owned portfolios. One cash balance per portfolio, traded
    # by all its member agents; each fill records the executing agent.
    # ------------------------------------------------------------------

    def open_portfolio_account(
        self,
        portfolio_id: str,
        starting_cash: float = DEFAULT_STARTING_CASH,
    ) -> dict:
        """Idempotently create a `portfolio_accounts` row for a portfolio."""
        existing = self.db.get_portfolio_account(portfolio_id)
        if existing:
            return existing
        self.db.upsert_portfolio_account(portfolio_id, {
            "starting_cash": starting_cash,
            "cash_usd": starting_cash,
            "inception_date": date.today().isoformat(),
        })
        logger.info(
            "Opened portfolio account %s with $%.2f starting cash",
            portfolio_id, starting_cash,
        )
        return self.db.get_portfolio_account(portfolio_id)

    def _require_portfolio_account(self, portfolio_id: str) -> dict:
        account = self.db.get_portfolio_account(portfolio_id)
        if not account:
            raise PortfolioError(
                f"No portfolio_accounts row for {portfolio_id} — "
                "portfolio not launched"
            )
        return account

    def buy_portfolio(
        self,
        portfolio_id: str,
        agent_id: str,
        ticker: str,
        quantity: float,
        note: str = "",
        *,
        thesis: dict | None = None,
    ) -> dict:
        """Buy into a shared-pot portfolio. ``agent_id`` is the executing member.

        Same cash-settlement and weighted-avg-cost semantics as ``buy``, but
        debits ``portfolio_accounts`` and upserts ``portfolio_holdings``.
        """
        if quantity <= 0:
            raise PortfolioError(f"buy quantity must be > 0, got {quantity}")

        account = self._require_portfolio_account(portfolio_id)
        price = self.get_price(ticker)
        gross = round(quantity * price, 2)
        cash = float(account["cash_usd"])
        if gross > cash:
            raise PortfolioError(
                f"Insufficient cash: need ${gross:.2f}, have ${cash:.2f}"
            )
        new_cash = round(cash - gross, 2)

        existing = self.db.get_portfolio_holding(portfolio_id, ticker)
        if existing:
            old_qty = float(existing["quantity"])
            old_cost = float(existing["avg_cost_usd"])
            new_qty = old_qty + quantity
            new_avg_cost = round(
                (old_qty * old_cost + quantity * price) / new_qty, 4
            )
            self.db.upsert_portfolio_holding({
                "portfolio_id": portfolio_id,
                "ticker": ticker,
                "quantity": new_qty,
                "avg_cost_usd": new_avg_cost,
                "first_bought_at": existing["first_bought_at"],
            })
        else:
            self.db.upsert_portfolio_holding({
                "portfolio_id": portfolio_id,
                "ticker": ticker,
                "quantity": quantity,
                "avg_cost_usd": round(price, 4),
            })

        self.db.upsert_portfolio_account(portfolio_id, {"cash_usd": new_cash})

        trade = {
            "agent_id": agent_id,
            "portfolio_id": portfolio_id,
            "ticker": ticker,
            "side": "buy",
            "quantity": quantity,
            "price_usd": round(price, 4),
            "gross_usd": gross,
            "cash_after_usd": new_cash,
            "note": note,
        }
        trade_id = self.db.insert_agent_trade(trade)
        logger.info(
            "BUY [pf %s] %s %s @ $%.4f  gross=$%.2f  cash=%.2f",
            portfolio_id[:8], agent_id[:8], ticker, price, gross, new_cash,
        )
        try:
            import theses
            theses.record_thesis(
                self.db,
                agent_id=agent_id,
                portfolio_id=portfolio_id,
                ticker=ticker,
                trade_id=trade_id,
                **_thesis_kwargs(thesis),
            )
        except Exception as exc:  # noqa: BLE001 — never block a trade on thesis I/O
            logger.warning(
                "BUY [pf %s] %s: thesis record failed (trade still succeeded): %s",
                portfolio_id[:8], ticker, exc,
            )
        return trade

    def sell_portfolio(
        self,
        portfolio_id: str,
        agent_id: str,
        ticker: str,
        quantity: float,
        note: str = "",
    ) -> dict:
        """Sell from a shared-pot portfolio. ``agent_id`` is the executing member."""
        if quantity <= 0:
            raise PortfolioError(f"sell quantity must be > 0, got {quantity}")

        account = self._require_portfolio_account(portfolio_id)
        holding = self.db.get_portfolio_holding(portfolio_id, ticker)
        if not holding:
            raise PortfolioError(
                f"No position in {ticker} for portfolio {portfolio_id}"
            )
        held = float(holding["quantity"])
        if quantity > held + 1e-9:
            raise PortfolioError(
                f"Cannot sell {quantity} of {ticker}: holding only {held}"
            )

        price = self.get_price(ticker)
        gross = round(quantity * price, 2)
        new_cash = round(float(account["cash_usd"]) + gross, 2)

        remaining = round(held - quantity, 6)
        position_zeroed = remaining <= 1e-9
        if position_zeroed:
            self.db.delete_portfolio_holding(portfolio_id, ticker)
        else:
            self.db.upsert_portfolio_holding({
                "portfolio_id": portfolio_id,
                "ticker": ticker,
                "quantity": remaining,
                "avg_cost_usd": float(holding["avg_cost_usd"]),
                "first_bought_at": holding["first_bought_at"],
            })

        self.db.upsert_portfolio_account(portfolio_id, {"cash_usd": new_cash})

        trade = {
            "agent_id": agent_id,
            "portfolio_id": portfolio_id,
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
            "SELL [pf %s] %s %s @ $%.4f  gross=$%.2f  cash=%.2f",
            portfolio_id[:8], agent_id[:8], ticker, price, gross, new_cash,
        )
        if position_zeroed:
            try:
                import theses
                theses.close_theses_for_position(
                    self.db,
                    agent_id=agent_id,
                    portfolio_id=portfolio_id,
                    ticker=ticker,
                )
            except Exception as exc:  # noqa: BLE001 — never block a sell on thesis I/O
                logger.warning(
                    "SELL [pf %s] %s: thesis close failed (sell still succeeded): %s",
                    portfolio_id[:8], ticker, exc,
                )
        return trade

    def buy_portfolio_atomic(
        self,
        portfolio_id: str,
        agent_id: str,
        ticker: str,
        quantity: float,
        note: str = "",
        *,
        thesis: dict | None = None,
        price_override: float | None = None,
    ) -> dict:
        """Atomic shared-pot buy via the ``execute_portfolio_buy`` RPC.

        ``price_override`` records the trade at a caller-supplied price instead
        of ``companies.price`` — used by the live (Alpaca) execution path to
        book the *actual fill price* rather than the paper estimate.
        """
        if quantity <= 0:
            raise PortfolioError(f"buy quantity must be > 0, got {quantity}")
        price = price_override if price_override is not None else self.get_price(ticker)
        result = self.db.client.rpc(
            "execute_portfolio_buy",
            {
                "p_portfolio_id": portfolio_id,
                "p_agent_id": agent_id,
                "p_ticker": ticker,
                "p_quantity": quantity,
                "p_price_usd": round(price, 4),
                "p_note": note,
            },
        ).execute()
        data = result.data or {}
        if data.get("status") == "ok":
            try:
                import theses
                theses.record_thesis(
                    self.db,
                    agent_id=agent_id,
                    portfolio_id=portfolio_id,
                    ticker=ticker,
                    trade_id=data.get("trade_id"),
                    **_thesis_kwargs(thesis),
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "BUY [pf %s] %s: thesis record failed: %s",
                    portfolio_id[:8], ticker, exc,
                )
        else:
            logger.warning(
                "BUY [pf %s] %s rejected by RPC: %s",
                portfolio_id[:8], ticker, data,
            )
        return data

    def sell_portfolio_atomic(
        self,
        portfolio_id: str,
        agent_id: str,
        ticker: str,
        quantity: float,
        note: str = "",
        *,
        price_override: float | None = None,
    ) -> dict:
        """Atomic shared-pot sell via the ``execute_portfolio_sell`` RPC.

        ``price_override`` books the sell at the caller-supplied price (the
        live Alpaca fill price) instead of ``companies.price``.
        """
        if quantity <= 0:
            raise PortfolioError(f"sell quantity must be > 0, got {quantity}")
        price = price_override if price_override is not None else self.get_price(ticker)
        result = self.db.client.rpc(
            "execute_portfolio_sell",
            {
                "p_portfolio_id": portfolio_id,
                "p_agent_id": agent_id,
                "p_ticker": ticker,
                "p_quantity": quantity,
                "p_price_usd": round(price, 4),
                "p_note": note,
            },
        ).execute()
        data = result.data or {}
        if data.get("status") == "ok":
            if float(data.get("remaining_quantity", 0) or 0) <= 1e-9:
                try:
                    import theses
                    theses.close_theses_for_position(
                        self.db,
                        agent_id=agent_id,
                        portfolio_id=portfolio_id,
                        ticker=ticker,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "SELL [pf %s] %s: thesis close failed: %s",
                        portfolio_id[:8], ticker, exc,
                    )
        else:
            logger.warning(
                "SELL [pf %s] %s rejected by RPC: %s",
                portfolio_id[:8], ticker, data,
            )
        return data

    def get_portfolio_book(self, portfolio_id: str) -> dict:
        """Mark-to-market a shared-pot portfolio.

        Returns the same dict shape as ``get_portfolio`` (cash, holdings,
        total/pnl) so strategy code is agnostic to the account model.
        """
        account = self._require_portfolio_account(portfolio_id)
        holdings = self.db.get_portfolio_holdings(portfolio_id)

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
            "portfolio_id": portfolio_id,
            "cash_usd": cash,
            "starting_cash": starting,
            "holdings": enriched,
            "holdings_value_usd": holdings_value,
            "total_value_usd": total,
            "pnl_usd": pnl,
            "pnl_pct": pnl_pct,
        }

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
            # Resolve the portfolio_id for the snapshot row. Falls back to
            # agent_id during the shim period if no portfolio exists yet.
            portfolio_id = acc.get("portfolio_id") or agent_id
            try:
                portfolio = self.get_portfolio(agent_id)
                row = {
                    "agent_id": agent_id,
                    "portfolio_id": portfolio_id,
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
                        "portfolio_id": portfolio_id,
                        "total_value_usd": portfolio["total_value_usd"],
                        "pnl_pct": portfolio["pnl_pct"],
                        "num_positions": len(portfolio["holdings"]),
                    }
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Snapshot failed for %s: %s", agent_id, exc)
                errors += 1
                details.append({"agent_id": agent_id, "error": str(exc)})

        # Migration 025: snapshot launched human-owned portfolios (shared-pot).
        # Skipped when scoped to a single agent handle.
        if not agent_handle:
            for pacc in self.db.get_all_portfolio_accounts():
                portfolio_id = pacc["portfolio_id"]
                try:
                    book = self.get_portfolio_book(portfolio_id)
                    row = {
                        "portfolio_id": portfolio_id,
                        "snapshot_date": snapshot_date,
                        "cash_usd": book["cash_usd"],
                        "holdings_value_usd": book["holdings_value_usd"],
                        "total_value_usd": book["total_value_usd"],
                        "pnl_usd": book["pnl_usd"],
                        "pnl_pct": book["pnl_pct"],
                        "num_positions": len(book["holdings"]),
                    }
                    if dry_run:
                        logger.info("[dry-run] %s", row)
                        skipped += 1
                    else:
                        self.db.upsert_portfolio_snapshot(row)
                        updated += 1
                    details.append({
                        "portfolio_id": portfolio_id,
                        "total_value_usd": book["total_value_usd"],
                        "pnl_pct": book["pnl_pct"],
                        "num_positions": len(book["holdings"]),
                    })
                except Exception as exc:  # noqa: BLE001
                    logger.exception(
                        "Snapshot failed for portfolio %s: %s",
                        portfolio_id, exc,
                    )
                    errors += 1
                    details.append(
                        {"portfolio_id": portfolio_id, "error": str(exc)}
                    )

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
