#!/usr/bin/env python3
"""Unit tests for sleeves — several live portfolios sharing one broker account.

The safety property everything else rests on: **a sleeve plans against its own
recorded holdings, never the broker's aggregate**, so two sleeves on one account
cannot see (and therefore cannot sell) each other's shares. That is
``test_sleeve_ignores_the_other_sleeves_holdings`` below, and it is the test that
would have caught the pre-083 behaviour.

Also covers the allowance arithmetic (``plan_credit``), drift detection, and the
two refusals that protect real money: the mirror refusing to trade a shared
account whose records disagree with the broker, and ``broker_sync`` refusing to
overwrite a shared account at all.

No DB, no broker, no network.

Run directly:

    pytest tests/test_sleeves.py
"""

from __future__ import annotations

import unittest

import broker_sync
import sleeves
from alpaca_mirror import (
    account_sleeves,
    check_account_alignment,
    mirror_paper_to_broker,
    plan_mirror,
)
from broker import BrokerError, ExecResult, Position, account_key_for_portfolio


# ---------------------------------------------------------------------------
# Helpers / fakes
# ---------------------------------------------------------------------------


def _book(cash, holdings):
    """A get_portfolio_book-shaped dict. holdings: [(ticker, qty, price)]."""
    enriched, value = [], 0.0
    for ticker, qty, price in holdings:
        mv = round(qty * price, 2)
        value += mv
        enriched.append({
            "ticker": ticker, "quantity": qty, "avg_cost_usd": price,
            "price_usd": price, "market_value_usd": mv,
        })
    return {
        "cash_usd": cash,
        "holdings": enriched,
        "holdings_value_usd": round(value, 2),
        "total_value_usd": round(cash + value, 2),
    }


def _live(pid, slug, *, key=None, follows="paper-1", broker="alpaca"):
    return {
        "id": pid, "slug": slug, "mode": "live",
        "broker_account_key": key, "follows_portfolio_id": follows,
        "broker": broker, "owner_user_id": "u1",
    }


class _FakePM:
    def __init__(self, books, prices):
        self.books = books
        self.prices = prices
        self.buys: list[tuple] = []
        self.sells: list[tuple] = []

    def get_portfolio_book(self, pid):
        return self.books[pid]

    def get_price(self, ticker):
        return self.prices[ticker]

    def buy_portfolio_atomic(self, pid, agent_id, ticker, qty, note="", **kw):
        self.buys.append((pid, ticker, qty, kw.get("price_override")))
        return {"status": "ok"}

    def sell_portfolio_atomic(self, pid, agent_id, ticker, qty, note="", **kw):
        self.sells.append((pid, ticker, qty, kw.get("price_override")))
        return {"status": "ok"}


class _FakeBackend:
    broker_name = "fake"
    is_sandbox = True

    def __init__(self, *, cash=0.0, positions=None, market_open=True):
        self._cash = cash
        self._positions = positions or {}
        self._market_open = market_open
        self.orders: list[tuple] = []

    def get_equity(self):
        return self._cash + sum(p.qty * 100 for p in self._positions.values())

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
        return ExecResult("filled", qty, ref_price or 100.0, "oid", "filled")


class _FakeDB:
    def __init__(self, portfolios, holdings=None, accounts=None):
        self.portfolios = portfolios
        self.holdings = holdings or {}
        self.accounts = accounts or {}
        self.agents = {"live-mirror": {"id": "agent-mirror"}}

    def get_human_portfolios(self):
        return list(self.portfolios)

    def get_portfolio_by_slug(self, slug):
        for p in self.portfolios:
            if p.get("slug") == slug:
                return p
        return None

    def get_portfolio_holdings(self, pid):
        return list(self.holdings.get(pid, []))

    def get_portfolio_account(self, pid):
        return dict(self.accounts.get(pid, {"cash_usd": 0.0}))

    def get_agent_by_handle(self, handle):
        return self.agents.get(handle)

    def get_security(self, ticker):
        return {"ticker": ticker}

    def upsert_portfolio_holding(self, row):
        pass

    def delete_portfolio_holding(self, pid, ticker):
        pass

    def upsert_portfolio_account(self, pid, update):
        self.accounts.setdefault(pid, {}).update(update)


