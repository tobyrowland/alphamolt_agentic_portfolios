#!/usr/bin/env python3
"""Unit tests for the portfolios shim (migration 021).

Covers the read-side helpers in ``db.py`` and the
``PortfolioManager._ensure_portfolio_for_agent`` flow with a stubbed
Supabase. No live DB calls.

Run directly:

    python test_portfolios.py
"""

from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace

import portfolio as portfolio_module
from db import SupabaseDB  # noqa: F401 — make sure import works


# ---------------------------------------------------------------------------
# Minimal Supabase stub — same shape as the one in test_theses.py.
# ---------------------------------------------------------------------------


class _Query:
    def __init__(self, db, table_name):
        self._db = db
        self.table_name = table_name
        self.op = None
        self.payload = None
        self.eq_filters: dict = {}
        self.match_filters: dict = {}
        self.limited = False
        self.on_conflict: str | None = None

    def select(self, _cols="*"):
        self.op = "select"
        return self

    def insert(self, payload):
        self.op = "insert"
        self.payload = payload
        return self

    def upsert(self, payload, on_conflict=None):
        self.op = "upsert"
        self.payload = payload
        self.on_conflict = on_conflict
        return self

    def update(self, payload):
        self.op = "update"
        self.payload = payload
        return self

    def eq(self, key, value):
        self.eq_filters[key] = value
        return self

    def match(self, filters):
        self.match_filters = dict(filters)
        return self

    def order(self, _key, **_kw):
        return self

    def limit(self, _n):
        self.limited = True
        return self

    def execute(self):
        # Log the op.
        self._db.log.append({
            "table": self.table_name,
            "op": self.op,
            "payload": self.payload,
            "eq": dict(self.eq_filters),
            "match": dict(self.match_filters),
            "on_conflict": self.on_conflict,
        })
        if self.op == "select":
            key = (self.table_name, frozenset(self.eq_filters.items()))
            rows = self._db.canned_selects.get(key, [])
            return SimpleNamespace(data=rows)
        if self.op in ("insert", "upsert"):
            return SimpleNamespace(data=[self.payload])
        return SimpleNamespace(data=[])


class _StubDB:
    def __init__(self):
        self.log: list[dict] = []
        self.canned_selects: dict = {}
        self.client = self

    def table(self, name):
        return _Query(self, name)


# ---------------------------------------------------------------------------
# Tests for db.py portfolio helpers (via wrapper functions)
# ---------------------------------------------------------------------------


class DbPortfolioHelpersTests(unittest.TestCase):
    """Construct a real SupabaseDB by injecting our stub client."""

    def _make_db(self) -> "SupabaseDB":
        # SupabaseDB.__init__ initialises the real client; bypass it.
        db = SupabaseDB.__new__(SupabaseDB)
        db.client = _StubDB()
        return db

    def test_get_portfolio_by_slug_returns_first_row(self):
        db = self._make_db()
        db.client.canned_selects[
            ("portfolios", frozenset({("slug", "tauric-opus-4-7")}))
        ] = [{"id": "abc", "slug": "tauric-opus-4-7", "display_name": "Foo"}]
        row = db.get_portfolio_by_slug("tauric-opus-4-7")
        self.assertEqual(row["id"], "abc")

    def test_get_portfolio_by_slug_returns_none_when_missing(self):
        db = self._make_db()
        # No canned data → empty select.
        self.assertIsNone(db.get_portfolio_by_slug("ghost"))

    def test_get_portfolio_by_agent_id_prefers_owner(self):
        db = self._make_db()
        # Owner lookup returns a hit.
        db.client.canned_selects[
            ("portfolios", frozenset({("owner_agent_id", "agent-1")}))
        ] = [{"id": "p-1", "slug": "agent-1", "owner_agent_id": "agent-1"}]
        row = db.get_portfolio_by_agent_id("agent-1")
        self.assertEqual(row["id"], "p-1")
        # No fallback select to portfolio_agents was made.
        tables_queried = [op["table"] for op in db.client.log]
        self.assertIn("portfolios", tables_queried)
        self.assertNotIn("portfolio_agents", tables_queried)

    def test_get_portfolio_by_agent_id_falls_back_to_membership(self):
        db = self._make_db()
        # Owner lookup empty; portfolio_agents has them as a member.
        db.client.canned_selects[
            ("portfolio_agents", frozenset({("agent_id", "agent-2")}))
        ] = [{"portfolio_id": "p-2"}]
        db.client.canned_selects[
            ("portfolios", frozenset({("id", "p-2")}))
        ] = [{"id": "p-2", "slug": "shared", "owner_agent_id": "other"}]
        row = db.get_portfolio_by_agent_id("agent-2")
        self.assertEqual(row["id"], "p-2")

    def test_get_portfolio_by_agent_id_returns_none_for_analyst(self):
        db = self._make_db()
        # Neither owner nor member.
        self.assertIsNone(db.get_portfolio_by_agent_id("analyst-1"))

    def test_create_portfolio_upserts_row(self):
        db = self._make_db()
        db.client.canned_selects[
            ("portfolios", frozenset({("id", "p-3")}))
        ] = [{"id": "p-3", "slug": "test", "display_name": "Test"}]
        result = db.create_portfolio(
            portfolio_id="p-3",
            slug="test",
            display_name="Test",
            owner_agent_id="agent-3",
            description="hello",
        )
        self.assertEqual(result["id"], "p-3")
        # First op is upsert into portfolios, second is select for readback.
        ops = [(op["op"], op["table"]) for op in db.client.log]
        self.assertEqual(ops[0], ("upsert", "portfolios"))
        # Payload reflects the args.
        payload = db.client.log[0]["payload"]
        self.assertEqual(payload["slug"], "test")
        self.assertEqual(payload["owner_agent_id"], "agent-3")

    def test_add_portfolio_member_uses_composite_pk(self):
        db = self._make_db()
        db.add_portfolio_member(portfolio_id="p-4", agent_id="agent-4", notes="rebalancer")
        self.assertEqual(db.client.log[0]["op"], "upsert")
        self.assertEqual(db.client.log[0]["table"], "portfolio_agents")
        self.assertEqual(db.client.log[0]["payload"]["notes"], "rebalancer")


