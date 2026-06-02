#!/usr/bin/env python3
"""
Alpaca execution backend — the seam between AlphaMolt's trade *decisions*
and a real broker.

Today every strategy funnels its decisions through
``PortfolioManager.buy/sell`` -> the ``execute_portfolio_buy/_sell`` Supabase
RPCs, which move *paper* cash and holdings. This module adds a parallel
execution target: an Alpaca account. The intent is that a single portfolio
flagged ``live`` mirrors the same buy/sell decisions into Alpaca orders, then
reconciles real fills/positions/cash back.

SPIKE STATUS (read me):
    - Scope is ONE account (yours), via the Alpaca *Trading API*, against the
      *paper* sandbox. Nothing here is wired into agent_heartbeat.py yet, so
      the swarm cannot place a real order by accident — execution is manual
      via this CLI until the loop is proven and the go-live decision is made.
    - ``reconcile`` is READ-ONLY: it reports the diff between Alpaca and the
      AlphaMolt portfolio; it does not write the DB. Writing real fills back
      into portfolio_holdings/accounts (replacing the v1 "all USD, no
      fees/slippage" estimates with actual fills) is the next step and is
      marked TODO below.
    - Order submission refuses to run against the LIVE endpoint unless the
      caller passes an explicit confirmation flag.

CLI:
    python alpaca_execution.py --status
    python alpaca_execution.py --positions
    python alpaca_execution.py --orders
    python alpaca_execution.py --buy AAPL 1
    python alpaca_execution.py --sell AAPL 1
    python alpaca_execution.py --reconcile <portfolio-slug>
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass

from alpaca_client import AlpacaClient, AlpacaError
from db import SupabaseDB

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)


@dataclass
class Fill:
    """Normalised result of submitting an order."""

    order_id: str
    symbol: str
    side: str
    qty: float
    status: str


class AlpacaExecutionBackend:
    """Routes buy/sell decisions to an Alpaca account.

    Mirrors ``PortfolioManager``'s buy/sell shape so it can later be dropped
    in behind the same interface for a ``live``-flagged portfolio.
    """

    def __init__(self, client: AlpacaClient | None = None):
        self.client = client or AlpacaClient()

    def _guard_live(self, allow_live: bool) -> None:
        if not self.client.is_paper and not allow_live:
            raise AlpacaError(
                "Refusing to trade against the LIVE endpoint. Re-run with "
                "--i-understand-live to place a real-money order."
            )

    def buy(self, symbol: str, qty: float, *, allow_live: bool = False) -> Fill:
        self._guard_live(allow_live)
        order = self.client.submit_order(symbol, "buy", qty=qty)
        logger.info("BUY %s x%s -> order %s (%s)",
                    symbol, qty, order["id"], order["status"])
        return self._to_fill(order)

    def sell(self, symbol: str, qty: float, *, allow_live: bool = False) -> Fill:
        self._guard_live(allow_live)
        order = self.client.submit_order(symbol, "sell", qty=qty)
        logger.info("SELL %s x%s -> order %s (%s)",
                    symbol, qty, order["id"], order["status"])
        return self._to_fill(order)

    @staticmethod
    def _to_fill(order: dict) -> Fill:
        return Fill(
            order_id=order["id"],
            symbol=order["symbol"],
            side=order["side"],
            qty=float(order.get("qty") or 0),
            status=order["status"],
        )

    # ------------------------------------------------------------------
    # Reconciliation (read-only in the spike)
    # ------------------------------------------------------------------

    def reconcile(self, db: SupabaseDB, portfolio_slug: str) -> None:
        """Report the diff between the Alpaca account and an AlphaMolt portfolio.

        Read-only. Compares per-symbol quantity and the cash balance so we can
        see exactly what a sync would have to do, without touching the DB.
        """
        portfolio = db.get_portfolio_by_slug(portfolio_slug)
        if not portfolio:
            raise AlpacaError(f"portfolio not found: {portfolio_slug!r}")
        pid = portfolio["id"]

        account = self.client.get_account()
        alpaca_cash = float(account.get("cash") or 0)
        alpaca_pos = {
            p["symbol"]: float(p["qty"]) for p in self.client.list_positions()
        }

        db_account = db.get_portfolio_account(pid) or {}
        db_cash = float(db_account.get("cash_usd") or 0)
        db_pos = {
            h["ticker"]: float(h["quantity"])
            for h in db.get_portfolio_holdings(pid)
        }

        print(f"\nReconcile  portfolio={portfolio_slug}  "
              f"alpaca={'PAPER' if self.client.is_paper else 'LIVE'}\n")
        print(f"  cash   alphamolt=${db_cash:,.2f}   alpaca=${alpaca_cash:,.2f}   "
              f"delta=${alpaca_cash - db_cash:,.2f}")

        symbols = sorted(set(alpaca_pos) | set(db_pos))
        if not symbols:
            print("  positions: none on either side")
        else:
            print(f"\n  {'symbol':<10}{'alphamolt':>12}{'alpaca':>12}{'delta':>12}")
            for s in symbols:
                a = alpaca_pos.get(s, 0.0)
                d = db_pos.get(s, 0.0)
                print(f"  {s:<10}{d:>12.2f}{a:>12.2f}{a - d:>12.2f}")
        # TODO(go-live): write actual Alpaca fills/positions/cash back into
        # portfolio_holdings + portfolio_accounts so the public leaderboard
        # reflects the real account instead of the paper estimate. Gated on
        # the regulatory go-live decision.
        print()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Alpaca execution spike")
    ap.add_argument("--status", action="store_true", help="account + clock")
    ap.add_argument("--positions", action="store_true", help="list Alpaca positions")
    ap.add_argument("--orders", action="store_true", help="list recent orders")
    ap.add_argument("--buy", nargs=2, metavar=("SYMBOL", "QTY"))
    ap.add_argument("--sell", nargs=2, metavar=("SYMBOL", "QTY"))
    ap.add_argument("--reconcile", metavar="SLUG", help="diff Alpaca vs portfolio")
    ap.add_argument(
        "--i-understand-live",
        action="store_true",
        help="required to place an order against the LIVE endpoint",
    )
    args = ap.parse_args(argv)

    try:
        backend = AlpacaExecutionBackend()
    except AlpacaError as exc:
        logger.error("%s", exc)
        return 1

    client = backend.client
    logger.info(
        "Alpaca endpoint: %s (%s)",
        client.base_url,
        "PAPER / sandbox" if client.is_paper else "LIVE — real money",
    )

    try:
        if args.status:
            acct = client.get_account()
            clock = client.get_clock()
            print(f"\n  account_number  {acct.get('account_number')}")
            print(f"  status          {acct.get('status')}")
            print(f"  cash            ${float(acct.get('cash') or 0):,.2f}")
            print(f"  equity          ${float(acct.get('equity') or 0):,.2f}")
            print(f"  buying_power    ${float(acct.get('buying_power') or 0):,.2f}")
            print(f"  market_open     {clock.get('is_open')}")
            print()

        if args.positions:
            positions = client.list_positions()
            if not positions:
                print("\n  no open positions\n")
            else:
                print(f"\n  {'symbol':<10}{'qty':>10}{'avg_entry':>12}"
                      f"{'mkt_value':>14}{'unrl_pl':>12}")
                for p in positions:
                    print(f"  {p['symbol']:<10}{float(p['qty']):>10.2f}"
                          f"{float(p['avg_entry_price']):>12.2f}"
                          f"{float(p['market_value']):>14.2f}"
                          f"{float(p['unrealized_pl']):>12.2f}")
                print()

        if args.orders:
            for o in client.list_orders(limit=20):
                print(f"  {o['submitted_at']}  {o['side']:<4} "
                      f"{o['symbol']:<8} qty={o.get('qty')}  {o['status']}")

        if args.buy:
            symbol, qty = args.buy
            backend.buy(symbol.upper(), float(qty),
                        allow_live=args.i_understand_live)

        if args.sell:
            symbol, qty = args.sell
            backend.sell(symbol.upper(), float(qty),
                         allow_live=args.i_understand_live)

        if args.reconcile:
            backend.reconcile(SupabaseDB(), args.reconcile)

    except AlpacaError as exc:
        logger.error("%s", exc)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