# ---------------------------------------------------------------------------
# THE safety property
# ---------------------------------------------------------------------------


class TestSleeveIsolation(unittest.TestCase):
    """A sleeve must be blind to the other sleeves' holdings."""

    def test_sleeve_ignores_the_other_sleeves_holdings(self):
        # Sleeve A wants 100% NVDA and already holds exactly that.
        # The broker account ALSO holds AAPL — sleeve B's position.
        # A must produce NO orders: AAPL is none of its business.
        paper = _book(0, [("NVDA", 10, 100.0)])           # target: 100% NVDA
        own = {"NVDA": 12.0}                              # A's own record
        orders = plan_mirror(
            paper, equity=1200.0, own_positions=own,
            price_fn=lambda t: {"NVDA": 100.0, "AAPL": 50.0}[t],
        )
        self.assertEqual(orders, [], "sleeve A should have nothing to do")

    def test_passing_the_broker_aggregate_is_what_caused_the_bug(self):
        # Same sleeve, but handed the ACCOUNT's positions (the pre-083 bug):
        # it now sees AAPL with target weight 0 and liquidates sleeve B.
        paper = _book(0, [("NVDA", 10, 100.0)])
        aggregate = {"NVDA": 12.0, "AAPL": 20.0}
        orders = plan_mirror(
            paper, equity=1200.0, own_positions=aggregate,
            price_fn=lambda t: {"NVDA": 100.0, "AAPL": 50.0}[t],
        )
        self.assertEqual([(o.side, o.ticker) for o in orders], [("sell", "AAPL")])

    def test_sleeve_sizes_off_its_own_equity_not_the_account(self):
        # A's allowance is £500; the account holds far more. A buys 5 shares,
        # not 50.
        paper = _book(0, [("NVDA", 1, 100.0)])
        orders = plan_mirror(
            paper, equity=500.0, own_positions={},
            price_fn=lambda t: 100.0,
        )
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0].side, "buy")
        self.assertAlmostEqual(orders[0].qty, 5.0, places=4)


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestRecordedPositions(unittest.TestCase):
    def test_sums_across_sleeves(self):
        books = {
            "a": _book(0, [("NVDA", 10, 100.0)]),
            "b": _book(0, [("NVDA", 5, 100.0), ("AAPL", 3, 50.0)]),
        }
        self.assertEqual(
            sleeves.recorded_positions(books), {"NVDA": 15.0, "AAPL": 3.0},
        )

    def test_drops_symbols_summing_to_zero(self):
        books = {"a": _book(0, [("NVDA", 0.0, 100.0)])}
        self.assertEqual(sleeves.recorded_positions(books), {})

    def test_own_positions_excludes_zero_quantities(self):
        book = _book(0, [("NVDA", 10, 100.0), ("AAPL", 0.0, 50.0)])
        self.assertEqual(sleeves.sleeve_own_positions(book), {"NVDA": 10.0})


class TestPositionDrift(unittest.TestCase):
    def test_no_drift_when_aligned(self):
        self.assertEqual(
            sleeves.position_drift({"NVDA": 15.0}, {"NVDA": 15.0}), [],
        )

    def test_float_noise_is_not_drift(self):
        self.assertEqual(
            sleeves.position_drift({"NVDA": 15.0}, {"NVDA": 15.00001}), [],
        )

    def test_quantity_mismatch(self):
        d = sleeves.position_drift({"NVDA": 15.0}, {"NVDA": 14.0})
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0].ticker, "NVDA")
        self.assertEqual(d[0].delta, -1.0)

    def test_broker_holds_something_we_do_not_track(self):
        d = sleeves.position_drift({}, {"TSLA": 4.0})
        self.assertEqual([x.ticker for x in d], ["TSLA"])
        self.assertEqual(d[0].delta, 4.0)

    def test_we_track_something_the_broker_does_not_hold(self):
        d = sleeves.position_drift({"TSLA": 4.0}, {})
        self.assertEqual(d[0].delta, -4.0)

    def test_sorted_by_ticker(self):
        d = sleeves.position_drift({}, {"ZZZ": 1.0, "AAA": 1.0})
        self.assertEqual([x.ticker for x in d], ["AAA", "ZZZ"])