# ---------------------------------------------------------------------------
# PortfolioManager.get_price — Level 0 primary, legacy companies fallback
# ---------------------------------------------------------------------------


class GetPriceFallbackTests(unittest.TestCase):
    """Pricing now reads Level 0 first (migration 058), so every Tier-1 name is
    priceable for trading + MTM; `companies.price` is only a transitional
    fallback until that table is retired."""

    def _pm(self, company, level0, security=None):
        pm = portfolio_module.PortfolioManager.__new__(
            portfolio_module.PortfolioManager
        )
        pm.db = SimpleNamespace(
            get_company=lambda t: company,
            get_level0_close=lambda t: level0,
            get_security=lambda t: security,
        )
        return pm

    def test_level0_price_wins(self):
        # Level 0 is primary now — it beats a (stale) legacy companies.price.
        self.assertEqual(self._pm({"price": 42.0}, 99.0).get_price("AAA"), 99.0)

    def test_level0_prices_names_absent_from_companies(self):
        self.assertEqual(self._pm(None, 180.5).get_price("TSM"), 180.5)

    def test_companies_fallback_when_level0_empty(self):
        self.assertEqual(self._pm({"price": 42.0}, None).get_price("AAA"), 42.0)

    def test_unknown_ticker_raises(self):
        with self.assertRaises(portfolio_module.PortfolioError):
            self._pm(None, None, security=None).get_price("ZZZ")


# PortfolioManager._ensure_portfolio_for_agent — creates the 1:1 shim
# ---------------------------------------------------------------------------


class EnsurePortfolioTests(unittest.TestCase):
    def _make_pm(self) -> "portfolio_module.PortfolioManager":
        pm = portfolio_module.PortfolioManager.__new__(
            portfolio_module.PortfolioManager
        )
        db = SupabaseDB.__new__(SupabaseDB)
        db.client = _StubDB()
        pm.db = db
        return pm

    def test_returns_existing_portfolio_id_without_writing(self):
        pm = self._make_pm()
        pm.db.client.canned_selects[
            ("portfolios", frozenset({("owner_agent_id", "agent-x")}))
        ] = [{"id": "existing-pid", "slug": "x", "owner_agent_id": "agent-x"}]
        pid = pm._ensure_portfolio_for_agent("agent-x")
        self.assertEqual(pid, "existing-pid")
        # No inserts/upserts.
        ops = [op["op"] for op in pm.db.client.log]
        self.assertNotIn("upsert", ops)
        self.assertNotIn("insert", ops)

    def test_creates_portfolio_when_missing(self):
        pm = self._make_pm()
        # No existing portfolio for owner_agent_id agent-y.
        # But the agents row for agent-y exists.
        pm.db.client.canned_selects[
            ("agents", frozenset({("id", "agent-y")}))
        ] = [{
            "id": "agent-y", "handle": "newbie",
            "display_name": "Newbie", "description": "test",
        }]
        # The portfolios row that create_portfolio reads back after upsert:
        pm.db.client.canned_selects[
            ("portfolios", frozenset({("id", "agent-y")}))
        ] = [{
            "id": "agent-y", "slug": "newbie",
            "display_name": "Newbie", "owner_agent_id": "agent-y",
        }]
        pid = pm._ensure_portfolio_for_agent("agent-y")
        self.assertEqual(pid, "agent-y")
        ops = [(op["op"], op["table"]) for op in pm.db.client.log]
        # Upsert portfolios + upsert portfolio_agents happened.
        self.assertIn(("upsert", "portfolios"), ops)
        self.assertIn(("upsert", "portfolio_agents"), ops)


