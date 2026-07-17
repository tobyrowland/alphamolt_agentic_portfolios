#!/usr/bin/env python3
"""Unit tests for the Double-Down conviction-add buyer.

Two layers, both offline (no network, no DB, no LLM):

1. ``double_down.plan_double_down`` — the pure sizing decision core.
2. ``double_down.rebalance_double_down`` end-to-end against fakes, with the LLM
   evaluation monkeypatched — exercising the candidate gates (ceiling, cooldown)
   and that adds settle through the ctx.buy facade.

Run: pytest tests/test_double_down.py
"""

from __future__ import annotations

import unittest

import double_down
from agent_strategies import RebalanceContext
from double_down import plan_double_down, rebalance_double_down


def _book(cash, holdings):
    """holdings: [{ticker, quantity, price, avg_cost?}]. Builds the book shape
    ctx.get_book / pm.get_portfolio_book return (with market_value_usd)."""
    hv = sum(h["quantity"] * h["price"] for h in holdings)
    return {
        "cash_usd": cash,
        "total_value_usd": cash + hv,
        "holdings": [
            {
                "ticker": h["ticker"],
                "quantity": h["quantity"],
                "price_usd": h["price"],
                "avg_cost_usd": h.get("avg_cost", h["price"]),
                "market_value_usd": h["quantity"] * h["price"],
            }
            for h in holdings
        ],
    }


class TestPlanDoubleDown(unittest.TestCase):
    KW = dict(add_position_pct=4.0, max_position_pct=8.0,
              cash_reserve_pct=0.02, min_add_usd=500.0)

    def test_adds_one_step_to_a_winner(self):
        # $100k NAV, hold 2% of NVDA ($2k @ $100). One 4% step = $4k → 40 shares.
        book = _book(98_000, [{"ticker": "NVDA", "quantity": 20, "price": 100.0}])
        plan = plan_double_down([{"ticker": "NVDA", "conviction": 5}], book,
                                {"NVDA": 100.0}, **self.KW)
        self.assertEqual(len(plan.buys), 1)
        self.assertEqual(plan.buys[0]["ticker"], "NVDA")
        self.assertEqual(plan.buys[0]["qty"], 40)

    def test_add_capped_by_ceiling(self):
        # Hold 6% ($6k @ $100). Ceiling 8% = $8k → gap is only $2k = 20 shares,
        # even though a full step would be $4k.
        book = _book(94_000, [{"ticker": "NVDA", "quantity": 60, "price": 100.0}])
        plan = plan_double_down([{"ticker": "NVDA", "conviction": 5}], book,
                                {"NVDA": 100.0}, **self.KW)
        self.assertEqual(plan.buys[0]["qty"], 20)

    def test_at_ceiling_is_skipped(self):
        # Hold 8% already → nothing to add.
        book = _book(92_000, [{"ticker": "NVDA", "quantity": 80, "price": 100.0}])
        plan = plan_double_down([{"ticker": "NVDA", "conviction": 5}], book,
                                {"NVDA": 100.0}, **self.KW)
        self.assertFalse(plan.buys)
        self.assertIn("ceiling", plan.skips[0]["reason"])

    def test_unheld_name_is_skipped(self):
        # A qualifying eval for a name not in the book is never opened.
        plan = plan_double_down([{"ticker": "AAPL", "conviction": 5}],
                                _book(100_000, []), {"AAPL": 100.0}, **self.KW)
        self.assertFalse(plan.buys)
        self.assertIn("not currently held", plan.skips[0]["reason"])

    def test_highest_conviction_filled_first_when_cash_short(self):
        # $100k NAV: a big FILL holding sizes NAV so the two candidates sit at 2%
        # (below the 8% ceiling) while cash is genuinely short. Spendable after
        # the 2% reserve is only $3k — under one $4k step — so the 5/5 name is
        # filled and the 4/5 name gets nothing.
        book = _book(5_000, [
            {"ticker": "FILL", "quantity": 910, "price": 100.0},  # $91k, not a candidate
            {"ticker": "AAA", "quantity": 20, "price": 100.0},    # 2% weight
            {"ticker": "BBB", "quantity": 20, "price": 100.0},    # 2% weight
        ])
        plan = plan_double_down(
            [{"ticker": "AAA", "conviction": 4}, {"ticker": "BBB", "conviction": 5}],
            book, {"AAA": 100.0, "BBB": 100.0}, **self.KW,
        )
        bought = {b["ticker"] for b in plan.buys}
        self.assertIn("BBB", bought)          # conviction 5 filled first
        self.assertNotIn("AAA", bought)       # cash exhausted before the 4/5 name

    def test_reserve_blocks_when_no_spendable_cash(self):
        # Book is fully invested (tiny cash < reserve) → nothing addable.
        book = _book(100, [{"ticker": "NVDA", "quantity": 10, "price": 100.0}])
        plan = plan_double_down([{"ticker": "NVDA", "conviction": 5}], book,
                                {"NVDA": 100.0}, **self.KW)
        self.assertFalse(plan.buys)


