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
        "ps_median_12m": None, "ret_52w": None, "perf_52w_vs_spy": None,
        "bull": None, "bear": None, "quality_score": None,
        # Research-card scalars (migration 057). has_card False ⇒ adj_z = 0.
        "moat_score": None, "earnings_score": None, "growth_score": None,
        "break_count": None, "has_card": False,
        "industry_ps_median": None, "sector_ps_median": None,
        "peer_ps_median": None, "peer_basis": None,
    }
    return [{**base, **r} for r in rows]


# A unit-scale stats fixture: μ=0, σ=1 per lens, so a raw lens value passes
# straight through as its own z-score (winsorized to ±3). Lets the single-score
# tests assert exact adj_z magnitudes against a known base_z.
UNIT_STATS = {
    "quality": {"mu": 0.0, "sigma": 1.0, "n": 100},
    "value": {"mu": 0.0, "sigma": 1.0, "n": 100},
    "momentum": {"mu": 0.0, "sigma": 1.0, "n": 100},
}


def carded(**card) -> dict:
    """Mark a row as having a research card with the given dim scores."""
    d = {"has_card": True, "moat_score": 3, "earnings_score": 3,
         "growth_score": 3, "break_count": 0}
    d.update(card)
    return d


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


class TestSingleScore(unittest.TestCase):
    """Single ordering score (migration 057): final_z = base_z + adj_z, ranked on
    final_z, surfaced as round(Φ(final_z)·100)."""

    def test_quality_winner_ranks_first(self):
        rows = facts(
            {"ticker": "HI", "rule_of_40": 80, "fcf_margin": 40, "gross_margin": 90, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "LO", "rule_of_40": 5, "fcf_margin": -10, "gross_margin": 20, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}}
        out = screen.score_screen(rows, cfg)
        self.assertEqual(out[0]["ticker"], "HI")
        self.assertEqual(out[0]["rank"], 1)
        self.assertGreater(out[0]["score"], out[1]["score"])

    def test_value_inversion_cheaper_wins(self):
        # Lower P/S vs its median = cheaper = higher value lens.
        rows = facts(
            {"ticker": "CHEAP", "ps": 4, "ps_median_12m": 8, "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1},
            {"ticker": "RICH", "ps": 12, "ps_median_12m": 8, "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1},
        )
        cfg = {"weights": {"quality": 0, "value": 100, "momentum": 0}}
        out = screen.score_screen(rows, cfg)
        self.assertEqual(out[0]["ticker"], "CHEAP")

    def test_momentum_collar(self):
        # A huge winner caps at +40, a crash floors at −50 — both rank by collar.
        rows = facts(
            {"ticker": "MOON", "perf_52w_vs_spy": 500, "rule_of_40": 1, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
            {"ticker": "KNIFE", "perf_52w_vs_spy": -90, "rule_of_40": 1, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
        )
        cfg = {"weights": {"quality": 0, "value": 0, "momentum": 100}}
        out = screen.score_screen(rows, cfg)
        self.assertEqual(out[0]["ticker"], "MOON")
        self.assertEqual(out[1]["ticker"], "KNIFE")

    def test_uncarded_adj_zero_and_ranks_on_base(self):
        # An uncarded name has adj_z exactly 0 and ranks on base_z alone
        # (final_pct == base_pct). Acceptance criterion (brief §10).
        rows = facts(
            {"ticker": "NOCARD", "rule_of_40": 50, "fcf_margin": 10, "gross_margin": 60, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}}, UNIT_STATS)
        self.assertEqual(out[0]["adj_z"], 0.0)
        self.assertEqual(out[0]["final_pct"], out[0]["base_pct"])
        self.assertAlmostEqual(out[0]["score"], out[0]["base_z"], places=9)

    def test_growth_durability_never_moves_score(self):
        # Two identical carded names differing ONLY in growth_score must score
        # identically — growth is read-only, already captured by R40 (brief §10).
        rows = facts(
            {"ticker": "G3", "rule_of_40": 40, "fcf_margin": 10, "gross_margin": 50, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0, **carded(moat_score=4, earnings_score=4, growth_score=1)},
            {"ticker": "G5", "rule_of_40": 40, "fcf_margin": 10, "gross_margin": 50, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0, **carded(moat_score=4, earnings_score=4, growth_score=5)},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}}, UNIT_STATS)
        g3 = next(r for r in out if r["ticker"] == "G3")
        g5 = next(r for r in out if r["ticker"] == "G5")
        self.assertAlmostEqual(g3["score"], g5["score"], places=12)
        self.assertAlmostEqual(g3["adj_z"], g5["adj_z"], places=12)

    def test_strong_card_lift_bounded_at_budget(self):
        # moat=5, earn=5, no breaks → adj_z hits the natural +budget ceiling and
        # the `capped` flag is set; a no-quant base keeps base_z=0 so the lift is
        # exactly the budget.
        rows = facts({"ticker": "STRONG", **carded(moat_score=5, earnings_score=5, break_count=0)})
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}}, UNIT_STATS)
        self.assertAlmostEqual(out[0]["adj_z"], screen.BUDGET, places=9)
        self.assertTrue(out[0]["capped"])
        self.assertFalse(out[0]["floored"])

    def test_weak_moat_with_breaks_demotes_and_floors(self):
        # moat=1, earn=1, 3 break signals → adj_z below FLOOR → clamped to FLOOR.
        rows = facts({"ticker": "WEAK", **carded(moat_score=1, earnings_score=1, break_count=3)})
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}}, UNIT_STATS)
        self.assertEqual(out[0]["adj_z"], screen.FLOOR)
        self.assertTrue(out[0]["floored"])

    def test_break_signal_additive_penalty(self):
        # One break signal subtracts budget·K_BREAK from adj_z (additive — not a
        # hard cap; decision 3). Neutral 3/3 card → adj_z = −budget·K_BREAK.
        rows = facts({"ticker": "BRK", **carded(moat_score=3, earnings_score=3, break_count=1)})
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}}, UNIT_STATS)
        self.assertAlmostEqual(out[0]["adj_z"], -screen.BUDGET * 0.5, places=9)

    def test_carded_lift_beats_uncarded_same_base(self):
        # A low-base strong-card name lifts above a same-base uncarded name.
        rows = facts(
            {"ticker": "LIFT", "rule_of_40": 0, "fcf_margin": 0, "gross_margin": 0, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0, **carded(moat_score=5, earnings_score=5, break_count=0)},
            {"ticker": "FLAT", "rule_of_40": 0, "fcf_margin": 0, "gross_margin": 0, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}}, UNIT_STATS)
        self.assertEqual(out[0]["ticker"], "LIFT")
        self.assertGreater(out[0]["score"], out[1]["score"])

    def test_winsor_clips_outlier_z(self):
        # A huge raw quality value pins to +3σ (winsor), not an unbounded z.
        rows = facts(
            {"ticker": "OUT", "rule_of_40": 26000, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}}, UNIT_STATS)
        self.assertLessEqual(out[0]["quality_z"], 3.0 + 1e-9)
        self.assertLessEqual(out[0]["base_z"], 3.0 + 1e-9)

    def test_final_pct_is_normal_cdf_percentile(self):
        # A row with no scoreable lens (all inputs null) → every zL = 0 →
        # base_z = 0 → Φ(0) = 0.5 → 50th percentile.
        rows = facts({"ticker": "MID"})
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}}, UNIT_STATS)
        self.assertEqual(out[0]["base_z"], 0.0)
        self.assertEqual(out[0]["final_pct"], 50)

    def test_ticker_tiebreak_ascending_on_score_desc(self):
        rows = facts(
            {"ticker": "ZZZ", "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "AAA", "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}}, UNIT_STATS)
        # equal scores → AAA before ZZZ
        self.assertEqual([r["ticker"] for r in out], ["AAA", "ZZZ"])

    def test_zero_ps_without_median_does_not_crash(self):
        rows = facts(
            {"ticker": "ZERO", "ps": 0, "ps_median_12m": None, "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "perf_52w_vs_spy": 1},
            {"ticker": "NORM", "ps": 5, "ps_median_12m": 4, "rule_of_40": 20, "fcf_margin": 1, "gross_margin": 1, "perf_52w_vs_spy": 1},
        )
        cfg = {"weights": {"quality": 45, "value": 25, "momentum": 20}}
        out = screen.score_screen(rows, cfg)
        self.assertEqual(len(out), 2)

    def test_topn_helper_via_run(self):
        rows = facts(
            {"ticker": "A", "rule_of_40": 90, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "B", "rule_of_40": 50, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "C", "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "topN": 2}
        ranked = screen.score_screen(rows, cfg)
        top2 = [r["ticker"] for r in ranked[: cfg["topN"]]]
        self.assertEqual(top2, ["A", "B"])

    def test_materialized_stats_used_when_passed(self):
        # The same row scores differently against different materialized moments
        # (the stats are read, not recomputed from the candidate set).
        rows = facts({"ticker": "X", "rule_of_40": 100, "fcf_margin": 0, "gross_margin": 0, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0})
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}}
        lo = {**UNIT_STATS, "quality": {"mu": 0.0, "sigma": 1.0, "n": 100}}
        hi = {**UNIT_STATS, "quality": {"mu": 0.0, "sigma": 1000.0, "n": 100}}
        out_lo = screen.score_screen(rows, cfg, lo)
        out_hi = screen.score_screen(rows, cfg, hi)
        # bigger σ → smaller z → lower base_z
        self.assertGreater(out_lo[0]["base_z"], out_hi[0]["base_z"])


class _FakeDB:
    """Minimal stub for portfolio_screen_candidates: serves one screen_config
    and a fixed active-rejection set."""

    def __init__(self, config: dict, rejected: set[str]):
        self._config = config
        self._rejected = rejected

    # screen.portfolio_screen_config reads via the supabase client; patch the
    # module helper instead (see tests below). This stub only needs the
    # rejection accessor that screen.portfolio_screen_candidates calls.
    def get_active_screener_rejections(self, portfolio_id):
        return set(self._rejected)


class TestRejectionFilter(unittest.TestCase):
    """Migration 051: portfolio_screen_candidates drops the portfolio's active
    rejections when hideRejected is on (default), and keeps them when off."""

    def _ranked(self):
        return facts(
            {"ticker": "A", "rule_of_40": 90, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
            {"ticker": "B", "rule_of_40": 50, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
            {"ticker": "C", "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5},
        )

    def _run(self, config, rejected):
        # Patch the two screen.py reads so the test is pure (no DB/RPC).
        orig_cfg = screen.portfolio_screen_config
        orig_run = screen.run_screen
        ranked = self._ranked()
        screen.portfolio_screen_config = lambda db, pid: config
        screen.run_screen = lambda db, cfg: screen.score_screen(ranked, cfg)
        try:
            return screen.portfolio_screen_candidates(_FakeDB(config, rejected), "pid")
        finally:
            screen.portfolio_screen_config = orig_cfg
            screen.run_screen = orig_run

    def test_hide_rejected_default_on_drops_rejected(self):
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False, "topN": 40}
        out = self._run(cfg, {"A"})
        self.assertNotIn("A", out)
        self.assertIn("B", out)
        self.assertIn("C", out)

    def test_hide_rejected_off_keeps_rejected(self):
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False, "topN": 40, "hideRejected": False}
        out = self._run(cfg, {"A"})
        self.assertIn("A", out)

    def test_no_rejections_is_noop(self):
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False, "topN": 40}
        out = self._run(cfg, set())
        self.assertEqual(set(out), {"A", "B", "C"})

    def test_candidate_rows_return_fact_dicts_and_respect_rejections(self):
        # The buyer sources evaluation data from these rows (Level 0 facts),
        # so they must be the full fact dicts and honour the rejection hide.
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False, "topN": 40}
        orig_cfg, orig_run = screen.portfolio_screen_config, screen.run_screen
        ranked = self._ranked()
        screen.portfolio_screen_config = lambda db, pid: cfg
        screen.run_screen = lambda db, c: screen.score_screen(ranked, c)
        try:
            rows = screen.portfolio_screen_candidate_rows(_FakeDB(cfg, {"A"}), "pid")
        finally:
            screen.portfolio_screen_config, screen.run_screen = orig_cfg, orig_run
        tickers = {r["ticker"] for r in rows}
        self.assertNotIn("A", tickers)            # rejected, hidden
        self.assertEqual(tickers, {"B", "C"})
        self.assertTrue(all("rule_of_40" in r and "score" in r for r in rows))  # full fact rows


if __name__ == "__main__":
    unittest.main(verbosity=2)
