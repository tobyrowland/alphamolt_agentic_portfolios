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

import broker
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


class TestSharedCredentialFallback(unittest.TestCase):
    """Sleeves of ONE account must keep working on the bare ALPACA_* env vars.

    The anti-commingle rule is about distinct *accounts*, not the number of live
    portfolios. Counting portfolios would force an owner with one Alpaca account
    to invent an ALPACA_ACCOUNTS map purely because they split it into two
    sleeves — friction with no safety benefit, since both resolve the same
    credentials anyway.
    """

    @staticmethod
    def _distinct_accounts(live):
        return len({account_key_for_portfolio(p) for p in live})

    def test_two_sleeves_of_one_account_count_as_one(self):
        live = [
            _live("l1", "a-live", key="toby-live"),
            _live("l2", "b-live", key="toby-live"),
        ]
        self.assertEqual(self._distinct_accounts(live), 1)

    def test_two_genuinely_different_accounts_count_as_two(self):
        live = [
            _live("l1", "a-live", key="toby-live"),
            _live("l2", "b-live", key="someone-else-live"),
        ]
        self.assertEqual(self._distinct_accounts(live), 2)

    def test_unkeyed_portfolios_fall_back_to_distinct_slugs(self):
        # Pre-083 rows have no key, so they resolve by slug and stay separate —
        # which is the safe reading when the owner hasn't declared sharing.
        live = [_live("l1", "a-live"), _live("l2", "b-live")]
        self.assertEqual(self._distinct_accounts(live), 2)


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
        # A's equity = 100 (1 share) + 200 cash = 300 -> target 3 shares -> buy 2.
        # The order is then trimmed to what A's $200 allowance can actually pay
        # for at the marketable limit ($103 = $100 + the 3% band): 1.9417 sh.
        # Sizing off the $100 reference price instead would let a fill land
        # anywhere up to $103, and the RPC would refuse it AFTER the broker had
        # taken the shares — which is exactly the divergence that halted the
        # real account on 2026-08-26.
        self.assertEqual(len(pm.buys), 1)
        pid, ticker, qty, price = pm.buys[0]
        self.assertEqual(pid, "l1")
        self.assertEqual(ticker, "NVDA")
        self.assertLessEqual(qty * 103.0, 200.0, "never orders past the allowance")
        self.assertAlmostEqual(qty, 1.9417, places=4)
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


class TestPlanInKind(unittest.TestCase):
    """Funding a sleeve from a sibling: cash first, proportional shares after."""

    H = [
        {"ticker": "NVDA", "quantity": 10.0, "avg_cost_usd": 80.0, "price": 100.0},
        {"ticker": "AAPL", "quantity": 20.0, "avg_cost_usd": 40.0, "price": 50.0},
    ]  # holdings value = 1000 + 1000 = 2000

    def test_cash_covers_it_all(self):
        plan = sleeves.plan_in_kind(500.0, self.H, 300.0)
        self.assertEqual(plan.cash_move, 300.0)
        self.assertEqual(plan.share_moves, ())
        self.assertEqual(plan.planned_total, 300.0)

    def test_shares_cover_the_remainder_proportionally(self):
        # 100 cash + 1000 from shares = half of each position.
        plan = sleeves.plan_in_kind(100.0, self.H, 1100.0)
        self.assertEqual(plan.cash_move, 100.0)
        by = {m.ticker: m for m in plan.share_moves}
        self.assertAlmostEqual(by["NVDA"].qty, 5.0, places=4)
        self.assertAlmostEqual(by["AAPL"].qty, 10.0, places=4)
        self.assertEqual(by["NVDA"].avg_cost, 80.0)
        self.assertAlmostEqual(plan.planned_total, 1100.0, places=2)

    def test_fraction_caps_at_full_liquidation(self):
        # Asking for more than cash+holdings: plan moves everything it has,
        # planned_total reports the shortfall for the caller to refuse on.
        plan = sleeves.plan_in_kind(100.0, self.H, 5000.0)
        by = {m.ticker: m for m in plan.share_moves}
        self.assertAlmostEqual(by["NVDA"].qty, 10.0, places=4)
        self.assertAlmostEqual(by["AAPL"].qty, 20.0, places=4)
        self.assertAlmostEqual(plan.planned_total, 2100.0, places=2)
        self.assertLess(plan.planned_total, 5000.0)

    def test_dust_legs_are_dropped(self):
        holdings = self.H + [
            {"ticker": "TINY", "quantity": 0.01, "avg_cost_usd": 1.0, "price": 2.0},
        ]
        plan = sleeves.plan_in_kind(0.0, holdings, 1000.0)
        self.assertNotIn("TINY", {m.ticker for m in plan.share_moves})

    def test_unpriced_holdings_are_skipped(self):
        holdings = self.H + [
            {"ticker": "NOPX", "quantity": 5.0, "avg_cost_usd": 10.0, "price": 0},
        ]
        plan = sleeves.plan_in_kind(0.0, holdings, 500.0)
        self.assertNotIn("NOPX", {m.ticker for m in plan.share_moves})

    def test_negative_source_cash_treated_as_zero(self):
        plan = sleeves.plan_in_kind(-50.0, self.H, 200.0)
        self.assertEqual(plan.cash_move, 0.0)
        self.assertGreater(len(plan.share_moves), 0)

    def test_missing_avg_cost_falls_back_to_price(self):
        holdings = [{"ticker": "X", "quantity": 4.0, "avg_cost_usd": None, "price": 25.0}]
        plan = sleeves.plan_in_kind(0.0, holdings, 50.0)
        self.assertEqual(plan.share_moves[0].avg_cost, 25.0)