class TestUnallocatedCash(unittest.TestCase):
    def test_broker_cash_minus_allowances(self):
        self.assertEqual(
            sleeves.unallocated_cash(2000.0, {"a": 1200.0, "b": 500.0}), 300.0,
        )

    def test_goes_negative_when_over_committed(self):
        # Reported, not clamped — an over-commitment is a fault to surface.
        self.assertEqual(
            sleeves.unallocated_cash(1000.0, {"a": 1200.0}), -200.0,
        )

    def test_no_sleeves_means_everything_is_unallocated(self):
        self.assertEqual(sleeves.unallocated_cash(750.0, {}), 750.0)


class TestPlanCredit(unittest.TestCase):
    ALLOW = {"a": 1200.0, "b": 500.0}   # broker cash 2000 -> 300 unallocated

    def test_credit_within_unallocated(self):
        v = sleeves.plan_credit(2000.0, self.ALLOW, "a", 300.0)
        self.assertTrue(v.ok)
        self.assertEqual(v.new_balance, 1500.0)
        self.assertEqual(v.new_unallocated, 0.0)

    def test_credit_beyond_unallocated_is_refused(self):
        v = sleeves.plan_credit(2000.0, self.ALLOW, "a", 301.0)
        self.assertFalse(v.ok)
        self.assertIn("unallocated", v.reason)

    def test_debit_within_allowance(self):
        v = sleeves.plan_credit(2000.0, self.ALLOW, "b", -500.0)
        self.assertTrue(v.ok)
        self.assertEqual(v.new_balance, 0.0)
        self.assertEqual(v.new_unallocated, 800.0)

    def test_debit_beyond_allowance_is_refused(self):
        v = sleeves.plan_credit(2000.0, self.ALLOW, "b", -501.0)
        self.assertFalse(v.ok)
        self.assertIn("sell holdings", v.reason)

    def test_zero_delta_is_refused(self):
        self.assertFalse(sleeves.plan_credit(2000.0, self.ALLOW, "a", 0).ok)

    def test_crediting_an_unknown_sleeve_starts_from_zero(self):
        v = sleeves.plan_credit(2000.0, self.ALLOW, "new", 100.0)
        self.assertTrue(v.ok)
        self.assertEqual(v.new_balance, 100.0)

    def test_credit_is_refused_when_already_over_committed(self):
        v = sleeves.plan_credit(1000.0, {"a": 1200.0}, "a", 50.0)
        self.assertFalse(v.ok)


# ---------------------------------------------------------------------------
# Account grouping
# ---------------------------------------------------------------------------


class TestAccountKey(unittest.TestCase):
    def test_explicit_key_wins(self):
        self.assertEqual(
            account_key_for_portfolio(_live("p", "slug-a", key="shared")),
            "shared",
        )

    def test_falls_back_to_slug_when_absent(self):
        self.assertEqual(
            account_key_for_portfolio({"id": "p", "slug": "slug-a"}), "slug-a",
        )

    def test_blank_key_falls_back_to_slug(self):
        self.assertEqual(
            account_key_for_portfolio(_live("p", "slug-a", key="  ")), "slug-a",
        )

    def test_account_sleeves_groups_by_key_and_excludes_paper(self):
        a = _live("l1", "a-live", key="shared")
        b = _live("l2", "b-live", key="shared", follows="paper-2")
        other = _live("l3", "c-live", key="separate")
        paper = {"id": "paper-1", "slug": "p", "mode": "paper",
                 "broker_account_key": "shared"}
        db = _FakeDB([a, b, other, paper])
        self.assertEqual(
            [p["slug"] for p in account_sleeves(db, a)], ["a-live", "b-live"],
        )
        self.assertEqual([p["slug"] for p in account_sleeves(db, other)],
                         ["c-live"])


