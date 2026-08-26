#!/usr/bin/env python3
"""Unit tests for the broker-neutral execution seam.

Covers the three pieces the live path now shares across brokers:

1. ``broker`` — shared policy (kill-switch, slippage band) + backend resolution.
2. ``alpaca_execution.AlpacaExecutionBackend`` — that the Alpaca backend really
   satisfies ``BrokerBackend`` and maps Alpaca's payloads onto the normalised
   types.
3. ``broker_sync`` / ``alpaca_mirror`` — that the generic reconcile / state
   sync / mirror loop drive a backend purely through the protocol (a fake
   backend with no Alpaca anywhere is enough to run them).

No network, no DB, no broker SDK.

Run directly:

    pytest tests/test_broker.py
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

import broker
import broker_sync
from alpaca_execution import AlpacaExecutionBackend
from broker import (
    BrokerBackend,
    BrokerError,
    ExecResult,
    Position,
    band_limit_price,
    broker_for_portfolio,
    live_execution_enabled,
    price_band_from_env,
    resolve_backend,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeAlpacaClient:
    """Just the AlpacaClient surface the backend touches."""

    def __init__(self, *, account=None, positions=None, clock=None, price=None):
        # `is not None`, not `or` — an explicitly empty payload ({} / []) is a
        # case under test (a broker omitting fields), not "use the default".
        self.account = (
            account if account is not None
            else {"equity": "1000.50", "cash": "250.25"}
        )
        self.positions = positions if positions is not None else []
        self.clock = clock if clock is not None else {"is_open": True}
        self.price = price
        self.is_paper = True

    def get_account(self):
        return self.account

    def list_positions(self):
        return self.positions

    def get_clock(self):
        return self.clock

    def get_latest_trade_price(self, symbol):
        return self.price


class _FakeBackend:
    """A broker backend with no broker behind it — protocol only."""

    broker_name = "fake"

    def __init__(self, *, equity=10_000.0, cash=1_000.0, positions=None,
                 market_open=True, sandbox=True):
        self._equity = equity
        self._cash = cash
        self._positions = positions or {}
        self._market_open = market_open
        self._sandbox = sandbox
        self.orders: list[tuple[str, str, float]] = []

    @property
    def is_sandbox(self):
        return self._sandbox

    def get_equity(self):
        return self._equity

    def get_cash(self):
        return self._cash

    def get_positions(self):
        return dict(self._positions)

    def market_is_open(self):
        return self._market_open

    def latest_price(self, symbol):
        return None

    def execute_and_wait(self, symbol, side, qty, *, allow_live=False,
                         ref_price=None, timeout=30.0, poll=2.0):
        self.orders.append((side, symbol, qty))
        return ExecResult("filled", qty, ref_price or 1.0, "oid-1", "filled")


class _FakeDB:
    """The handful of read/write methods broker_sync touches."""

    def __init__(self, portfolio=None, holdings=None, account=None,
                 securities=("AAA", "BBB", "CCC"), human_portfolios=None):
        self.portfolio = portfolio
        # Explicit override so a test can build a SHARED account (several live
        # portfolios on one broker key); None means "just this one".
        self.human_portfolios = human_portfolios
        self.holdings = list(holdings or [])
        self.account = account or {"cash_usd": 500.0}
        self.securities = set(securities)
        self.upserted_holdings: list[dict] = []
        self.deleted: list[tuple[str, str]] = []
        self.account_updates: list[tuple[str, dict]] = []

    def get_portfolio_by_slug(self, slug):
        return self.portfolio

    def get_human_portfolios(self):
        # Sleeve grouping (migration 083) reads this to decide whether a broker
        # account is shared. One portfolio here => sole occupant => sync allowed.
        if self.human_portfolios is not None:
            return list(self.human_portfolios)
        return [self.portfolio] if self.portfolio else []

    def get_agent_by_handle(self, handle):
        return {"id": f"agent-{handle}"}

    def get_portfolio_holdings(self, pid):
        return list(self.holdings)

    def get_portfolio_account(self, pid):
        return dict(self.account)

    def get_security(self, ticker):
        return {"ticker": ticker} if ticker in self.securities else None

    def upsert_portfolio_holding(self, row):
        self.upserted_holdings.append(row)

    def delete_portfolio_holding(self, pid, ticker):
        self.deleted.append((pid, ticker))

    def upsert_portfolio_account(self, pid, update):
        self.account_updates.append((pid, update))


def _live_portfolio(slug="x-live", pid="pid-1", **extra):
    return {"id": pid, "slug": slug, "mode": "live", **extra}


# ---------------------------------------------------------------------------
# Shared policy
# ---------------------------------------------------------------------------


class TestBandLimitPrice(unittest.TestCase):
    def test_buy_caps_above_and_sell_floors_below(self):
        self.assertEqual(band_limit_price("buy", 100.0, 0.03), 103.0)
        self.assertEqual(band_limit_price("sell", 100.0, 0.03), 97.0)

    def test_zero_band_is_the_reference_price(self):
        self.assertEqual(band_limit_price("buy", 42.5, 0.0), 42.5)
        self.assertEqual(band_limit_price("sell", 42.5, 0.0), 42.5)

    def test_sub_dollar_prices_keep_four_decimals(self):
        # A penny stock rounded to 2dp would move the band by whole percent.
        self.assertEqual(band_limit_price("buy", 0.50, 0.03), 0.515)
        self.assertEqual(band_limit_price("sell", 0.50, 0.03), 0.485)

    def test_dollar_boundary_rounds_to_cents(self):
        self.assertEqual(band_limit_price("buy", 1.00, 0.03), 1.03)


class TestLiveExecutionEnabled(unittest.TestCase):
    def test_off_when_neither_env_is_set(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(live_execution_enabled())

    def test_neutral_name_enables(self):
        for val in ("1", "true", "TRUE", "yes", "on"):
            with mock.patch.dict(
                os.environ, {"LIVE_EXECUTION_ENABLED": val}, clear=True
            ):
                self.assertTrue(live_execution_enabled(), val)

    def test_legacy_alpaca_name_still_enables(self):
        # Existing deployments set only the Alpaca-era name; it must keep working.
        with mock.patch.dict(
            os.environ, {"ALPACA_LIVE_EXECUTION_ENABLED": "true"}, clear=True
        ):
            self.assertTrue(live_execution_enabled())

    def test_other_values_are_off(self):
        for val in ("", "0", "false", "no", "maybe"):
            with mock.patch.dict(
                os.environ, {"LIVE_EXECUTION_ENABLED": val}, clear=True
            ):
                self.assertFalse(live_execution_enabled(), val)


class TestPriceBandFromEnv(unittest.TestCase):
    def test_default_when_unset(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(price_band_from_env(), 0.03)

    def test_neutral_name_wins_over_legacy(self):
        with mock.patch.dict(
            os.environ,
            {"LIVE_PRICE_BAND_PCT": "0.05", "ALPACA_PRICE_BAND_PCT": "0.01"},
            clear=True,
        ):
            self.assertEqual(price_band_from_env(), 0.05)

    def test_legacy_name_honoured(self):
        with mock.patch.dict(
            os.environ, {"ALPACA_PRICE_BAND_PCT": "0.02"}, clear=True
        ):
            self.assertEqual(price_band_from_env(), 0.02)

    def test_malformed_falls_back_to_default(self):
        with mock.patch.dict(
            os.environ, {"LIVE_PRICE_BAND_PCT": "wide"}, clear=True
        ):
            self.assertEqual(price_band_from_env(), 0.03)

    def test_zero_is_respected_not_treated_as_missing(self):
        # 0 disables the band (raw market orders) — it must not read as unset.
        with mock.patch.dict(
            os.environ, {"LIVE_PRICE_BAND_PCT": "0"}, clear=True
        ):
            self.assertEqual(price_band_from_env(), 0.0)


# ---------------------------------------------------------------------------
# Backend resolution
# ---------------------------------------------------------------------------


class TestBackendResolution(unittest.TestCase):
    def test_default_broker_is_alpaca(self):
        self.assertEqual(broker_for_portfolio({}), "alpaca")
        self.assertEqual(broker_for_portfolio({"broker": None}), "alpaca")

    def test_explicit_broker_is_normalised(self):
        self.assertEqual(broker_for_portfolio({"broker": " Alpaca "}), "alpaca")

    def test_unknown_broker_raises_broker_error(self):
        with self.assertRaises(BrokerError) as ctx:
            resolve_backend("x-live", "e-trade")
        self.assertIn("unknown broker", str(ctx.exception))

    def test_known_broker_dispatches_to_its_factory(self):
        sentinel = object()
        with mock.patch.object(
            AlpacaExecutionBackend, "for_slug", return_value=sentinel
        ) as for_slug:
            got = resolve_backend("x-live", "alpaca", allow_shared_fallback=True)
        self.assertIs(got, sentinel)
        for_slug.assert_called_once_with("x-live", allow_shared_fallback=True)

    def test_resolve_for_portfolio_passes_slug_and_broker(self):
        sentinel = object()
        with mock.patch.object(
            broker, "resolve_backend", return_value=sentinel
        ) as resolve:
            got = broker.resolve_backend_for_portfolio(
                _live_portfolio(slug="toby-live"), allow_shared_fallback=False
            )
        self.assertIs(got, sentinel)
        resolve.assert_called_once_with(
            "toby-live", "alpaca", allow_shared_fallback=False
        )

    def test_resolve_for_portfolio_falls_back_to_id_when_slugless(self):
        with mock.patch.object(broker, "resolve_backend") as resolve:
            broker.resolve_backend_for_portfolio({"id": "abcdefgh-1234"})
        self.assertEqual(resolve.call_args[0][0], "abcdefgh")


# ---------------------------------------------------------------------------
# The Alpaca backend as a protocol implementation
# ---------------------------------------------------------------------------


class TestAlpacaBackendProtocol(unittest.TestCase):
    def _backend(self, **kw):
        with mock.patch.dict(os.environ, {}, clear=True):
            return AlpacaExecutionBackend(_FakeAlpacaClient(**kw))

    def test_satisfies_broker_backend(self):
        self.assertIsInstance(self._backend(), BrokerBackend)

    def test_broker_name(self):
        self.assertEqual(self._backend().broker_name, "alpaca")

    def test_equity_and_cash_are_floats(self):
        be = self._backend()
        self.assertEqual(be.get_equity(), 1000.50)
        self.assertEqual(be.get_cash(), 250.25)

    def test_missing_account_fields_read_as_zero(self):
        be = self._backend(account={})
        self.assertEqual(be.get_equity(), 0.0)
        self.assertEqual(be.get_cash(), 0.0)

    def test_positions_map_to_normalised_position_objects(self):
        be = self._backend(positions=[
            {"symbol": "AAA", "qty": "3.5", "avg_entry_price": "10.25"},
        ])
        pos = be.get_positions()
        self.assertEqual(list(pos), ["AAA"])
        self.assertEqual(pos["AAA"], Position("AAA", 3.5, 10.25))

    def test_market_is_open_reads_the_clock(self):
        self.assertTrue(self._backend(clock={"is_open": True}).market_is_open())
        self.assertFalse(self._backend(clock={"is_open": False}).market_is_open())
        self.assertFalse(self._backend(clock={}).market_is_open())

    def test_is_sandbox_tracks_the_paper_endpoint(self):
        be = self._backend()
        self.assertTrue(be.is_sandbox)
        be.client.is_paper = False
        self.assertFalse(be.is_sandbox)

    def test_price_band_comes_from_env(self):
        with mock.patch.dict(
            os.environ, {"LIVE_PRICE_BAND_PCT": "0.07"}, clear=True
        ):
            be = AlpacaExecutionBackend(_FakeAlpacaClient())
        self.assertEqual(be.price_band, 0.07)
        self.assertEqual(be._band_limit_price("buy", 100.0), 107.0)


# ---------------------------------------------------------------------------
# Generic reconcile / state sync driven through the protocol
# ---------------------------------------------------------------------------


class TestSyncToDb(unittest.TestCase):
    def test_refuses_a_paper_portfolio(self):
        db = _FakeDB(portfolio={"id": "p", "slug": "s", "mode": "paper"})
        with self.assertRaises(BrokerError) as ctx:
            broker_sync.sync_to_db(_FakeBackend(), db, "s")
        self.assertIn("not 'live'", str(ctx.exception))
        self.assertEqual(db.upserted_holdings, [])
        self.assertEqual(db.account_updates, [])

    def test_refuses_a_missing_portfolio(self):
        with self.assertRaises(BrokerError):
            broker_sync.sync_to_db(_FakeBackend(), _FakeDB(portfolio=None), "s")

    def test_upserts_broker_positions_and_cash(self):
        db = _FakeDB(portfolio=_live_portfolio())
        be = _FakeBackend(cash=777.0, positions={
            "AAA": Position("AAA", 2.0, 50.0),
        })
        broker_sync.sync_to_db(be, db, "x-live")
        self.assertEqual(len(db.upserted_holdings), 1)
        row = db.upserted_holdings[0]
        self.assertEqual(row["ticker"], "AAA")
        self.assertEqual(row["quantity"], 2.0)
        self.assertEqual(row["avg_cost_usd"], 50.0)
        self.assertEqual(db.account_updates, [("pid-1", {"cash_usd": 777.0})])

    def test_deletes_holdings_the_broker_no_longer_reports(self):
        db = _FakeDB(
            portfolio=_live_portfolio(),
            holdings=[{"ticker": "BBB", "quantity": 1.0}],
        )
        broker_sync.sync_to_db(
            _FakeBackend(positions={"AAA": Position("AAA", 1.0, 1.0)}), db,
            "x-live",
        )
        self.assertEqual(db.deleted, [("pid-1", "BBB")])

    def test_skips_symbols_missing_from_the_securities_universe(self):
        # The FK target — an unknown symbol must be skipped, not crash the sync.
        db = _FakeDB(portfolio=_live_portfolio(), securities=("AAA",))
        be = _FakeBackend(positions={
            "AAA": Position("AAA", 1.0, 1.0),
            "ZZZ": Position("ZZZ", 1.0, 1.0),
        })
        broker_sync.sync_to_db(be, db, "x-live")
        self.assertEqual(
            [r["ticker"] for r in db.upserted_holdings], ["AAA"]
        )

    def test_preserves_first_bought_at_on_an_existing_holding(self):
        db = _FakeDB(
            portfolio=_live_portfolio(),
            holdings=[{"ticker": "AAA", "quantity": 1.0,
                       "first_bought_at": "2026-01-01T00:00:00+00:00"}],
        )
        broker_sync.sync_to_db(
            _FakeBackend(positions={"AAA": Position("AAA", 5.0, 2.0)}), db,
            "x-live",
        )
        self.assertEqual(
            db.upserted_holdings[0]["first_bought_at"],
            "2026-01-01T00:00:00+00:00",
        )

    def test_dry_run_writes_nothing(self):
        db = _FakeDB(
            portfolio=_live_portfolio(),
            holdings=[{"ticker": "BBB", "quantity": 1.0}],
        )
        be = _FakeBackend(positions={"AAA": Position("AAA", 1.0, 1.0)})
        broker_sync.sync_to_db(be, db, "x-live", dry_run=True)
        self.assertEqual(db.upserted_holdings, [])
        self.assertEqual(db.deleted, [])
        self.assertEqual(db.account_updates, [])

    def test_reset_baseline_sets_starting_cash_to_equity(self):
        db = _FakeDB(portfolio=_live_portfolio())
        be = _FakeBackend(equity=4321.0, cash=100.0)
        broker_sync.sync_to_db(be, db, "x-live", reset_baseline=True)
        _, update = db.account_updates[0]
        self.assertEqual(update["starting_cash"], 4321.0)
        self.assertEqual(update["cash_usd"], 100.0)
        self.assertIn("inception_date", update)


class TestReconcile(unittest.TestCase):
    def test_is_read_only(self):
        db = _FakeDB(
            portfolio=_live_portfolio(),
            holdings=[{"ticker": "AAA", "quantity": 1.0}],
        )
        broker_sync.reconcile(
            _FakeBackend(positions={"BBB": Position("BBB", 2.0, 3.0)}), db,
            "x-live",
        )
        self.assertEqual(db.upserted_holdings, [])
        self.assertEqual(db.deleted, [])
        self.assertEqual(db.account_updates, [])

    def test_reconcile_accepts_a_paper_portfolio(self):
        # Unlike sync, the read-only diff is safe on any portfolio.
        db = _FakeDB(portfolio={"id": "p", "slug": "s", "mode": "paper"})
        broker_sync.reconcile(_FakeBackend(), db, "s")  # must not raise

    def test_missing_portfolio_raises(self):
        with self.assertRaises(BrokerError):
            broker_sync.reconcile(_FakeBackend(), _FakeDB(portfolio=None), "s")


# ---------------------------------------------------------------------------
# The mirror loop is broker-neutral
# ---------------------------------------------------------------------------


class _FakePM:
    def __init__(self, book, prices):
        self.book = book
        self.prices = prices
        self.buys: list[tuple] = []
        self.sells: list[tuple] = []

    def get_portfolio_book(self, pid):
        return self.book

    def get_price(self, ticker):
        return self.prices[ticker]

    # The mirror books each fill against the portfolio that ordered it
    # (migration 083) rather than syncing the whole book from the broker.
    def buy_portfolio_atomic(self, pid, agent_id, ticker, qty, note="", **kw):
        self.buys.append((pid, ticker, qty, kw.get("price_override")))
        return {"status": "ok"}

    def sell_portfolio_atomic(self, pid, agent_id, ticker, qty, note="", **kw):
        self.sells.append((pid, ticker, qty, kw.get("price_override")))
        return {"status": "ok"}


class TestMirrorIsBrokerNeutral(unittest.TestCase):
    """The mirror drives the backend purely through the protocol.

    A fake backend with no Alpaca client anywhere is enough to run it — which is
    the property that lets a second broker reuse the loop unchanged.
    """

    def setUp(self):
        from alpaca_mirror import mirror_paper_to_broker
        self.mirror = mirror_paper_to_broker
        self.book = {
            "total_value_usd": 1000.0,
            # The sleeve's allowance. Orders are now checked against it before
            # they are placed, so a book without one can fund nothing — see
            # TestMirrorRespectsTheAllowance.
            "cash_usd": 1100.0,
            "holdings": [{"ticker": "AAA", "market_value_usd": 1000.0}],
        }
        self.pm = _FakePM(self.book, {"AAA": 10.0})

    def test_skips_when_the_market_is_closed(self):
        be = _FakeBackend(market_open=False)
        out = self.mirror(
            _FakeDB(), self.pm, be, _live_portfolio(), {"id": "paper"},
        )
        self.assertEqual(out["status"], "market_closed")
        self.assertEqual(be.orders, [])

    def test_places_orders_through_the_protocol(self):
        be = _FakeBackend(equity=1000.0, positions={})
        db = _FakeDB(portfolio=_live_portfolio())
        out = self.mirror(
            db, self.pm, be, _live_portfolio(), {"id": "paper", "slug": "p"},
        )
        self.assertEqual(out["status"], "ok")
        self.assertEqual(be.orders, [("buy", "AAA", 100.0)])
        # A placed fill triggers the state write-back.
        self.assertTrue(db.upserted_holdings or db.account_updates)

    def test_dry_run_places_nothing(self):
        be = _FakeBackend(equity=1000.0, market_open=False)
        out = self.mirror(
            _FakeDB(), self.pm, be, _live_portfolio(), {"id": "paper"},
            dry_run=True,
        )
        # dry_run bypasses the market-closed guard and still places no order.
        self.assertEqual(out["status"], "ok")
        self.assertEqual(be.orders, [])

    def test_refuses_a_non_live_portfolio(self):
        with self.assertRaises(ValueError):
            self.mirror(
                _FakeDB(), self.pm, _FakeBackend(),
                {"id": "p", "slug": "s", "mode": "paper"}, {"id": "paper"},
            )

    def test_back_compat_alias_points_at_the_same_function(self):
        import alpaca_mirror
        self.assertIs(
            alpaca_mirror.mirror_paper_to_alpaca,
            alpaca_mirror.mirror_paper_to_broker,
        )


class _RejectingPM(_FakePM):
    """A PM whose buy RPC REFUSES, the way the real one does over-allowance.

    ``buy_portfolio_atomic`` returns the rejection rather than raising it, which
    is precisely what made the 2026-08-26 failure invisible.
    """

    def __init__(self, book, prices, reject_status="insufficient_cash"):
        super().__init__(book, prices)
        self.reject_status = reject_status

    def buy_portfolio_atomic(self, pid, agent_id, ticker, qty, note="", **kw):
        self.buys.append((pid, ticker, qty, kw.get("price_override")))
        return {"status": self.reject_status}


class TestFillsThatTheDbRefuses(unittest.TestCase):
    """A fill the DB rejects must never be reported as recorded.

    The 2026-08-26 halt in full: the last buy of a 40-order rebalance filled at
    the broker, the atomic RPC refused to book it (the sleeve's allowance was
    ~$77 short after slippage), and the run still reported ``placed: 40``. Real
    shares existed that no sleeve's records owned, so the next run's alignment
    gate refused to trade and stayed refusing.
    """

    def setUp(self):
        from alpaca_mirror import mirror_paper_to_broker
        self.mirror = mirror_paper_to_broker
        self.book = {
            "total_value_usd": 1000.0,
            "cash_usd": 1100.0,
            "holdings": [{"ticker": "AAA", "market_value_usd": 1000.0}],
        }

    def test_a_rejected_buy_is_not_counted_as_placed(self):
        pm = _RejectingPM(self.book, {"AAA": 10.0})
        be = _FakeBackend(equity=1000.0, positions={})
        out = self.mirror(
            _FakeDB(portfolio=_live_portfolio()), pm, be,
            _live_portfolio(), {"id": "paper", "slug": "p"},
        )
        # The order really was sent to the broker...
        self.assertEqual(be.orders, [("buy", "AAA", 100.0)])
        # ...and the DB really did refuse it, so it is NOT a success.
        self.assertEqual(out["placed"], 0)
        self.assertEqual(out["orders"], 1)

    def test_a_rejection_does_not_move_the_tracked_allowance(self):
        """An unbooked buy has not spent the sleeve's allowance.

        Deducting it anyway would starve every later order in the same run of
        money it still has.
        """
        book = dict(self.book, cash_usd=100_000.0, total_value_usd=1000.0)
        pm = _RejectingPM(book, {"AAA": 10.0})
        be = _FakeBackend(equity=1000.0, positions={})
        self.mirror(
            _FakeDB(portfolio=_live_portfolio()), pm, be,
            _live_portfolio(), {"id": "paper", "slug": "p"},
        )
        self.assertEqual(len(pm.buys), 1)

    def test_an_accepted_buy_is_counted(self):
        pm = _FakePM(self.book, {"AAA": 10.0})
        be = _FakeBackend(equity=1000.0, positions={})
        out = self.mirror(
            _FakeDB(portfolio=_live_portfolio()), pm, be,
            _live_portfolio(), {"id": "paper", "slug": "p"},
        )
        self.assertEqual(out["placed"], 1)


class TestMirrorRespectsTheAllowance(unittest.TestCase):
    """No buy is placed for more than the sleeve can pay for.

    The broker's pooled cash is bigger than any one sleeve's allowance, so the
    broker will happily fill an order the DB then refuses. The check has to
    happen before the order goes out, and against the *limit* price — the
    marketable limit can fill anywhere up to it.
    """

    def setUp(self):
        from alpaca_mirror import mirror_paper_to_broker
        self.mirror = mirror_paper_to_broker

    def _run(self, cash):
        book = {
            "total_value_usd": 1000.0,
            "cash_usd": cash,
            "holdings": [{"ticker": "AAA", "market_value_usd": 1000.0}],
        }
        pm = _FakePM(book, {"AAA": 10.0})
        be = _FakeBackend(equity=1000.0, positions={})
        out = self.mirror(
            _FakeDB(portfolio=_live_portfolio()), pm, be,
            _live_portfolio(), {"id": "paper", "slug": "p"},
        )
        return out, be, pm

    def test_an_affordable_buy_goes_out_whole(self):
        out, be, _ = self._run(cash=100_000.0)
        self.assertEqual(be.orders, [("buy", "AAA", 100.0)])
        self.assertEqual(out.get("unaffordable"), 0)

    def test_a_short_allowance_trims_the_order(self):
        # 100 sh planned; the 3% band puts the limit at $10.30, so $600 buys
        # 58.2524 sh. The trimmed order must cost no more than the allowance.
        out, be, _ = self._run(cash=600.0)
        self.assertEqual(len(be.orders), 1)
        _, _, qty = be.orders[0]
        self.assertLess(qty, 100.0)
        self.assertLessEqual(qty * 10.30, 600.0)

    def test_an_empty_allowance_places_nothing(self):
        out, be, pm = self._run(cash=0.0)
        self.assertEqual(be.orders, [])
        self.assertEqual(pm.buys, [])
        self.assertEqual(out.get("unaffordable"), 1)


class TestDriftRefusalJournalsTheReason(unittest.TestCase):
    """A refusal caused by sharing must say the account is shared.

    The journal row is what the owner's hub reads to explain a quiet run, and
    it recorded ``shared_account: false`` for a refusal that happened precisely
    *because* the account was shared.
    """

    def test_shared_account_is_reported_on_the_refusal(self):
        import alpaca_mirror
        from broker import Position

        live_a = _live_portfolio(slug="a-live", pid="pid-a")
        live_b = _live_portfolio(slug="b-live", pid="pid-b")
        for pf in (live_a, live_b):
            pf["broker_account_key"] = "shared"

        db = _FakeDB(portfolio=live_a)
        db.human_portfolios = [live_a, live_b]
        book = {
            "total_value_usd": 100.0,
            "cash_usd": 100.0,
            "holdings": [{"ticker": "AAA", "quantity": 1.0,
                          "market_value_usd": 100.0}],
        }
        pm = _FakePM(book, {"AAA": 10.0})
        be = _FakeBackend(
            equity=1000.0, positions={"AAA": Position("AAA", 9.0, 10.0)},
        )
        out = alpaca_mirror.mirror_paper_to_broker(
            db, pm, be, live_a, {"id": "paper", "slug": "p"},
        )
        self.assertEqual(out["status"], "drift_refused")
        self.assertTrue(out["shared_account"])


if __name__ == "__main__":
    unittest.main()
