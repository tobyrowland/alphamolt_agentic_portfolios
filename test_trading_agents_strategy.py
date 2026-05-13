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
    _apply_build_mode,
    _equal_weight_targets,
    _extract_decision,
    _per_ticker_target_qty,
    _plan_trades,
    summarize_shortlist_run,
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


class BuildModeTests(unittest.TestCase):
    def test_inactive_when_at_floor(self):
        # 15 holdings, floor 15 → not active, inputs pass through unchanged.
        buys, sells, notes = _apply_build_mode(
            buys_tickers=["NEW1"],
            sells_tickers=["AAPL"],
            current_holdings={f"H{i}" for i in range(15)},
            position_floor=15,
        )
        self.assertEqual(buys, ["NEW1"])
        self.assertEqual(sells, ["AAPL"])
        self.assertFalse(notes["active"])

    def test_inactive_when_above_floor(self):
        buys, sells, notes = _apply_build_mode(
            buys_tickers=["NEW1"],
            sells_tickers=["AAPL"],
            current_holdings={f"H{i}" for i in range(20)},
            position_floor=15,
        )
        self.assertEqual(buys, ["NEW1"])
        self.assertEqual(sells, ["AAPL"])
        self.assertFalse(notes["active"])

    def test_inactive_when_floor_zero(self):
        # position_floor=0 → feature disabled regardless of holdings.
        buys, sells, notes = _apply_build_mode(
            buys_tickers=["NEW1"],
            sells_tickers=["AAPL"],
            current_holdings={"AAPL"},
            position_floor=0,
        )
        self.assertEqual(buys, ["NEW1"])
        self.assertEqual(sells, ["AAPL"])
        self.assertFalse(notes["active"])

    def test_active_suppresses_sell_on_held(self):
        # Hold 5 names, floor 15, model says SELL on one of them → suppress.
        buys, sells, notes = _apply_build_mode(
            buys_tickers=["NEW1"],
            sells_tickers=["AAPL"],   # AAPL is held
            current_holdings={"AAPL", "MSFT", "NVDA", "GOOG", "META"},
            position_floor=15,
        )
        self.assertTrue(notes["active"])
        self.assertIn("AAPL", notes["suppressed_sells"])
        self.assertNotIn("AAPL", sells)
        # AAPL should be re-added to buys to survive the equal-weight reconcile.
        self.assertIn("AAPL", buys)

    def test_active_sells_on_unheld_pass_through(self):
        # SELL on a ticker we DON'T currently hold (e.g., model said SELL
        # on a shortlist ticker we never owned) — should NOT be suppressed.
        buys, sells, notes = _apply_build_mode(
            buys_tickers=["NEW1"],
            sells_tickers=["TSLA"],   # TSLA is NOT held
            current_holdings={"AAPL", "MSFT"},
            position_floor=15,
        )
        self.assertTrue(notes["active"])
        self.assertEqual(notes["suppressed_sells"], [])
        # The (vacuous) sell on TSLA passes through; nothing to actually sell.
        self.assertIn("TSLA", sells)

    def test_active_carries_held_tickers_as_buys(self):
        # Hold 3 names, floor 15. None of them are in the model's BUY list
        # (model didn't re-shortlist them this run). Without carry, they'd
        # be dropped from the target set; with carry, they survive.
        buys, _sells, notes = _apply_build_mode(
            buys_tickers=["NEW1", "NEW2"],
            sells_tickers=[],
            current_holdings={"AAPL", "MSFT", "NVDA"},
            position_floor=15,
        )
        self.assertTrue(notes["active"])
        self.assertCountEqual(notes["carried_holds"], ["AAPL", "MSFT", "NVDA"])
        # Combined target list: 2 new + 3 carried = 5 unique tickers.
        self.assertCountEqual(buys, ["NEW1", "NEW2", "AAPL", "MSFT", "NVDA"])

    def test_active_skips_carry_when_held_already_in_buys(self):
        # Model said BUY on a ticker we already hold → no duplicate.
        buys, _sells, notes = _apply_build_mode(
            buys_tickers=["AAPL", "NEW1"],
            sells_tickers=[],
            current_holdings={"AAPL", "MSFT"},
            position_floor=15,
        )
        self.assertTrue(notes["active"])
        self.assertEqual(buys.count("AAPL"), 1)
        self.assertCountEqual(notes["carried_holds"], ["MSFT"])

    def test_active_does_not_mutate_input_lists(self):
        # The caller may want to inspect the originals — make sure
        # _apply_build_mode returns new lists rather than mutating.
        original_buys = ["NEW1"]
        original_sells = ["AAPL"]
        _apply_build_mode(
            buys_tickers=original_buys,
            sells_tickers=original_sells,
            current_holdings={"AAPL"},
            position_floor=15,
        )
        self.assertEqual(original_buys, ["NEW1"])
        self.assertEqual(original_sells, ["AAPL"])