# ---------------------------------------------------------------------------
# The two refusals that protect real money
# ---------------------------------------------------------------------------


class TestMirrorRefusesOnDrift(unittest.TestCase):
    def _setup(self, broker_positions, a_holdings, b_holdings):
        a = _live("l1", "a-live", key="shared", follows="paper-1")
        b = _live("l2", "b-live", key="shared", follows="paper-2")
        paper = {"id": "paper-1", "slug": "paper", "mode": "paper"}
        books = {
            "paper-1": _book(0, [("NVDA", 10, 100.0)]),
            "l1": _book(200.0, a_holdings),
            "l2": _book(100.0, b_holdings),
        }
        db = _FakeDB([a, b, paper])
        pm = _FakePM(books, {"NVDA": 100.0, "AAPL": 50.0})
        be = _FakeBackend(cash=300.0, positions={
            s: Position(s, q, 100.0) for s, q in broker_positions.items()
        })
        return db, pm, be, a, paper

    def test_refuses_when_records_disagree_with_broker(self):
        # Records say 10 NVDA total; broker says 9. Something happened outside
        # the system, so every order derived from our records is suspect.
        db, pm, be, a, paper = self._setup(
            {"NVDA": 9.0}, [("NVDA", 10, 100.0)], [],
        )
        out = mirror_paper_to_broker(db, pm, be, a, paper)
        self.assertEqual(out["status"], "drift_refused")
        self.assertEqual(be.orders, [], "no orders on a refused run")
        self.assertEqual(pm.buys, [])

    def test_trades_when_records_align(self):
        # A holds 1 NVDA + £200 allowance; B holds 2 NVDA. Broker: 3. Aligned.
        db, pm, be, a, paper = self._setup(
            {"NVDA": 3.0}, [("NVDA", 1, 100.0)], [("NVDA", 2, 100.0)],
        )
        out = mirror_paper_to_broker(db, pm, be, a, paper)
        self.assertEqual(out["status"], "ok")
        self.assertTrue(out["shared_account"])

    def test_records_the_fill_against_the_ordering_sleeve(self):
        db, pm, be, a, paper = self._setup(
            {"NVDA": 3.0}, [("NVDA", 1, 100.0)], [("NVDA", 2, 100.0)],
        )
        mirror_paper_to_broker(db, pm, be, a, paper)
        # A's equity = 100 (1 share) + 200 cash = 300 -> target 3 shares -> buy 2
        self.assertEqual(len(pm.buys), 1)
        pid, ticker, qty, price = pm.buys[0]
        self.assertEqual(pid, "l1")
        self.assertEqual(ticker, "NVDA")
        self.assertAlmostEqual(qty, 2.0, places=4)
        self.assertEqual(price, 100.0, "books the actual fill price")

    def test_market_closed_short_circuits_before_any_drift_read(self):
        db, pm, be, a, paper = self._setup(
            {"NVDA": 9.0}, [("NVDA", 10, 100.0)], [],
        )
        be._market_open = False
        out = mirror_paper_to_broker(db, pm, be, a, paper)
        self.assertEqual(out["status"], "market_closed")

    def test_sole_occupant_warns_on_drift_but_still_trades(self):
        # Pre-083 behaviour preserved: with one live portfolio on the account,
        # sync_to_db still owns reconciliation, so drift must not block.
        solo = _live("l1", "solo-live", follows="paper-1")
        paper = {"id": "paper-1", "slug": "paper", "mode": "paper"}
        books = {
            "paper-1": _book(0, [("NVDA", 10, 100.0)]),
            "l1": _book(200.0, [("NVDA", 1, 100.0)]),
        }
        db = _FakeDB([solo, paper])
        pm = _FakePM(books, {"NVDA": 100.0})
        be = _FakeBackend(cash=200.0,
                          positions={"NVDA": Position("NVDA", 5.0, 100.0)})
        out = mirror_paper_to_broker(db, pm, be, solo, paper)
        self.assertEqual(out["status"], "ok")
        self.assertFalse(out["shared_account"])


