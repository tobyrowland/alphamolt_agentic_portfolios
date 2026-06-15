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
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone

from alpaca_client import AlpacaClient, AlpacaError
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


@dataclass
class Fill:
    """Normalised result of submitting an order."""

    order_id: str
    symbol: str
    side: str
    qty: float
    status: str


# Terminal Alpaca order states that mean "this order is done moving".
_TERMINAL_STATES = {"filled", "canceled", "expired", "rejected", "done_for_day"}


@dataclass
class ExecResult:
    """Outcome of submit-and-await-fill.

    ``status`` is one of: ``filled`` (fully), ``partial`` (some qty filled),
    ``unfilled`` (accepted/queued but nothing filled in the window — e.g.
    market closed), ``rejected``. ``filled_qty`` / ``avg_price`` are the real
    numbers to record in the DB; both are 0 when nothing filled.
    """

    status: str
    filled_qty: float
    avg_price: float
    order_id: str | None
    raw_status: str = ""


class AlpacaExecutionBackend:
    """Routes buy/sell decisions to an Alpaca account.

    Mirrors ``PortfolioManager``'s buy/sell shape so it can later be dropped
    in behind the same interface for a ``live``-flagged portfolio.
    """

    def __init__(self, client: AlpacaClient | None = None):
        self.client = client or AlpacaClient()
        # Price-protection band: a buy won't fill more than this fraction above
        # the intended price, a sell more than this below (marketable limit
        # order). Caps slippage in illiquid / volatile / at-the-open conditions
        # — if the market gaps past the band the order simply doesn't fill and
        # the next mirror run re-converges. 0 disables (raw market orders).
        try:
            self.price_band = float(os.environ.get("ALPACA_PRICE_BAND_PCT", "0.03"))
        except ValueError:
            self.price_band = 0.03

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
        direction (buy: cap above; sell: floor below)."""
        if side == "buy":
            px = ref_price * (1 + self.price_band)
        else:
            px = ref_price * (1 - self.price_band)
        # Alpaca accepts 2 dp for >= $1, finer below; keep it simple and valid.
        return round(px, 2) if px >= 1 else round(px, 4)

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
        print()

    # ------------------------------------------------------------------
    # Write-back: mirror real Alpaca state into the normal portfolio tables
    # ------------------------------------------------------------------

    def sync_to_db(
        self,
        db: SupabaseDB,
        portfolio_slug: str,
        *,
        dry_run: bool = False,
        reset_baseline: bool = False,
    ) -> None:
        """Mirror the live Alpaca account into the normal portfolio tables.

        Idempotent *state* mirror: it overwrites ``portfolio_holdings`` +
        ``portfolio_accounts.cash_usd`` to match Alpaca's current positions and
        cash, so the website, MTM snapshot and leaderboard reflect the real
        account. Safe to rerun — it converges, it doesn't accumulate.

        With ``reset_baseline`` (the "go-live" reseed), it also sets
        ``starting_cash`` to Alpaca's current account **equity** and
        ``inception_date`` to today — so the portfolio's P/L baseline is the
        real capital you funded, not the $1M paper default. Run this once when
        a portfolio first goes live; the buying-power and leaderboard-baseline
        mismatches both come from a stale $1M baseline.

        Refuses unless the portfolio is ``mode='live'`` (migration 036): this
        is destructive to the DB book (Alpaca is the source of truth for a live
        portfolio), and must never clobber a paper portfolio's simulated book.

        The Alpaca endpoint is independent of this flag — for the spike you run
        ``mode='live'`` against the Alpaca *paper* sandbox, which mirrors a real
        broker account shape with zero real money.

        Not handled here (state-only mirror): the per-trade journal
        (``agent_trades``) and MTM snapshot (``agent_portfolio_history``). The
        snapshot is produced on the next ``portfolio_valuation.py`` run from the
        mirrored holdings; journaling individual fills (Alpaca activities, deduped
        by order id) is a follow-up — see TODO below.
        """
        portfolio = db.get_portfolio_by_slug(portfolio_slug)
        if not portfolio:
            raise AlpacaError(f"portfolio not found: {portfolio_slug!r}")
        mode = portfolio.get("mode")
        if mode != "live":
            raise AlpacaError(
                f"refusing to sync: portfolio {portfolio_slug!r} is "
                f"mode={mode!r}, not 'live'. Set portfolios.mode='live' first "
                "— sync mirrors real Alpaca state into the normal tables and "
                "must never overwrite a paper book."
            )
        pid = portfolio["id"]

        account = self.client.get_account()
        alpaca_cash = float(account.get("cash") or 0)
        alpaca_equity = float(account.get("equity") or 0)
        alpaca_pos = {
            p["symbol"]: (float(p["qty"]), float(p["avg_entry_price"]))
            for p in self.client.list_positions()
        }

        db_holdings = {h["ticker"]: h for h in db.get_portfolio_holdings(pid)}
        now = datetime.now(timezone.utc).isoformat()

        tag = "DRY-RUN " if dry_run else ""
        head = "go-live reseed" if reset_baseline else "sync"
        print(f"\n{tag}{head}  portfolio={portfolio_slug}  mode=live  "
              f"alpaca={'PAPER' if self.client.is_paper else 'LIVE'}\n")

        # Upsert every Alpaca position. Validate the symbol against `securities`
        # (Level 0 Tier 0) — that's the real FK target of
        # portfolio_holdings.ticker, so a Level-0-only name (e.g. a foreign ADR
        # like TSM that the legacy `companies` TradingView screen excludes) is a
        # perfectly valid holding and must be written, not dropped. The paper
        # book already holds such names; the live mirror must too, or a real
        # fill silently never reaches the DB/website. Skip only symbols absent
        # from `securities` entirely (the FK would otherwise reject the write).
        for symbol, (qty, avg) in sorted(alpaca_pos.items()):
            if not db.get_security(symbol):
                logger.warning(
                    "skip %s: not in securities universe (FK target missing)",
                    symbol,
                )
                continue
            existing = db_holdings.get(symbol)
            first_bought = (
                existing.get("first_bought_at") if existing else now
            ) or now
            row = {
                "portfolio_id": pid,
                "ticker": symbol,
                "quantity": qty,
                "avg_cost_usd": avg,
                "first_bought_at": first_bought,
                "updated_at": now,
            }
            print(f"  upsert  {symbol:<8} qty={qty:<10.4f} avg=${avg:,.2f}")
            if not dry_run:
                db.upsert_portfolio_holding(row)

        # Delete DB holdings Alpaca no longer reports (fully exited positions).
        for ticker in sorted(db_holdings):
            if ticker not in alpaca_pos:
                print(f"  delete  {ticker:<8} (no longer held on Alpaca)")
                if not dry_run:
                    db.delete_portfolio_holding(pid, ticker)

        account_update: dict = {"cash_usd": alpaca_cash}
        if reset_baseline:
            account_update["starting_cash"] = alpaca_equity
            account_update["inception_date"] = date.today().isoformat()
            print(f"  baseline starting_cash=${alpaca_equity:,.2f}  "
                  f"inception={account_update['inception_date']}")
        print(f"  cash    ${alpaca_cash:,.2f}")
        if not dry_run:
            db.upsert_portfolio_account(pid, account_update)

        # TODO(trade journal): mirror individual fills into agent_trades by
        # reading Alpaca activities (FILL events) and deduping on order id, so
        # the public trade tape reflects real trades. State mirror above is
        # enough for holdings / MTM / leaderboard.
        print(f"\n{tag}done.\n")


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