class TestSharedCredentialsGuard(unittest.TestCase):
    """The anti-commingle guard counts ACCOUNTS, never portfolios.

    Production on 2026-08-27: two live portfolios, one shared broker account.
    Counting portfolios made every `live_cash` allowance command refuse — so
    the repair's $90.03 top-up failed and a correct plan booked nothing.
    """

    @staticmethod
    def _pf(slug, key=None):
        pf = {"id": slug, "slug": slug, "mode": "live"}
        if key is not None:
            pf["broker_account_key"] = key
        return pf

    def test_two_sleeves_of_one_account_may_use_the_bare_credentials(self):
        """The exact production shape."""
        live = [
            self._pf("scrappy-fightback-live", "test-portfolio-toby-live"),
            self._pf("test-portfolio-toby-live"),
        ]
        self.assertTrue(broker.shared_credentials_permitted(live))

    def test_two_distinct_accounts_may_not(self):
        """The case the guard actually exists for."""
        live = [self._pf("mine-live"), self._pf("theirs-live")]
        self.assertFalse(broker.shared_credentials_permitted(live))

    def test_a_sole_live_portfolio_may(self):
        self.assertTrue(broker.shared_credentials_permitted([self._pf("solo-live")]))

    def test_many_sleeves_of_one_account_still_may(self):
        live = [self._pf(f"s{i}-live", "one-account") for i in range(5)]
        self.assertTrue(broker.shared_credentials_permitted(live))

    def test_a_null_account_key_falls_back_to_the_slug(self):
        """Pre-083 rows carry no key; two of them are two accounts."""
        self.assertFalse(
            broker.shared_credentials_permitted(
                [self._pf("a-live"), self._pf("b-live")]
            )
        )


class TestGuardIsNotOpenCoded(unittest.TestCase):
    """One rule, one place — it was open-coded four times and got it wrong twice."""

    def test_no_module_recomputes_the_account_count_itself(self):
        import pathlib as _p
        offenders = []
        for name in ("live_cash.py", "alpaca_mirror.py", "alpaca_execution.py"):
            text = _p.Path(name).read_text()
            if "account_key_for_portfolio(p) for p in" in text:
                offenders.append(name)
        self.assertEqual(
            offenders, [],
            "these re-derive the anti-commingle guard instead of calling "
            "broker.shared_credentials_permitted",
        )


if __name__ == "__main__":
    unittest.main()


