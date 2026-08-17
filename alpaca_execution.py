#!/usr/bin/env python3
"""
Alpaca execution backend — the Alpaca implementation of ``broker.BrokerBackend``.

Today every strategy funnels its decisions through
``PortfolioManager.buy/sell`` -> the ``execute_portfolio_buy/_sell`` Supabase
RPCs, which move *paper* cash and holdings. This module adds a parallel
execution target: an Alpaca account. The intent is that a single portfolio
flagged ``live`` mirrors the same buy/sell decisions into Alpaca orders, then
reconciles real fills/positions/cash back.

The broker-neutral half of that job lives elsewhere: the protocol + shared
policy (kill-switch, slippage band) in ``broker.py``, and reconcile / state
write-back in ``broker_sync.py`` — this module keeps only what is genuinely
Alpaca-specific (REST transport, order submission, status mapping) and
delegates the rest, so a second broker inherits it rather than forking it.

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
import json
import logging
import os
import sys
import time

import broker_sync
from alpaca_client import AlpacaClient, AlpacaError
from broker import (
    ExecResult,
    Fill,
    Position,
    band_limit_price,
    price_band_from_env,
)
from db import SupabaseDB

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)


def _alpaca_accounts_map() -> dict[str, dict]:
    """Per-portfolio Alpaca credentials from the ``ALPACA_ACCOUNTS`` secret.

    A JSON object keyed by **live portfolio slug**::

        {"toby-live":     {"key_id": "...", "secret_key": "...",
                           "base_url": "https://api.alpaca.markets"},
         "chuckyegg-live": {"key_id": "...", "secret_key": "...",
                           "base_url": "https://api.alpaca.markets"}}

    Lets several owners each run a live follower against their **own** Alpaca
    account. Unset/empty -> ``{}`` (single-account mode via the bare
    ``ALPACA_*`` env vars). Raises ``AlpacaError`` on malformed JSON rather than
    silently degrading to the shared account.
    """
    raw = os.environ.get("ALPACA_ACCOUNTS", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AlpacaError(f"ALPACA_ACCOUNTS is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise AlpacaError("ALPACA_ACCOUNTS must be a JSON object keyed by slug")
    return data


# Terminal Alpaca order states that mean "this order is done moving".
_TERMINAL_STATES = {"filled", "canceled", "expired", "rejected", "done_for_day"}

# ``Fill`` / ``ExecResult`` / ``Position`` are the broker-neutral value types
# (``broker.py``); imported above and re-exported here so existing
# ``from alpaca_execution import ExecResult`` callers keep working.
__all__ = [
    "AlpacaError",
    "AlpacaExecutionBackend",
    "ExecResult",
    "Fill",
    "Position",
]


class AlpacaExecutionBackend:
    """Routes buy/sell decisions to an Alpaca account.

    Implements ``broker.BrokerBackend`` and mirrors ``PortfolioManager``'s
    buy/sell shape, so it drops in behind the same interface for a
    ``live``-flagged portfolio.
    """

    broker_name = "alpaca"

    def __init__(self, client: AlpacaClient | None = None):
        self.client = client or AlpacaClient()
        # Price-protection band: a buy won't fill more than this fraction above
        # the intended price, a sell more than this below (marketable limit
        # order). Caps slippage in illiquid / volatile / at-the-open conditions
        # — if the market gaps past the band the order simply doesn't fill and
        # the next mirror run re-converges. 0 disables (raw market orders).
        self.price_band = price_band_from_env()

    @classmethod
    def for_slug(
        cls,
        slug: str,
        *,
        allow_shared_fallback: bool = False,
    ) -> "AlpacaExecutionBackend":
        """Build a backend bound to a live portfolio's OWN Alpaca account.

        Resolution + anti-commingle rule:

        - ``ALPACA_ACCOUNTS`` set -> **authoritative**. ``slug`` present uses its
          credentials; ``slug`` absent raises ``AlpacaError`` (never silently
          trade one owner's targets through another's account).
        - ``ALPACA_ACCOUNTS`` unset -> legacy single-account mode (bare
          ``ALPACA_*`` env), but only when ``allow_shared_fallback`` is True.
          Callers iterating more than one live portfolio pass False, so a second
          live portfolio can never land in the shared account by accident.
        """
        accounts = _alpaca_accounts_map()
        if accounts:
            entry = accounts.get(slug)
            if not entry:
                raise AlpacaError(
                    f"no ALPACA_ACCOUNTS entry for live portfolio {slug!r} — "
                    f"refusing to trade it against another account"
                )
            client = AlpacaClient(
                key_id=entry.get("key_id"),
                secret_key=entry.get("secret_key"),
                base_url=entry.get("base_url"),
            )
            return cls(client)
        if not allow_shared_fallback:
            raise AlpacaError(
                f"ALPACA_ACCOUNTS not set and {slug!r} can't use the shared "
                f"account here (multiple live portfolios) — configure "
                f"ALPACA_ACCOUNTS with a per-portfolio entry"
            )
        return cls()  # single-account legacy mode (bare ALPACA_* env)

    # ------------------------------------------------------------------
    # BrokerBackend protocol — normalised account state
    # ------------------------------------------------------------------

    @property
    def is_sandbox(self) -> bool:
        """True when pointed at Alpaca's paper sandbox (no real money)."""
        return self.client.is_paper

    def get_equity(self) -> float:
        return float(self.client.get_account().get("equity") or 0)

    def get_cash(self) -> float:
        return float(self.client.get_account().get("cash") or 0)

    def get_positions(self) -> dict[str, Position]:
        return {
            p["symbol"]: Position(
                symbol=p["symbol"],
                qty=float(p["qty"]),
                avg_price=float(p["avg_entry_price"]),
            )
            for p in self.client.list_positions()
        }

    def market_is_open(self) -> bool:
        return bool(self.client.get_clock().get("is_open"))

    def latest_price(self, symbol: str) -> float | None:
        """Best-effort live price. Never raises (see AlpacaClient)."""
        return self.client.get_latest_trade_price(symbol)

    # ------------------------------------------------------------------
    # Order placement
    # ------------------------------------------------------------------

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

    def _band_limit_price(self, side: str, ref_price: float) -> float:
        """Limit price one band away from the intended price, in the safe
        direction (buy: cap above; sell: floor below).

        Thin wrapper over the shared ``broker.band_limit_price`` — the rounding
        Alpaca accepts (2dp at/above $1, finer below) is what every broker
        wants, so the rule lives once.
        """
        return band_limit_price(side, ref_price, self.price_band)

    def execute_and_wait(
        self,
        symbol: str,
        side: str,
        qty: float,
        *,
        allow_live: bool = False,
        ref_price: float | None = None,
        timeout: float = 30.0,
        poll: float = 2.0,
    ) -> ExecResult:
        """Submit an order and poll until it reaches a terminal state.

        With ``ref_price`` and a non-zero ``price_band`` it submits a
        **marketable limit** order capped one band from the intended price (a
        buy won't pay more than band% above, a sell won't accept more than
        band% below). Otherwise a plain market order. Returns the *actual*
        filled quantity and average fill price. If it doesn't fill within
        ``timeout`` — market closed and the order queued, or the price gapped
        past the band — returns ``status='unfilled'`` with 0 filled; the next
        mirror run re-converges and `sync_to_db` reconciles any queued fill.
        """
        self._guard_live(allow_live)
        if ref_price and self.price_band > 0:
            # Centre the band on the LIVE market price when we can get one, so a
            # stale DB ref (e.g. a Level-0 daily close for a name the intraday
            # job doesn't cover) can't push a marketable limit out of reach and
            # leave it unfilled. Falls back to the passed ref_price when the
            # data API has nothing (off-hours, no entitlement, unknown symbol).
            live = self.client.get_latest_trade_price(symbol)
            band_ref = live if (live and live > 0) else ref_price
            limit_price = self._band_limit_price(side, band_ref)
            order = self.client.submit_order(
                symbol, side, qty=qty,
                order_type="limit", limit_price=limit_price,
            )
            logger.info(
                "%s %s x%s  limit=$%.4f (band_ref=$%.4f [live=%s intended=$%.4f], band=%.1f%%)",
                side.upper(), symbol, qty, limit_price, band_ref,
                f"${live:.4f}" if live else "n/a", ref_price,
                self.price_band * 100,
            )
        else:
            order = self.client.submit_order(symbol, side, qty=qty)
        oid = order["id"]

        deadline = time.monotonic() + timeout
        o = order
        while True:
            raw = o.get("status", "")
            if raw in _TERMINAL_STATES or time.monotonic() >= deadline:
                break
            time.sleep(poll)
            o = self.client.get_order(oid)

        filled = float(o.get("filled_qty") or 0)
        avg = float(o.get("filled_avg_price") or 0)
        raw = o.get("status", "")
        if filled >= qty - 1e-9 and filled > 0:
            status = "filled"
        elif filled > 0:
            status = "partial"
        elif raw == "rejected":
            status = "rejected"
        else:
            status = "unfilled"
        logger.info(
            "%s %s x%s -> %s (filled=%s @ $%.4f, alpaca=%s, order=%s)",
            side.upper(), symbol, qty, status, filled, avg, raw, oid,
        )
        return ExecResult(status, filled, avg, oid, raw_status=raw)

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
    # Reconciliation + state write-back (broker-neutral — see broker_sync)
    # ------------------------------------------------------------------

    def reconcile(self, db: SupabaseDB, portfolio_slug: str) -> None:
        """Read-only diff between this Alpaca account and an AlphaMolt portfolio.

        Delegates to ``broker_sync.reconcile`` — the comparison is pure policy
        over the protocol, so it is shared across brokers.
        """
        broker_sync.reconcile(self, db, portfolio_slug)

    def sync_to_db(
        self,
        db: SupabaseDB,
        portfolio_slug: str,
        *,
        dry_run: bool = False,
        reset_baseline: bool = False,
    ) -> None:
        """Mirror this Alpaca account's state into the normal portfolio tables.

        Delegates to ``broker_sync.sync_to_db`` (idempotent state mirror;
        refuses any portfolio that isn't ``mode='live'``). Kept as a method so
        existing callers — the CLI, ``alpaca_mirror``, the heartbeat — are
        unchanged.
        """
        broker_sync.sync_to_db(
            self, db, portfolio_slug,
            dry_run=dry_run, reset_baseline=reset_baseline,
        )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Alpaca execution spike")
    ap.add_argument("--status", action="store_true", help="account + clock")
    ap.add_argument("--positions", action="store_true", help="list Alpaca positions")
    ap.add_argument("--orders", action="store_true", help="list recent orders")
    ap.add_argument("--buy", nargs=2, metavar=("SYMBOL", "QTY"))
    ap.add_argument("--sell", nargs=2, metavar=("SYMBOL", "QTY"))
    ap.add_argument("--reconcile", metavar="SLUG", help="diff Alpaca vs portfolio (read-only)")
    ap.add_argument(
        "--sync",
        metavar="SLUG",
        help="mirror Alpaca state into a mode='live' portfolio's normal tables",
    )
    ap.add_argument(
        "--go-live",
        metavar="SLUG",
        help="one-time reseed: mirror Alpaca state AND set starting_cash + "
             "inception_date from the real account (fixes the $1M baseline)",
    )
    ap.add_argument(
        "--sync-all-live",
        action="store_true",
        help="reconcile every mode='live' portfolio via sync (drift reconciler)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="with --sync: plan the writes without executing them",
    )
    ap.add_argument(
        "--i-understand-live",
        action="store_true",
        help="required to place an order against the LIVE endpoint",
    )
    args = ap.parse_args(argv)

    # Account-level commands operate the single account from the bare ALPACA_*
    # env. Portfolio commands (sync / go-live / sync-all-live) resolve each live
    # portfolio's OWN account via for_slug, so the shared backend is only built
    # when actually needed (and won't fail a multi-account-only setup).
    needs_shared = any([
        args.status, args.positions, args.orders, args.buy, args.sell,
        args.reconcile,
    ])
    backend = None
    client = None
    if needs_shared:
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

        if args.sync:
            be = AlpacaExecutionBackend.for_slug(args.sync, allow_shared_fallback=True)
            be.sync_to_db(SupabaseDB(), args.sync, dry_run=args.dry_run)

        if args.go_live:
            be = AlpacaExecutionBackend.for_slug(args.go_live, allow_shared_fallback=True)
            be.sync_to_db(
                SupabaseDB(), args.go_live,
                dry_run=args.dry_run, reset_baseline=True,
            )

        if args.sync_all_live:
            db = SupabaseDB()
            live = [
                p for p in db.get_human_portfolios()
                if (p.get("mode") or "paper") == "live"
            ]
            if not live:
                logger.info("no live portfolios to reconcile")
            single = len(live) == 1
            for p in live:
                try:
                    be = AlpacaExecutionBackend.for_slug(
                        p["slug"], allow_shared_fallback=single,
                    )
                    be.sync_to_db(db, p["slug"], dry_run=args.dry_run)
                except AlpacaError as exc:
                    logger.error("sync %s failed: %s", p["slug"], exc)

    except AlpacaError as exc:
        logger.error("%s", exc)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