class PerTickerTargetQtyTests(unittest.TestCase):
    def test_equal_slice_under_floor(self):
        # $1M total, 2% reserve, floor=15 → target per position = $65,333
        # Price = $100 → qty = floor(65333 / 100) = 653
        pm = _StubPM({"NVDA": 100.0})
        qty, price, reason = _per_ticker_target_qty(
            pm=pm, ticker="NVDA",
            total_value_usd=1_000_000.0,
            position_floor=15,
            cash_reserve_pct=0.02,
            min_trade_usd=500.0,
        )
        self.assertIsNone(reason)
        self.assertEqual(qty, 653)
        self.assertEqual(price, 100.0)

    def test_skipped_unpriced(self):
        pm = _StubPM({})  # no prices for anything
        qty, _price, reason = _per_ticker_target_qty(
            pm=pm, ticker="GHOST",
            total_value_usd=1_000_000.0,
            position_floor=15,
            cash_reserve_pct=0.02,
            min_trade_usd=500.0,
        )
        self.assertEqual(qty, 0)
        self.assertEqual(reason, "skipped_unpriced")

    def test_skipped_noise_high_price(self):
        # $1M / 15 = $65,333. Per-share = $1M (way above target).
        # floor(65333 / 1_000_000) = 0 shares → skipped.
        pm = _StubPM({"BRK-A": 1_000_000.0})
        qty, _price, reason = _per_ticker_target_qty(
            pm=pm, ticker="BRK-A",
            total_value_usd=1_000_000.0,
            position_floor=15,
            cash_reserve_pct=0.02,
            min_trade_usd=500.0,
        )
        self.assertEqual(qty, 0)
        self.assertEqual(reason, "skipped_noise")

    def test_skipped_noise_below_min_trade(self):
        # total_value=$1M, floor=15 → target ~$65K
        # But min_trade_usd=$80K → 1 share at $50K = $50K, below min
        pm = _StubPM({"NVDA": 50_000.0})
        _qty, _price, reason = _per_ticker_target_qty(
            pm=pm, ticker="NVDA",
            total_value_usd=1_000_000.0,
            position_floor=15,
            cash_reserve_pct=0.02,
            min_trade_usd=80_000.0,
        )
        self.assertEqual(reason, "skipped_noise")

    def test_floor_zero_misconfig(self):
        pm = _StubPM({"NVDA": 100.0})
        qty, _price, reason = _per_ticker_target_qty(
            pm=pm, ticker="NVDA",
            total_value_usd=1_000_000.0,
            position_floor=0,
            cash_reserve_pct=0.02,
            min_trade_usd=500.0,
        )
        self.assertEqual(qty, 0)
        self.assertEqual(reason, "skipped_no_cash")


class _StubDB:
    """Minimal Supabase-shaped stub for summarize_shortlist_run tests."""

    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.client = self  # so db.client.table(...) reaches the same stub

    def table(self, name):
        self._table = name
        return self

    def select(self, _cols):
        return self

    def match(self, _filters):
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class SummarizeShortlistRunTests(unittest.TestCase):
    def test_all_traded_clean_summary(self):
        db = _StubDB([
            {"ticker": "NVDA", "status": "traded", "decision": "BUY",
             "trade_outcome": "bought", "trade_id": 1, "framework_error": None},
            {"ticker": "AAPL", "status": "traded", "decision": "HOLD",
             "trade_outcome": "skipped_hold", "trade_id": None, "framework_error": None},
            {"ticker": "INTC", "status": "traded", "decision": "SELL",
             "trade_outcome": "skipped_no_position", "trade_id": None, "framework_error": None},
        ])
        s = summarize_shortlist_run(db, agent_id="A", shortlist_run_id="R")
        self.assertEqual(s["total"], 3)
        self.assertEqual(s["by_status"], {"traded": 3})
        self.assertEqual(s["by_decision"]["BUY"], 1)
        self.assertEqual(s["by_decision"]["HOLD"], 1)
        self.assertEqual(s["by_decision"]["SELL"], 1)
        self.assertEqual(s["by_outcome"]["bought"], 1)
        self.assertEqual(s["trade_ids"], [1])
        self.assertEqual(s["errors"], [])

    def test_errors_aggregated(self):
        db = _StubDB([
            {"ticker": "NVDA", "status": "error", "decision": None,
             "trade_outcome": None, "trade_id": None,
             "framework_error": "framework timeout after 600s"},
            {"ticker": "AAPL", "status": "traded", "decision": "BUY",
             "trade_outcome": "bought", "trade_id": 42, "framework_error": None},
        ])
        s = summarize_shortlist_run(db, agent_id="A", shortlist_run_id="R")
        self.assertEqual(s["by_status"], {"error": 1, "traded": 1})
        self.assertEqual(len(s["errors"]), 1)
        self.assertEqual(s["errors"][0]["ticker"], "NVDA")
        self.assertEqual(s["trade_ids"], [42])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
