#!/usr/bin/env python3
"""Unit tests for the deterministic screener scoring (screen.py).

Pure-logic tests (no DB): filters, empirical-percentile components, the
value inversion, the momentum collar, the AI multiplier, weighting and
ranking. Mirrors the cases in web/lib/screen/score.ts so the Python buyer
and the website agree. Run: python test_screen.py
"""

from __future__ import annotations

import unittest

import screen


def facts(*rows: dict) -> list[dict]:
    base = {
        "ticker": "", "name": None, "sector": None, "country": "USA",
        "price": 10, "price_asof": "2026-06-03", "rev_growth_ttm": None,
        "gross_margin": None, "fcf_margin": None, "net_margin": None,
        "operating_margin": None, "rule_of_40": None, "ps": None,
        "ps_median_12m": None, "ret_52w": None, "bull": None, "bear": None,
    }
    return [{**base, **r} for r in rows]


class TestFilters(unittest.TestCase):
    def test_numeric_lte(self):
        rows = facts({"ticker": "A", "ps": 10}, {"ticker": "B", "ps": 20})
        out = screen.apply_filters(rows, [{"field": "ps", "op": "<=", "value": 15}])
        self.assertEqual([r["ticker"] for r in out], ["A"])

    def test_numeric_filter_excludes_missing(self):
        rows = facts({"ticker": "A", "ps": None})
        out = screen.apply_filters(rows, [{"field": "ps", "op": "<=", "value": 15}])
        self.assertEqual(out, [])

    def test_sector_not_equal_case_insensitive(self):
        rows = facts(
            {"ticker": "A", "sector": "Health Technology"},
            {"ticker": "B", "sector": "Technology Services"},
        )
        out = screen.apply_filters(
            rows, [{"field": "sector", "op": "!=", "value": "health technology"}]
        )
        self.assertEqual([r["ticker"] for r in out], ["B"])


class TestPercentiles(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(screen._percentiles([1, 2, 3, 4]), [0.25, 0.5, 0.75, 1.0])

    def test_nulls_preserved(self):
        self.assertEqual(screen._percentiles([None, 5]), [None, 1.0])

    def test_all_null(self):
        self.assertEqual(screen._percentiles([None, None]), [None, None])


class TestScoring(unittest.TestCase):
    def test_quality_winner_ranks_first(self):
        rows = facts(
            {"ticker": "HI", "rule_of_40": 80, "fcf_margin": 40, "gross_margin": 90, "ps": 5, "ps_median_12m": 5, "ret_52w": 10},
            {"ticker": "LO", "rule_of_40": 5, "fcf_margin": -10, "gross_margin": 20, "ps": 5, "ps_median_12m": 5, "ret_52w": 10},
        )
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False}
        out = screen.score_screen(rows, cfg)
        self.assertEqual(out[0]["ticker"], "HI")
        self.assertEqual(out[0]["rank"], 1)
        self.assertGreater(out[0]["score"], out[1]["score"])

    def test_value_inversion_cheaper_wins(self):
        # Lower P/S vs its median = cheaper = higher value score.
        rows = facts(
            {"ticker": "CHEAP", "ps": 4, "ps_median_12m": 8, "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1},
            {"ticker": "RICH", "ps": 12, "ps_median_12m": 8, "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1},
        )
        cfg = {"weights": {"quality": 0, "value": 100, "momentum": 0}, "aiMultiplier": False}
        out = screen.score_screen(rows, cfg)
        self.assertEqual(out[0]["ticker"], "CHEAP")

    def test_momentum_collar(self):
        # A huge winner is capped, a crash floored — both still rank by collar.
        rows = facts(
            {"ticker": "MOON", "ret_52w": 500, "rule_of_40": 1, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
            {"ticker": "KNIFE", "ret_52w": -90, "rule_of_40": 1, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
        )
        cfg = {"weights": {"quality": 0, "value": 0, "momentum": 100}, "aiMultiplier": False}
        out = screen.score_screen(rows, cfg)
        self.assertEqual(out[0]["ticker"], "MOON")
        self.assertEqual(out[1]["ticker"], "KNIFE")

    def test_ai_multiplier_dual_positive_boost(self):
        rows = facts(
            {"ticker": "DP", "rule_of_40": 50, "fcf_margin": 20, "gross_margin": 60, "ps": 5, "ps_median_12m": 5, "bull": True, "bear": True},
            {"ticker": "AV", "rule_of_40": 50, "fcf_margin": 20, "gross_margin": 60, "ps": 5, "ps_median_12m": 5, "bull": False, "bear": False},
        )
        on = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": True}
        out = screen.score_screen(rows, on)
        dp = next(r for r in out if r["ticker"] == "DP")
        av = next(r for r in out if r["ticker"] == "AV")
        # identical quality percentiles (both p100), so the multiplier decides
        self.assertAlmostEqual(dp["score"] / av["score"], 1.3 / 0.4, places=5)

    def test_outlier_r40_does_not_blow_up_scale(self):
        # Empirical-percentile scoring: a 26000 R40 just pins to p100.
        rows = facts(
            {"ticker": "OUT", "rule_of_40": 26000, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
            {"ticker": "NORM", "rule_of_40": 40, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
        )
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False}
        out = screen.score_screen(rows, cfg)
        self.assertLessEqual(out[0]["score"], 100.0001)
        self.assertEqual(out[0]["ticker"], "OUT")

    def test_ticker_tiebreak_ascending_on_score_desc(self):
        rows = facts(
            {"ticker": "ZZZ", "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
            {"ticker": "AAA", "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
        )
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False}
        out = screen.score_screen(rows, cfg)
        # equal scores → AAA before ZZZ
        self.assertEqual([r["ticker"] for r in out], ["AAA", "ZZZ"])

    def test_topn_helper_via_run(self):
        rows = facts(
            {"ticker": "A", "rule_of_40": 90, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
            {"ticker": "B", "rule_of_40": 50, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
            {"ticker": "C", "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
        )
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False, "topN": 2}
        ranked = screen.score_screen(rows, cfg)
        top2 = [r["ticker"] for r in ranked[: cfg["topN"]]]
        self.assertEqual(top2, ["A", "B"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
