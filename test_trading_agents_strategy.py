#!/usr/bin/env python3
"""Smoke test for the trading_agents strategy reconciler.

Verifies the offline pieces — decision parsing + trade planning — without
hitting Supabase, the LLM providers, or the upstream TradingAgents
framework. Run directly:

    python test_trading_agents_strategy.py
"""

from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace

from trading_agents_strategy import (
    _equal_weight_targets,
    _extract_decision,
    _plan_trades,
)


class _StubPM:
    """Minimal PortfolioManager stand-in — only `get_price` is exercised here."""

    def __init__(self, prices: dict[str, float]):
        self._prices = prices

    def get_price(self, ticker: str) -> float:
        if ticker not in self._prices:
            from portfolio import PortfolioError
            raise PortfolioError(f"no price for {ticker}")
        return self._prices[ticker]


def _ctx(prices: dict[str, float]):
    return SimpleNamespace(pm=_StubPM(prices))


class DecisionParserTests(unittest.TestCase):
    def test_final_proposal_buy(self):
        text = (
            "Risk team reviewed. Position sizing looks reasonable.\n"
            "FINAL TRANSACTION PROPOSAL: **BUY**"
        )
        self.assertEqual(_extract_decision(text), "BUY")

    def test_final_proposal_sell(self):
        text = "After debate: FINAL TRANSACTION PROPOSAL: SELL — exit fully."
        self.assertEqual(_extract_decision(text), "SELL")

    def test_final_proposal_hold(self):
        text = "Bull case unchanged but momentum stalled.\nFINAL TRANSACTION PROPOSAL: HOLD"
        self.assertEqual(_extract_decision(text), "HOLD")

    def test_fallback_to_last_token(self):
        # No explicit "FINAL TRANSACTION PROPOSAL" header — the parser
        # should fall back to the last verdict token in the text.
        text = (
            "Earlier draft considered HOLD given valuation. Trader pushed back. "
            "Final verdict: Buy."
        )
        self.assertEqual(_extract_decision(text), "BUY")

    def test_empty_text_defaults_hold(self):
        self.assertEqual(_extract_decision(""), "HOLD")
        self.assertEqual(_extract_decision("   \n"), "HOLD")


class EqualWeightTargetsTests(unittest.TestCase):
    def test_equal_weight_two_priced(self):
        ctx = _ctx({"NVDA": 1000.0, "AAPL": 200.0})
        target_qty, meta, unpriced = _equal_weight_targets(
            ctx=ctx,
            buy_tickers=["NVDA", "AAPL"],
            total_value=200_000.0,
            cash_reserve_pct=0.02,
            max_positions=20,
        )
        # investable = 196,000; per_target = 98,000.
        # NVDA qty = floor(98000 / 1000) = 98
        # AAPL qty = floor(98000 / 200) = 490
        self.assertEqual(target_qty["NVDA"], 98)
        self.assertEqual(target_qty["AAPL"], 490)
        self.assertEqual(unpriced, [])

    def test_unpriced_ticker_dropped(self):
        ctx = _ctx({"NVDA": 1000.0})
        target_qty, _meta, unpriced = _equal_weight_targets(
            ctx=ctx,
            buy_tickers=["NVDA", "MISSING"],
            total_value=100_000.0,
            cash_reserve_pct=0.02,
            max_positions=20,
        )
        self.assertIn("NVDA", target_qty)
        self.assertNotIn("MISSING", target_qty)
        self.assertEqual(unpriced, ["MISSING"])

    def test_max_positions_caps_list(self):
        ctx = _ctx({f"T{i}": 100.0 for i in range(10)})
        target_qty, _meta, _unpriced = _equal_weight_targets(
            ctx=ctx,
            buy_tickers=[f"T{i}" for i in range(10)],
            total_value=100_000.0,
            cash_reserve_pct=0.0,
            max_positions=3,
        )
        self.assertEqual(len(target_qty), 3)


class PlanTradesTests(unittest.TestCase):
    def test_buy_new_position(self):
        ctx = _ctx({"NVDA": 100.0})
        plan = _plan_trades(
            ctx=ctx,
            portfolio={"holdings": []},
            target_qty={"NVDA": 50},
            sells_tickers=set(),
            target_meta={"NVDA": {"price": 100.0}},
            min_trade_usd=500.0,
        )
        self.assertEqual(len(plan["buys"]), 1)
        self.assertEqual(plan["buys"][0][0], "NVDA")
        self.assertEqual(plan["buys"][0][1], 50)
        self.assertEqual(plan["sells"], [])

    def test_sell_explicit_sell_verdict(self):
        ctx = _ctx({"INTC": 30.0})
        plan = _plan_trades(
            ctx=ctx,
            portfolio={"holdings": [{"ticker": "INTC", "quantity": 100.0}]},
            target_qty={},  # not a BUY
            sells_tickers={"INTC"},
            target_meta={},
            min_trade_usd=500.0,
        )
        self.assertEqual(len(plan["sells"]), 1)
        self.assertEqual(plan["sells"][0][0], "INTC")
        self.assertEqual(plan["sells"][0][1], 100.0)
        self.assertEqual(plan["buys"], [])

    def test_hold_preserves_position(self):
        # No verdict at all for AAPL — it's neither BUY nor SELL. The
        # reconciler must leave the existing position untouched.
        ctx = _ctx({"AAPL": 200.0})
        plan = _plan_trades(
            ctx=ctx,
            portfolio={"holdings": [{"ticker": "AAPL", "quantity": 50.0}]},
            target_qty={},
            sells_tickers=set(),
            target_meta={},
            min_trade_usd=500.0,
        )
        self.assertEqual(plan["buys"], [])
        self.assertEqual(plan["sells"], [])

    def test_trim_overweight_buy(self):
        # Already holding 100 NVDA @ $100 = $10k, but target is 30 shares.
        # Reconciler should sell 70 shares.
        ctx = _ctx({"NVDA": 100.0})
        plan = _plan_trades(
            ctx=ctx,
            portfolio={"holdings": [{"ticker": "NVDA", "quantity": 100.0}]},
            target_qty={"NVDA": 30},
            sells_tickers=set(),
            target_meta={"NVDA": {"price": 100.0}},
            min_trade_usd=500.0,
        )
        self.assertEqual(len(plan["sells"]), 1)
        self.assertEqual(plan["sells"][0][0], "NVDA")
        self.assertEqual(plan["sells"][0][1], 70)
        self.assertEqual(plan["buys"], [])

    def test_noise_trade_skipped(self):
        # Want 1 share at $100 = $100, well below min_trade_usd=$500.
        ctx = _ctx({"NVDA": 100.0})
        plan = _plan_trades(
            ctx=ctx,
            portfolio={"holdings": []},
            target_qty={"NVDA": 1},
            sells_tickers=set(),
            target_meta={"NVDA": {"price": 100.0}},
            min_trade_usd=500.0,
        )
        self.assertEqual(plan["buys"], [])
        self.assertEqual(len(plan["noise_skipped"]), 1)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
