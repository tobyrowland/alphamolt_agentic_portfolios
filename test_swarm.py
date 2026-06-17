#!/usr/bin/env python3
"""Unit tests for the portfolio swarm coordination (swarm.py).

Pure-logic tests of the snake-draft buy cycle and first-valid-sell — the
decisions (convictions, verdicts) are injected. Run: python test_swarm.py
"""

from __future__ import annotations

import unittest

from swarm import Buyer, snake_draft_plan, first_valid_sell_plan


PRICES = {"AAA": 10.0, "BBB": 10.0, "CCC": 10.0, "DDD": 10.0}


class TestSnakeDraft(unittest.TestCase):
    def test_rotates_and_reverses_each_round(self):
        buyers = [Buyer("A", gate=1, max_per_name=0.25), Buyer("B", gate=1, max_per_name=0.25)]
        # Both love everything equally; pool order decides preference.
        conv = {"A": {t: 5 for t in PRICES}, "B": {t: 5 for t in PRICES}}
        res = snake_draft_plan(
            buyers, ["AAA", "BBB", "CCC", "DDD"], PRICES,
            total_value=1000, cash=1000, cash_reserve_pct=0.0, convictions=conv,
        )
        order = [(p.agent_id, p.ticker) for p in res.picks]
        # Round 0: A→AAA, B→BBB. Round 1 (reversed): B→CCC, A→DDD.
        self.assertEqual(order, [("A", "AAA"), ("B", "BBB"), ("B", "CCC"), ("A", "DDD")])

    def test_conviction_gate_can_pass(self):
        buyers = [Buyer("A", gate=4, max_per_name=0.5), Buyer("B", gate=1, max_per_name=0.5)]
        conv = {"A": {"AAA": 2, "BBB": 2}, "B": {"AAA": 5, "BBB": 5}}
        res = snake_draft_plan(
            buyers, ["AAA", "BBB"], PRICES,
            total_value=1000, cash=1000, cash_reserve_pct=0.0, convictions=conv,
        )
        # A clears nothing (all below its gate of 4) → only B drafts; A passes
        # every round it gets a turn.
        self.assertTrue(all(p.agent_id == "B" for p in res.picks))
        self.assertGreaterEqual(res.passes.get("A", 0), 1)

    def test_drafted_name_is_taken_no_double_buy(self):
        buyers = [Buyer("A", gate=1, max_per_name=0.25), Buyer("B", gate=1, max_per_name=0.25)]
        conv = {"A": {"AAA": 5}, "B": {"AAA": 5}}  # both only want AAA
        res = snake_draft_plan(
            buyers, ["AAA"], PRICES,
            total_value=1000, cash=1000, cash_reserve_pct=0.0, convictions=conv,
        )
        tickers = [p.ticker for p in res.picks]
        self.assertEqual(tickers, ["AAA"])  # taken once, by A (drafts first)
        self.assertEqual(res.picks[0].agent_id, "A")

    def test_shared_cash_exhausts(self):
        buyers = [Buyer("A", gate=1, max_per_name=1.0)]
        conv = {"A": {t: 5 for t in PRICES}}
        # Only $25 cash, $10 price, max_per_name lets it spend all → 2 shares of
        # the first name, then no cash for a second name.
        res = snake_draft_plan(
            buyers, ["AAA", "BBB"], PRICES,
            total_value=1000, cash=25, cash_reserve_pct=0.0, convictions=conv,
        )
        self.assertEqual(len(res.picks), 1)
        self.assertEqual(res.picks[0].ticker, "AAA")
        self.assertEqual(res.picks[0].qty, 2)
        self.assertAlmostEqual(res.cash_remaining, 5.0)

    def test_attribution_recorded(self):
        buyers = [Buyer("deep-value", gate=1, max_per_name=0.5)]
        conv = {"deep-value": {"AAA": 3}}
        res = snake_draft_plan(
            buyers, ["AAA"], PRICES,
            total_value=1000, cash=1000, cash_reserve_pct=0.0, convictions=conv,
        )
        self.assertEqual(res.picks[0].agent_id, "deep-value")
        self.assertEqual(res.picks[0].conviction, 3)

    def test_unaffordable_top_pick_falls_through_to_affordable(self):
        # Buyer wants AAA most but can't afford a full max position of it at the
        # cash left; it should still draft the next eligible it can afford.
        prices = {"AAA": 10000.0, "BBB": 10.0}
        buyers = [Buyer("A", gate=1, max_per_name=0.01)]  # 0.01*1000 = $10 budget/name
        conv = {"A": {"AAA": 5, "BBB": 4}}
        res = snake_draft_plan(
            buyers, ["AAA", "BBB"], prices,
            total_value=1000, cash=1000, cash_reserve_pct=0.0, convictions=conv,
        )
        self.assertEqual([p.ticker for p in res.picks], ["BBB"])

    def test_no_convictions_means_no_picks(self):
        buyers = [Buyer("A", gate=1, max_per_name=0.5)]
        res = snake_draft_plan(
            buyers, ["AAA"], PRICES,
            total_value=1000, cash=1000, cash_reserve_pct=0.0, convictions={},
        )
        self.assertEqual(res.picks, [])

    def test_passed_names_omitted_from_convictions_arent_drafted(self):
        # The LLM-buyer path puts ONLY BUY>=gate names in the convictions map;
        # PASS / sub-gate names are absent and must never be drafted, even though
        # they're in the candidate pool.
        buyers = [Buyer("A", gate=5, max_per_name=0.5)]
        conv = {"A": {"AAA": 5}}  # BBB was a PASS → omitted entirely
        res = snake_draft_plan(
            buyers, ["AAA", "BBB"], PRICES,
            total_value=1000, cash=1000, cash_reserve_pct=0.0, convictions=conv,
        )
        self.assertEqual([p.ticker for p in res.picks], ["AAA"])

    def test_min_order_value_skips_dust_picks(self):
        # A buyer with only tail cash left should NOT open a sub-floor sliver
        # (the CLOV $9.62 bug). With a $50 floor and ~$30 spendable, it passes.
        buyers = [Buyer("A", gate=1, max_per_name=1.0)]
        conv = {"A": {"AAA": 5}}
        res = snake_draft_plan(
            buyers, ["AAA"], PRICES,
            total_value=1000, cash=30, cash_reserve_pct=0.0,
            min_order_value=50.0, convictions=conv,
        )
        self.assertEqual(res.picks, [])

    def test_min_order_value_allows_above_floor(self):
        buyers = [Buyer("A", gate=1, max_per_name=1.0)]
        conv = {"A": {"AAA": 5}}
        res = snake_draft_plan(
            buyers, ["AAA"], PRICES,
            total_value=1000, cash=100, cash_reserve_pct=0.0,
            min_order_value=50.0, convictions=conv,
        )
        self.assertEqual(len(res.picks), 1)
        self.assertEqual(res.picks[0].qty, 10)  # $100 / $10


class TestFirstValidSell(unittest.TestCase):
    def test_first_reviewer_in_order_wins(self):
        verdicts = {
            "R1": {"AAA": {"verdict": "HOLD"}},
            "R2": {"AAA": {"verdict": "SELL", "reason": "thesis broken"}},
            "R3": {"AAA": {"verdict": "SELL", "reason": "drawdown"}},
        }
        out = first_valid_sell_plan(["R1", "R2", "R3"], ["AAA"], verdicts)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].agent_id, "R2")
        self.assertEqual(out[0].reason, "thesis broken")

    def test_no_sell_when_all_hold(self):
        verdicts = {"R1": {"AAA": {"verdict": "HOLD"}}}
        self.assertEqual(first_valid_sell_plan(["R1"], ["AAA"], verdicts), [])

    def test_only_covered_names_considered(self):
        verdicts = {"R1": {"AAA": {"verdict": "SELL", "reason": "x"}}}
        out = first_valid_sell_plan(["R1"], ["AAA", "BBB"], verdicts)
        self.assertEqual([t.ticker for t in out], ["AAA"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