class TestBaselineArithmetic(unittest.TestCase):
    """P&L baselines have to move with the money (sleeves.baseline_after_*).

    A sleeve's return is (value - starting_cash) / starting_cash. If capital
    can arrive or leave without the baseline moving, the movement itself is
    booked as performance — a deposit reads as profit, a withdrawal as a loss.
    """

    def test_deposit_grows_the_baseline_by_the_amount(self):
        """New capital starts flat: it is not profit."""
        self.assertEqual(sleeves.baseline_after_deposit(1000.0, 500.0), 1500.0)

    def test_deposit_ignores_non_positive_amounts(self):
        self.assertEqual(sleeves.baseline_after_deposit(1000.0, 0.0), 1000.0)
        self.assertEqual(sleeves.baseline_after_deposit(1000.0, -5.0), 1000.0)

    def test_withdrawal_leaves_the_return_percentage_unchanged(self):
        """The whole point: taking money out is not a loss."""
        starting, equity, out = 5000.0, 10000.0, 4000.0
        before = (equity - starting) / starting
        after_baseline = sleeves.baseline_after_withdrawal(starting, out, equity)
        after = (equity - out - after_baseline) / after_baseline
        self.assertAlmostEqual(before, after, places=6)

    def test_the_production_regression_market_vs_cost_basis(self):
        """The bug migration 085 fixes, in numbers.

        $10,000 left a sleeve worth $27,661.42 at market whose cost basis was
        ~$26,684. Rescaling against market keeps the return at 106.03%;
        rescaling against cost basis inflates it to ~110.4% — which is exactly
        what the live account reported.
        """
        starting, market, cost, out = 13425.6, 27661.42, 26684.0, 10000.0
        remaining = market - out

        correct = sleeves.baseline_after_withdrawal(starting, out, market)
        self.assertAlmostEqual((remaining / correct - 1) * 100, 106.03, places=1)

        wrong = sleeves.baseline_after_withdrawal(starting, out, cost)
        self.assertGreater((remaining / wrong - 1) * 100, 109.0)

    def test_withdrawal_refuses_to_rescale_on_unusable_equity(self):
        """A wrong rescale is worse than none."""
        self.assertEqual(sleeves.baseline_after_withdrawal(1000.0, 100.0, 0.0), 1000.0)
        self.assertEqual(sleeves.baseline_after_withdrawal(1000.0, 500.0, 400.0), 1000.0)
        self.assertEqual(sleeves.baseline_after_withdrawal(0.0, 100.0, 5000.0), 0.0)

    def test_a_round_trip_out_and_back_restores_the_baseline(self):
        """Move value out of a sleeve and put the same value back."""
        starting, equity = 8000.0, 20000.0
        out = 5000.0
        after_out = sleeves.baseline_after_withdrawal(starting, out, equity)
        after_in = sleeves.baseline_after_deposit(after_out, out)
        # Not identical — the withdrawal scaled by the sleeve's gain — but the
        # return after the round trip is what it should be: the sleeve is worth
        # what it started with, against a baseline that grew by the returned
        # capital rather than pretending the trip was profit.
        self.assertLess(after_in, starting + out)
        self.assertGreater(after_in, starting)


class TestAffordableBuyQty(unittest.TestCase):
    """A sleeve may only order what its own allowance can pay for.

    The broker's pooled cash is bigger than any one sleeve's allowance, so the
    broker fills an order the DB then refuses — which is how 2026-08-26's halt
    started. The check must therefore run BEFORE the order is placed, and
    against the limit price rather than the reference price, because a
    marketable limit can fill anywhere up to the band.
    """

    def test_an_affordable_order_passes_through_untouched(self):
        self.assertEqual(sleeves.affordable_buy_qty(10.0, 100.0, 5_000.0), 10.0)

    def test_an_exactly_affordable_order_is_not_trimmed(self):
        self.assertEqual(sleeves.affordable_buy_qty(10.0, 100.0, 1_000.0), 10.0)

    def test_a_short_allowance_trims_rather_than_skips(self):
        """Skipping would stall: the same shortfall recurs on every run."""
        qty = sleeves.affordable_buy_qty(10.0, 100.0, 640.0)
        self.assertGreater(qty, 0)
        self.assertLess(qty, 10.0)
        self.assertLessEqual(qty * 100.0, 640.0)

    def test_the_trim_rounds_down_never_up(self):
        """Rounding to nearest can round back over the allowance."""
        # 1360.48 / 360.11 = 3.77796...; rounding UP at 4dp would exceed it.
        qty = sleeves.affordable_buy_qty(3.9892, 360.11, 1360.48)
        self.assertLessEqual(qty * 360.11, 1360.48)

    def test_the_real_failure_would_have_been_trimmed(self):
        """2026-08-26: buy ZBRA 3.9892 against a $1,360.48 allowance.

        The order cost ~$1,437 at the fill price. It filled at the broker, the
        RPC refused to book it, and every subsequent run refused to trade.
        """
        qty = sleeves.affordable_buy_qty(3.9892, 360.11, 1360.48)
        self.assertLess(qty, 3.9892)
        self.assertLessEqual(qty * 360.11, 1360.48)

    def test_no_allowance_means_no_order(self):
        self.assertEqual(sleeves.affordable_buy_qty(10.0, 100.0, 0.0), 0.0)
        self.assertEqual(sleeves.affordable_buy_qty(10.0, 100.0, -50.0), 0.0)

    def test_a_trim_down_to_dust_is_dropped(self):
        """A $3 order costs a round trip and leaves a dust position."""
        self.assertEqual(sleeves.affordable_buy_qty(10.0, 100.0, 3.0), 0.0)

    def test_an_unusable_price_or_quantity_orders_nothing(self):
        self.assertEqual(sleeves.affordable_buy_qty(10.0, 0.0, 5_000.0), 0.0)
        self.assertEqual(sleeves.affordable_buy_qty(0.0, 100.0, 5_000.0), 0.0)