# ---------------------------------------------------------------------------
# Portfolio-keyed shared-pot trading (migration 025)
# ---------------------------------------------------------------------------


class PortfolioTradingTests(unittest.TestCase):
    """buy_portfolio / sell_portfolio / get_portfolio_book operate on the
    portfolio_accounts + portfolio_holdings tables, not the agent ones."""

    def _make_pm(self) -> "portfolio_module.PortfolioManager":
        pm = portfolio_module.PortfolioManager.__new__(
            portfolio_module.PortfolioManager
        )
        db = SupabaseDB.__new__(SupabaseDB)
        db.client = _StubDB()
        pm.db = db
        return pm

    def _can_price(self, db, ticker: str, price: float) -> None:
        db.client.canned_selects[
            ("companies", frozenset({("ticker", ticker)}))
        ] = [{"ticker": ticker, "price": price}]

    def test_require_portfolio_account_raises_when_missing(self):
        pm = self._make_pm()
        with self.assertRaises(portfolio_module.PortfolioError):
            pm._require_portfolio_account("p-missing")

    def test_get_portfolio_book_marks_to_market(self):
        pm = self._make_pm()
        pm.db.client.canned_selects[
            ("portfolio_accounts", frozenset({("portfolio_id", "p-1")}))
        ] = [{"portfolio_id": "p-1", "cash_usd": 400000, "starting_cash": 1000000}]
        pm.db.client.canned_selects[
            ("portfolio_holdings", frozenset({("portfolio_id", "p-1")}))
        ] = [{"ticker": "NVDA", "quantity": 1000, "avg_cost_usd": 500}]
        self._can_price(pm.db, "NVDA", 700)

        book = pm.get_portfolio_book("p-1")
        self.assertEqual(book["cash_usd"], 400000)
        self.assertEqual(book["holdings_value_usd"], 700000.0)
        self.assertEqual(book["total_value_usd"], 1100000.0)
        self.assertEqual(book["pnl_usd"], 100000.0)
        self.assertEqual(book["holdings"][0]["unrealized_pnl_usd"], 200000.0)

    def test_buy_portfolio_debits_shared_cash(self):
        pm = self._make_pm()
        pm.db.client.canned_selects[
            ("portfolio_accounts", frozenset({("portfolio_id", "p-1")}))
        ] = [{"portfolio_id": "p-1", "cash_usd": 1000000, "starting_cash": 1000000}]
        self._can_price(pm.db, "NVDA", 100)

        trade = pm.buy_portfolio("p-1", "agent-9", "NVDA", 10, note="t")
        self.assertEqual(trade["side"], "buy")
        self.assertEqual(trade["portfolio_id"], "p-1")
        self.assertEqual(trade["agent_id"], "agent-9")
        self.assertEqual(trade["gross_usd"], 1000.0)
        self.assertEqual(trade["cash_after_usd"], 999000.0)
        ops = [(o["op"], o["table"]) for o in pm.db.client.log]
        self.assertIn(("upsert", "portfolio_accounts"), ops)
        self.assertIn(("upsert", "portfolio_holdings"), ops)
        self.assertIn(("insert", "agent_trades"), ops)

    def test_buy_portfolio_rejects_insufficient_cash(self):
        pm = self._make_pm()
        pm.db.client.canned_selects[
            ("portfolio_accounts", frozenset({("portfolio_id", "p-1")}))
        ] = [{"portfolio_id": "p-1", "cash_usd": 500, "starting_cash": 1000000}]
        self._can_price(pm.db, "NVDA", 100)
        with self.assertRaises(portfolio_module.PortfolioError):
            pm.buy_portfolio("p-1", "agent-9", "NVDA", 10)

    def test_sell_portfolio_rejects_missing_position(self):
        pm = self._make_pm()
        pm.db.client.canned_selects[
            ("portfolio_accounts", frozenset({("portfolio_id", "p-1")}))
        ] = [{"portfolio_id": "p-1", "cash_usd": 1000, "starting_cash": 1000000}]
        self._can_price(pm.db, "NVDA", 100)
        with self.assertRaises(portfolio_module.PortfolioError):
            pm.sell_portfolio("p-1", "agent-9", "NVDA", 5)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
