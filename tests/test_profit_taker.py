#!/usr/bin/env python3
"""Unit tests for the profit_taker sell strategy (agent_strategies.py).

Drives rebalance_profit_taker against lightweight fakes (no DB, no LLM): a fake
PortfolioManager that serves a book and records sells, and a fake db that serves
the "already trimmed" set. Run: pytest tests/test_profit_taker.py
"""

from __future__ import annotations

import unittest

from agent_strategies import RebalanceContext, rebalance_profit_taker


class FakePM:
    def __init__(self, holdings, cash=10_000.0):
        self._holdings = holdings
        self._cash = cash
        self.sells: list[tuple[str, float, str]] = []

    def get_portfolio_book(self, pid):
        hv = sum(h["quantity"] * h["price_usd"] for h in self._holdings)
        return {
            "portfolio_id": pid,
            "cash_usd": self._cash,
            "holdings": list(self._holdings),
            "holdings_value_usd": hv,
            "total_value_usd": self._cash + hv,
        }

    def sell_portfolio_atomic(self, pid, agent_id, ticker, qty, note="", **kw):
        self.sells.append((ticker, qty, note))
        return {"status": "ok", "remaining_quantity": 0}


class FakeDB:
    def __init__(self, already=None):
        self._already = set(already or [])

    def get_agent_sold_tickers(self, pid, agent_id):
        return set(self._already)


def _holding(ticker, qty, avg_cost, price):
    return {"ticker": ticker, "quantity": qty, "avg_cost_usd": avg_cost, "price_usd": price}


def _ctx(pm, db, *, params, dry_run=False):
    return RebalanceContext(
        db=db, pm=pm, agent={"id": "pt-agent", "handle": "profit-taker"},
        dry_run=dry_run, params=params, portfolio_id="port-1",
    )


class TestProfitTaker(unittest.TestCase):
    def test_trims_winner_above_threshold(self):
        # Up 50% vs cost; threshold 25%, sell 50% of 100 shares → 50.
        pm = FakePM([_holding("WIN", 100, 10.0, 15.0)])
        ctx = _ctx(pm, FakeDB(), params={"gain_pct": 25, "sell_pct": 50})
        res = rebalance_profit_taker(ctx)
        self.assertEqual(res.sells, 1)
        self.assertEqual(pm.sells[0][0], "WIN")
        self.assertEqual(pm.sells[0][1], 50)

    def test_skips_below_threshold(self):
        # Up only 10% vs cost; threshold 25% → no trim.
        pm = FakePM([_holding("MEH", 100, 10.0, 11.0)])
        ctx = _ctx(pm, FakeDB(), params={"gain_pct": 25, "sell_pct": 50})
        res = rebalance_profit_taker(ctx)
        self.assertEqual(res.sells, 0)
        self.assertEqual(pm.sells, [])

    def test_once_per_equity_ever(self):
        # Even a huge winner is skipped if the agent already trimmed it.
        pm = FakePM([_holding("WIN", 100, 10.0, 30.0)])
        ctx = _ctx(pm, FakeDB(already={"WIN"}), params={"gain_pct": 25, "sell_pct": 50})
        res = rebalance_profit_taker(ctx)
        self.assertEqual(res.sells, 0)
        self.assertIn("WIN", res.notes.get("skipped_already_trimmed", []))

    def test_full_exit_when_sell_pct_100(self):
        pm = FakePM([_holding("WIN", 80, 10.0, 14.0)])
        ctx = _ctx(pm, FakeDB(), params={"gain_pct": 25, "sell_pct": 100})
        res = rebalance_profit_taker(ctx)
        self.assertEqual(res.sells, 1)
        self.assertEqual(pm.sells[0][1], 80)  # entire position

    def test_min_trade_noise_skipped(self):
        # Trigger fires but 50% of 1 share floors to 0 → nothing to sell.
        pm = FakePM([_holding("TINY", 1, 10.0, 20.0)])
        ctx = _ctx(pm, FakeDB(), params={"gain_pct": 25, "sell_pct": 50})
        res = rebalance_profit_taker(ctx)
        self.assertEqual(res.sells, 0)

    def test_dry_run_plans_without_selling(self):
        pm = FakePM([_holding("WIN", 100, 10.0, 15.0)])
        ctx = _ctx(pm, FakeDB(), params={"gain_pct": 25, "sell_pct": 50}, dry_run=True)
        res = rebalance_profit_taker(ctx)
        self.assertEqual(res.sells, 0)
        self.assertEqual(pm.sells, [])
        plan = res.notes["dry_run_plan"]["sells"]
        self.assertEqual(plan[0]["ticker"], "WIN")
        self.assertEqual(plan[0]["qty"], 50)

    def test_no_portfolio_is_noop(self):
        pm = FakePM([])
        ctx = RebalanceContext(
            db=FakeDB(), pm=pm, agent={"id": "x", "handle": "h"},
            params={"gain_pct": 25, "sell_pct": 50}, portfolio_id=None,
        )
        res = rebalance_profit_taker(ctx)
        self.assertEqual(res.sells, 0)
        self.assertIn("human portfolio", res.notes.get("reason", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