def _drift(ticker, recorded, actual):
    return sleeves.PositionDrift(ticker, recorded, actual)


def _fill(symbol, side, qty, price, order_id):
    return {
        "symbol": symbol, "side": side, "qty": str(qty),
        "price": str(price), "order_id": order_id,
    }


class TestPlanRepair(unittest.TestCase):
    """Booking the fills our records are missing — at the broker's own prices.

    ``sync_to_db`` reconciles a sole-occupant account by overwriting the book
    from the broker. On a shared account that is forbidden, so nothing repaired
    a missed fill and the alignment gate halted trading indefinitely. This is
    the narrow, attributed alternative.
    """

    def test_an_unrecorded_buy_is_booked_at_the_broker_price(self):
        plan = sleeves.plan_repair(
            [_drift("ZBRA", 2.3718, 6.3610)],
            [_fill("ZBRA", "buy", 3.9892, 360.11, "ord-1")],
            recorded_order_ids=set(),
            allowance=5_000.0,
            unallocated=0.0,
        )
        self.assertEqual(len(plan.legs), 1)
        leg = plan.legs[0]
        self.assertEqual(leg.side, "buy")
        self.assertEqual(leg.ticker, "ZBRA")
        self.assertAlmostEqual(leg.qty, 3.9892, places=4)
        self.assertEqual(leg.price, 360.11)
        self.assertEqual(plan.refusals, ())
        self.assertEqual(plan.topup, 0.0)

    def test_a_short_allowance_is_topped_up_from_unallocated(self):
        """The buy was paid for out of pooled cash, so the sleeve is short."""
        plan = sleeves.plan_repair(
            [_drift("ZBRA", 2.3718, 6.3610)],
            [_fill("ZBRA", "buy", 3.9892, 360.11, "ord-1")],
            recorded_order_ids=set(),
            allowance=1360.48,
            unallocated=12_149.18,
        )
        self.assertEqual(len(plan.legs), 1)
        self.assertGreater(plan.topup, 0)
        self.assertAlmostEqual(
            plan.topup, round(plan.legs[0].value - 1360.48, 2), places=2,
        )

    def test_it_refuses_when_unallocated_cannot_cover_the_topup(self):
        plan = sleeves.plan_repair(
            [_drift("ZBRA", 2.3718, 6.3610)],
            [_fill("ZBRA", "buy", 3.9892, 360.11, "ord-1")],
            recorded_order_ids=set(),
            allowance=0.0,
            unallocated=10.0,
        )
        self.assertEqual(plan.legs, ())
        self.assertTrue(any("unallocated" in r for r in plan.refusals))

    def test_a_difference_with_no_broker_fill_is_refused_not_guessed(self):
        """A guessed cost basis is a permanent, silent error in every return."""
        plan = sleeves.plan_repair(
            [_drift("ZBRA", 2.0, 6.0)],
            [],
            recorded_order_ids=set(),
            allowance=100_000.0,
            unallocated=0.0,
        )
        self.assertEqual(plan.legs, ())
        self.assertEqual(len(plan.refusals), 1)

    def test_a_fill_we_already_booked_is_not_booked_twice(self):
        """Re-booking a recorded order would double a real position."""
        plan = sleeves.plan_repair(
            [_drift("ZBRA", 2.3718, 6.3610)],
            [_fill("ZBRA", "buy", 3.9892, 360.11, "ord-1")],
            recorded_order_ids={"ord-1"},
            allowance=100_000.0,
            unallocated=0.0,
        )
        self.assertEqual(plan.legs, ())
        self.assertEqual(len(plan.refusals), 1)

    def test_an_unrecorded_sell_credits_rather_than_costs(self):
        plan = sleeves.plan_repair(
            [_drift("AAA", 10.0, 4.0)],
            [_fill("AAA", "sell", 6.0, 50.0, "ord-2")],
            recorded_order_ids=set(),
            allowance=0.0,
            unallocated=0.0,
        )
        self.assertEqual(len(plan.legs), 1)
        self.assertEqual(plan.legs[0].side, "sell")
        self.assertEqual(plan.topup, 0.0)
        self.assertEqual(plan.net_cash, 300.0)

    def test_sells_are_booked_before_buys_so_proceeds_fund_them(self):
        plan = sleeves.plan_repair(
            [_drift("AAA", 10.0, 4.0), _drift("ZBRA", 2.0, 6.0)],
            [
                _fill("AAA", "sell", 6.0, 100.0, "ord-2"),
                _fill("ZBRA", "buy", 4.0, 100.0, "ord-1"),
            ],
            recorded_order_ids=set(),
            allowance=0.0,
            unallocated=0.0,
        )
        self.assertEqual([leg.side for leg in plan.legs], ["sell", "buy"])
        # $600 of proceeds covers the $400 buy, so nothing has to be credited.
        self.assertEqual(plan.topup, 0.0)

    def test_a_price_the_broker_cannot_supply_is_refused(self):
        plan = sleeves.plan_repair(
            [_drift("ZBRA", 2.0, 6.0)],
            [{"symbol": "ZBRA", "side": "buy", "qty": "4", "price": None,
              "order_id": "ord-1"}],
            recorded_order_ids=set(),
            allowance=100_000.0,
            unallocated=0.0,
        )
        self.assertEqual(plan.legs, ())
        self.assertTrue(any("price" in r for r in plan.refusals))

    def test_it_books_the_newest_fill_regardless_of_input_order(self):
        """The drift came from the most recent fill, not an older one.

        Booking the stale price would be a permanent, silent error in every
        return the sleeve reports afterwards — so the ordering is decided here
        rather than trusted from whatever order the broker's API returned.
        """
        old_fill = dict(_fill("ZBRA", "buy", 4.0, 100.00, "old"),
                        transaction_time="2026-08-01T14:00:00Z")
        new_fill = dict(_fill("ZBRA", "buy", 4.0, 360.11, "new"),
                        transaction_time="2026-08-26T14:23:00Z")
        for order in ([old_fill, new_fill], [new_fill, old_fill]):
            with self.subTest(order=[f["order_id"] for f in order]):
                plan = sleeves.plan_repair(
                    [_drift("ZBRA", 2.0, 6.0)],
                    order,
                    recorded_order_ids=set(),
                    allowance=100_000.0,
                    unallocated=0.0,
                )
                self.assertEqual(len(plan.legs), 1)
                self.assertEqual(plan.legs[0].price, 360.11)
                self.assertEqual(plan.legs[0].order_id, "new")

    def test_it_never_nets_one_symbol_against_another(self):
        """Two differences produce two legs, not one combined adjustment."""
        plan = sleeves.plan_repair(
            [_drift("AAA", 0.0, 2.0), _drift("BBB", 0.0, 3.0)],
            [
                _fill("AAA", "buy", 2.0, 10.0, "o1"),
                _fill("BBB", "buy", 3.0, 10.0, "o2"),
            ],
            recorded_order_ids=set(),
            allowance=100_000.0,
            unallocated=0.0,
        )
        self.assertEqual({leg.ticker for leg in plan.legs}, {"AAA", "BBB"})


if __name__ == "__main__":
    unittest.main()