# --- rebalance_double_down (end to end with fakes) -------------------------


class FakePM:
    def __init__(self, prices, book):
        self._prices = prices
        self._book = book
        self.buys: list = []

    def get_price(self, ticker):
        from portfolio import PortfolioError
        if ticker not in self._prices:
            raise PortfolioError(f"no price for {ticker}")
        return self._prices[ticker]

    def get_portfolio_book(self, pid):
        return self._book

    def buy_portfolio_atomic(self, pid, aid, ticker, qty, note="", thesis=None, **kw):
        self.buys.append((ticker, qty))
        return {"status": "ok"}


class FakeDB:
    def __init__(self, recently_sold=None):
        self._recently_sold = set(recently_sold or [])

    def get_recently_sold_tickers(self, pid, days=90):
        return self._recently_sold


class TestRebalanceDoubleDown(unittest.TestCase):
    def setUp(self):
        # Patch the heavy IO helpers so the test stays offline. Facts + eval are
        # stubbed; the strategy's gates + sizing + trade facade are exercised.
        self._orig = {
            "load_facts": None,
            "build_candidate_data": None,
            "evaluate_candidates": None,
            "attach_recent_news": None,
            "serpapi_key": None,
        }
        import screen
        import llm_watchlist_buyer as buyer
        self._screen = screen
        self._buyer = buyer
        self._orig["load_facts"] = screen.load_facts
        self._orig["build_candidate_data"] = buyer.build_candidate_data
        self._orig["evaluate_candidates"] = buyer.evaluate_candidates
        self._orig["attach_recent_news"] = buyer.attach_recent_news
        self._orig["serpapi_key"] = buyer.serpapi_key

        screen.load_facts = lambda db: [
            {"ticker": "NVDA"}, {"ticker": "AAPL"},
        ]
        buyer.build_candidate_data = lambda db, fact_rows, cands: {
            t: {"ticker": t} for t in cands
        }
        buyer.serpapi_key = lambda: ""  # disable news
        buyer.attach_recent_news = lambda *a, **k: 0
        # NVDA is a 5/5 add; AAPL is a PASS.
        buyer.evaluate_candidates = lambda **kw: (
            [
                {"ticker": "NVDA", "verdict": "BUY", "conviction": 5,
                 "rationale": "still compounding", "thesis_text": "t",
                 "extend_signals": [], "break_signals": []},
                {"ticker": "AAPL", "verdict": "PASS", "conviction": 1,
                 "rationale": "fully valued", "thesis_text": "",
                 "extend_signals": [], "break_signals": []},
            ],
            {},
        )

    def tearDown(self):
        self._screen.load_facts = self._orig["load_facts"]
        self._buyer.build_candidate_data = self._orig["build_candidate_data"]
        self._buyer.evaluate_candidates = self._orig["evaluate_candidates"]
        self._buyer.attach_recent_news = self._orig["attach_recent_news"]
        self._buyer.serpapi_key = self._orig["serpapi_key"]

    def _ctx(self, pm, db, dry_run=False):
        agent = {"id": "agent-dd", "handle": "double-down"}
        return RebalanceContext(
            db=db, pm=pm, agent=agent, dry_run=dry_run,
            params={}, portfolio_id="pid-1", mandate="press winners",
        )

    def test_adds_to_the_conviction_winner_only(self):
        book = _book(96_000, [
            {"ticker": "NVDA", "quantity": 20, "price": 100.0},   # 2% weight
            {"ticker": "AAPL", "quantity": 20, "price": 100.0},   # 2% weight
        ])
        pm = FakePM({"NVDA": 100.0, "AAPL": 100.0}, book)
        res = rebalance_double_down(self._ctx(pm, FakeDB()))
        self.assertEqual(res.buys, 1)
        self.assertEqual(pm.buys[0][0], "NVDA")   # only the 5/5 name
        self.assertFalse(res.errors)

    def test_cooldown_name_is_left_alone(self):
        # NVDA was sold in the last 90 days → never re-added, even at 5/5.
        book = _book(98_000, [{"ticker": "NVDA", "quantity": 20, "price": 100.0}])
        pm = FakePM({"NVDA": 100.0}, book)
        res = rebalance_double_down(self._ctx(pm, FakeDB(recently_sold={"NVDA"})))
        self.assertEqual(res.buys, 0)
        self.assertFalse(pm.buys)

    def test_dry_run_places_no_orders(self):
        book = _book(96_000, [{"ticker": "NVDA", "quantity": 20, "price": 100.0}])
        pm = FakePM({"NVDA": 100.0}, book)
        res = rebalance_double_down(self._ctx(pm, FakeDB(), dry_run=True))
        self.assertFalse(pm.buys)
        self.assertIn("dry_run_plan", res.notes)

    def test_no_holdings_is_a_noop(self):
        book = _book(1_000_000, [])
        pm = FakePM({}, book)
        res = rebalance_double_down(self._ctx(pm, FakeDB()))
        self.assertEqual(res.buys, 0)
        self.assertIn("reason", res.notes)


if __name__ == "__main__":
    unittest.main()