class TestCheckAccountAlignment(unittest.TestCase):
    def test_reports_drift_across_all_sleeves_combined(self):
        a = _live("l1", "a-live", key="shared")
        b = _live("l2", "b-live", key="shared")
        pm = _FakePM(
            {"l1": _book(0, [("NVDA", 10, 100.0)]),
             "l2": _book(0, [("NVDA", 5, 100.0)])},
            {"NVDA": 100.0},
        )
        be = _FakeBackend(positions={"NVDA": Position("NVDA", 15.0, 100.0)})
        self.assertEqual(check_account_alignment(_FakeDB([]), pm, be, [a, b]), [])

        be_short = _FakeBackend(positions={"NVDA": Position("NVDA", 12.0, 100.0)})
        drift = check_account_alignment(_FakeDB([]), pm, be_short, [a, b])
        self.assertEqual(len(drift), 1)
        self.assertEqual(drift[0].delta, -3.0)


class TestSyncRefusesSharedAccount(unittest.TestCase):
    def test_refuses_to_overwrite_when_account_is_shared(self):
        a = _live("l1", "a-live", key="shared")
        b = _live("l2", "b-live", key="shared")
        db = _FakeDB([a, b])
        with self.assertRaises(BrokerError) as ctx:
            broker_sync.sync_to_db(_FakeBackend(), db, "a-live")
        msg = str(ctx.exception)
        self.assertIn("shared", msg)
        self.assertIn("a-live", msg)
        self.assertIn("b-live", msg)

    def test_still_syncs_a_sole_occupant(self):
        solo = _live("l1", "solo-live")
        db = _FakeDB([solo], accounts={"l1": {"cash_usd": 0.0}})
        be = _FakeBackend(cash=500.0,
                          positions={"NVDA": Position("NVDA", 2.0, 100.0)})
        broker_sync.sync_to_db(be, db, "solo-live")   # must not raise
        self.assertEqual(db.accounts["l1"]["cash_usd"], 500.0)

    def test_paper_refusal_still_takes_precedence(self):
        paper = {"id": "p1", "slug": "paper", "mode": "paper"}
        with self.assertRaises(BrokerError) as ctx:
            broker_sync.sync_to_db(_FakeBackend(), _FakeDB([paper]), "paper")
        self.assertIn("not 'live'", str(ctx.exception))

    def test_the_refusal_is_catchable_by_the_alpaca_cli(self):
        # alpaca_execution's --sync-all-live loop catches the exception type it
        # imports. broker_sync raises the neutral BrokerError, NOT AlpacaError,
        # so a handler written against the subclass would let the shared-account
        # refusal escape and abort the whole loop. Pin the relationship.
        from alpaca_client import AlpacaError
        self.assertTrue(issubclass(AlpacaError, BrokerError))
        a = _live("l1", "a-live", key="shared")
        b = _live("l2", "b-live", key="shared")
        with self.assertRaises(BrokerError):
            broker_sync.sync_to_db(_FakeBackend(), _FakeDB([a, b]), "a-live")
        # ...and specifically NOT the narrower subclass, so `except AlpacaError`
        # is the wrong handler.
        try:
            broker_sync.sync_to_db(_FakeBackend(), _FakeDB([a, b]), "a-live")
        except BrokerError as exc:
            self.assertNotIsInstance(exc, AlpacaError)


if __name__ == "__main__":
    unittest.main()
