#!/usr/bin/env python3
"""Unit tests for the deterministic screener scoring (screen.py).

Pure-logic tests (no DB): filters, empirical-percentile components, the
value inversion, the momentum collar, the AI multiplier, weighting and
ranking. Mirrors the cases in web/lib/screen/score.ts so the Python buyer
and the website agree. Run: pytest tests/test_screen.py
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
        "ps_median_12m": None, "ps_trend_pct": None,
        "ret_52w": None, "perf_52w_vs_spy": None,
        # Turnaround facts (migrations 074/075).
        "drawdown_52w": None, "above_low_26w": None, "ps_vs_median": None,
        "rev_growth_qoq": None,
        "gm_delta_qoq": None, "gm_expansion_qtrs": None,
        "rev_qoq_accel": None, "rev_accel_qtrs": None,
        "fcf_delta_qoq": None, "fcf_improving_qtrs": None,
        "inflection_signals": None, "net_debt_ebitda": None,
        "interest_coverage": None,
        "bull": None, "bear": None, "quality_score": None,
        # Graded bull/bear (migration 066). Both None ⇒ verdict_z = 0.
        "bull_score": None, "bear_score": None,
        # Research-card scalars (migration 057). has_card False ⇒ adj_z = 0.
        "moat_score": None, "earnings_score": None, "growth_score": None,
        "break_count": None, "has_card": False,
        "industry_ps_median": None, "sector_ps_median": None,
        "peer_ps_median": None, "peer_basis": None,
    }
    return [{**base, **r} for r in rows]


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

    def test_industry_exclude_case_insensitive(self):
        # Industry is a filterable text field (exclude miners by industry).
        rows = facts(
            {"ticker": "MINER", "sector": "Non-Energy Minerals", "industry": "Precious Metals"},
            {"ticker": "SAAS", "sector": "Technology Services", "industry": "Packaged Software"},
        )
        out = screen.apply_filters(
            rows, [{"field": "industry", "op": "!=", "value": "precious metals"}]
        )
        self.assertEqual([r["ticker"] for r in out], ["SAAS"])

    def test_industry_multi_exclude_stacks(self):
        rows = facts(
            {"ticker": "GOLD", "industry": "Precious Metals"},
            {"ticker": "COPPER", "industry": "Other Metals/Minerals"},
            {"ticker": "SAAS", "industry": "Packaged Software"},
        )
        out = screen.apply_filters(rows, [
            {"field": "industry", "op": "!=", "value": "Precious Metals"},
            {"field": "industry", "op": "!=", "value": "Other Metals/Minerals"},
        ])
        self.assertEqual([r["ticker"] for r in out], ["SAAS"])


class TestPercentiles(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(screen._percentiles([1, 2, 3, 4]), [0.25, 0.5, 0.75, 1.0])

    def test_nulls_preserved(self):
        self.assertEqual(screen._percentiles([None, 5]), [None, 1.0])

    def test_all_null(self):
        self.assertEqual(screen._percentiles([None, None]), [None, None])


class TestScore(unittest.TestCase):
    """Percentile-base + AI adj_z (post-refactor): base_z = probit(weighted blend
    of per-lens empirical percentiles over the universe); final_z = base_z +
    adj_z; ranked on final_z. The Quality lens uses a growth-capped R40."""

    def test_quality_winner_ranks_first(self):
        rows = facts(
            {"ticker": "HI", "rule_of_40": 80, "rev_growth_ttm": 20, "net_margin": 20, "fcf_margin": 40, "gross_margin": 90, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "LO", "rule_of_40": 5, "rev_growth_ttm": 2, "net_margin": -5, "fcf_margin": -10, "gross_margin": 20, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}})
        self.assertEqual(out[0]["ticker"], "HI")
        self.assertGreater(out[0]["score"], out[1]["score"])

    def test_value_inversion_cheaper_wins(self):
        rows = facts(
            {"ticker": "CHEAP", "ps": 4, "ps_median_12m": 8},
            {"ticker": "RICH", "ps": 12, "ps_median_12m": 8},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 0, "value": 100, "momentum": 0}})
        self.assertEqual(out[0]["ticker"], "CHEAP")

    def test_value_peer_relative_breaks_self_tie(self):
        # Two names identically priced vs their OWN history (ps == median) tie on
        # the self-relative read; the peer-group median (migration 058) breaks
        # the tie — the one cheap vs its peers wins.
        rows = facts(
            {"ticker": "PEERCHEAP", "ps": 6, "ps_median_12m": 6, "peer_ps_median": 12},
            {"ticker": "PEERRICH", "ps": 6, "ps_median_12m": 6, "peer_ps_median": 3},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 0, "value": 100, "momentum": 0}})
        self.assertEqual(out[0]["ticker"], "PEERCHEAP")

    def test_value_missing_peer_falls_back_to_self(self):
        # No peer median ⇒ pure self-relative (no crash, lens still scoreable).
        rows = facts(
            {"ticker": "CHEAP", "ps": 4, "ps_median_12m": 8, "peer_ps_median": None},
            {"ticker": "RICH", "ps": 12, "ps_median_12m": 8, "peer_ps_median": None},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 0, "value": 100, "momentum": 0}})
        self.assertEqual(out[0]["ticker"], "CHEAP")

    def test_momentum_collar(self):
        rows = facts(
            {"ticker": "MOON", "perf_52w_vs_spy": 500},
            {"ticker": "KNIFE", "perf_52w_vs_spy": -90},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 0, "value": 0, "momentum": 100}})
        self.assertEqual(out[0]["ticker"], "MOON")
        self.assertEqual(out[1]["ticker"], "KNIFE")

    def test_growth_cap_sinks_micro_revenue_outlier(self):
        # The headline fix: a micro-revenue name with absurd YoY growth (R40 in
        # the hundreds of thousands) must NOT top Quality. The +100% growth cap
        # turns its R40 sharply negative, so a real compounder outranks it.
        rows = facts(
            {"ticker": "JUNK", "rule_of_40": 382820, "rev_growth_ttm": 383000, "net_margin": -180, "fcf_margin": -150, "gross_margin": -10, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "REAL", "rule_of_40": 45, "rev_growth_ttm": 30, "net_margin": 15, "fcf_margin": 20, "gross_margin": 60, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}})
        self.assertEqual(out[0]["ticker"], "REAL")
        self.assertGreater(out[0]["quality_pct"], out[1]["quality_pct"])

    def test_uncarded_adj_zero_ranks_on_base(self):
        rows = facts({"ticker": "NOCARD", "rule_of_40": 50, "rev_growth_ttm": 20, "net_margin": 15, "fcf_margin": 10, "gross_margin": 60, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0})
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}})
        self.assertEqual(out[0]["adj_z"], 0.0)
        self.assertAlmostEqual(out[0]["score"], out[0]["base_z"], places=9)
        self.assertLessEqual(abs(out[0]["final_pct"] - out[0]["base_pct"]), 1)

    def test_growth_durability_never_moves_score(self):
        rows = facts(
            {"ticker": "G1", "rule_of_40": 40, "rev_growth_ttm": 20, "net_margin": 20, "fcf_margin": 10, "gross_margin": 50, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0, **carded(moat_score=4, earnings_score=4, growth_score=1)},
            {"ticker": "G5", "rule_of_40": 40, "rev_growth_ttm": 20, "net_margin": 20, "fcf_margin": 10, "gross_margin": 50, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0, **carded(moat_score=4, earnings_score=4, growth_score=5)},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}})
        g1 = next(r for r in out if r["ticker"] == "G1")
        g5 = next(r for r in out if r["ticker"] == "G5")
        self.assertAlmostEqual(g1["adj_z"], g5["adj_z"], places=12)
        self.assertAlmostEqual(g1["score"], g5["score"], places=12)

    def test_strong_card_lift_capped_at_budget(self):
        # No quant inputs → every lens percentile is the neutral 0.5 → base_z ≈ 0,
        # so the +0.7σ AI lift is isolated. moat 5 + earn 5 → adj_z = +budget, capped.
        rows = facts({"ticker": "STRONG", **carded(moat_score=5, earnings_score=5, break_count=0)})
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}})
        self.assertAlmostEqual(out[0]["base_z"], 0.0, places=6)
        self.assertAlmostEqual(out[0]["adj_z"], screen.BUDGET, places=9)
        self.assertTrue(out[0]["capped"])

    def test_strong_card_with_breaks_still_caps(self):
        rows = facts({"ticker": "S", **carded(moat_score=5, earnings_score=5, break_count=4)})
        out = screen.score_screen(rows, {"weights": {"quality": 60, "value": 25, "momentum": 15}})
        self.assertAlmostEqual(out[0]["adj_z"], screen.BUDGET, places=9)
        self.assertTrue(out[0]["capped"])

    def test_break_signals_do_not_affect_score(self):
        rows = facts(
            {"ticker": "BRK", **carded(moat_score=3, earnings_score=3, break_count=3)},
            {"ticker": "NOBRK", **carded(moat_score=3, earnings_score=3, break_count=0)},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}})
        brk = next(r for r in out if r["ticker"] == "BRK")
        nob = next(r for r in out if r["ticker"] == "NOBRK")
        self.assertAlmostEqual(brk["adj_z"], 0.0, places=9)
        self.assertAlmostEqual(brk["adj_z"], nob["adj_z"], places=12)

    def test_base_disperses_across_universe(self):
        # Percentile→probit gives base_z a full ~N(0,1) spread (the fix for the
        # compressed-base / AI-dominance problem): top vs bottom span ~±3σ.
        rows = facts(*[
            {"ticker": f"T{i}", "rule_of_40": i, "rev_growth_ttm": i, "net_margin": 0,
             "fcf_margin": i, "gross_margin": i, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": i}
            for i in range(1, 101)
        ])
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}})
        bz = [r["base_z"] for r in out]
        self.assertGreater(max(bz), 1.5)
        self.assertLess(min(bz), -1.5)

    def test_firing_breaks_only_counts_currently_true_signals(self):
        def card(*signals):
            return {"has_card": True, "moat_score": 4, "earnings_score": 4,
                    "research_card": {"break_signals": list(signals)}}
        rows = facts(
            {"ticker": "CLEAN", "gross_margin": 63.5, "rev_growth_ttm": 30.6, "operating_margin": 42.8,
             **card({"field": "gross_margin_pct", "op": "<", "value": 60},
                    {"field": "operating_margin_pct", "op": "<", "value": 38})},
            {"ticker": "FIRING", "gross_margin": 40, "rev_growth_ttm": 30,
             **card({"field": "gross_margin_pct", "op": "<", "value": 60})},
            {"ticker": "CHANGEPCT", "rev_growth_ttm": 30,
             **card({"field": "rev_growth_ttm_pct", "op": "change_pct_lt", "value": -5})},
            {"ticker": "UNMAPPED", "gross_margin": 10,
             **card({"field": "eps_yoy_pct", "op": "<", "value": 0})},
        )
        out = {r["ticker"]: r for r in screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}})}
        self.assertEqual(out["CLEAN"]["firing_breaks"], 0)
        self.assertEqual(out["FIRING"]["firing_breaks"], 1)
        self.assertEqual(out["CHANGEPCT"]["firing_breaks"], 0)
        self.assertEqual(out["UNMAPPED"]["firing_breaks"], 0)

    def test_ticker_tiebreak_ascending_on_score_desc(self):
        rows = facts(
            {"ticker": "ZZZ", "rule_of_40": 10, "rev_growth_ttm": 10, "net_margin": 0, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "AAA", "rule_of_40": 10, "rev_growth_ttm": 10, "net_margin": 0, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}})
        self.assertEqual([r["ticker"] for r in out], ["AAA", "ZZZ"])

    def test_zero_ps_without_median_does_not_crash(self):
        rows = facts(
            {"ticker": "ZERO", "ps": 0, "ps_median_12m": None, "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "perf_52w_vs_spy": 1},
            {"ticker": "NORM", "ps": 5, "ps_median_12m": 4, "rule_of_40": 20, "fcf_margin": 1, "gross_margin": 1, "perf_52w_vs_spy": 1},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 45, "value": 25, "momentum": 20}})
        self.assertEqual(len(out), 2)

    def test_topn_helper_via_run(self):
        rows = facts(
            {"ticker": "A", "rule_of_40": 90, "rev_growth_ttm": 90, "net_margin": 0, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "B", "rule_of_40": 50, "rev_growth_ttm": 50, "net_margin": 0, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
            {"ticker": "C", "rule_of_40": 10, "rev_growth_ttm": 10, "net_margin": 0, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "perf_52w_vs_spy": 0},
        )
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "topN": 2}
        ranked = screen.score_screen(rows, cfg)
        self.assertEqual([r["ticker"] for r in ranked[: cfg["topN"]]], ["A", "B"])


class TestFinancialNeutralisation(unittest.TestCase):
    """Financials (Finance / Financial Services / Real Estate): P/S and R40 are
    category errors, so the Quality + Value lenses are neutralised (→ None) and
    the name ranks on Momentum only."""

    def test_lens_values_neutralised_for_financial_sectors(self):
        for sector in ("Finance", "Financial Services", "Real Estate",
                       "financial services", " FINANCE "):
            xq, xv, xm, xi = screen._lens_values({
                "sector": sector, "rule_of_40": 99, "rev_growth_ttm": 80,
                "net_margin": 16, "fcf_margin": 47, "gross_margin": 50,
                "ps": 0.03, "ps_median_12m": 0.02, "peer_ps_median": 3.5,
                "perf_52w_vs_spy": 20, "gm_delta_qoq": 5, "rev_qoq_accel": 10,
            })
            self.assertIsNone(xq, sector)
            self.assertIsNone(xv, sector)
            self.assertIsNone(xi, sector)  # GM/FCF deltas: category error too
            self.assertEqual(xm, 20, sector)  # momentum survives

    def test_non_financial_sector_unchanged(self):
        xq, xv, xm, xi = screen._lens_values({
            "sector": "Technology Services", "rule_of_40": 50,
            "rev_growth_ttm": 30, "net_margin": 10, "fcf_margin": 20,
            "gross_margin": 80, "ps": 6, "ps_median_12m": 8,
            "perf_52w_vs_spy": 12, "gm_delta_qoq": 2,
        })
        self.assertIsNotNone(xq)
        self.assertIsNotNone(xv)
        self.assertIsNotNone(xi)
        self.assertEqual(xm, 12)

    def test_financial_does_not_win_on_spurious_value_or_quality(self):
        # The bank has a screaming-cheap P/S vs peers AND a huge R40 — without
        # neutralisation it would top a value/quality screen. Neutralised, a
        # genuinely strong non-financial outranks it.
        rows = facts(
            {"ticker": "BANK", "sector": "Finance", "rule_of_40": 99,
             "rev_growth_ttm": 80, "net_margin": 16, "fcf_margin": 47,
             "ps": 0.03, "ps_median_12m": 0.02, "peer_ps_median": 3.5,
             "perf_52w_vs_spy": 0},
            {"ticker": "REAL", "sector": "Technology Services", "rule_of_40": 70,
             "rev_growth_ttm": 40, "net_margin": 30, "fcf_margin": 30,
             "gross_margin": 85, "ps": 4, "ps_median_12m": 8, "peer_ps_median": 8,
             "perf_52w_vs_spy": 0},
        )
        out = screen.score_screen(
            rows, {"weights": {"quality": 60, "value": 40, "momentum": 0}})
        self.assertEqual(out[0]["ticker"], "REAL")


class TestInflectionLens(unittest.TestCase):
    """Migration 074: the fourth lens — collared blend of the latest QoQ
    deltas (revenue-growth acceleration, GM change, FCF-margin change)."""

    def test_accelerating_name_wins_on_inflection_weight(self):
        rows = facts(
            {"ticker": "TURN", "rev_qoq_accel": 8, "gm_delta_qoq": 3, "fcf_delta_qoq": 2},
            {"ticker": "FADE", "rev_qoq_accel": -6, "gm_delta_qoq": -2, "fcf_delta_qoq": -1},
        )
        out = screen.score_screen(
            rows, {"weights": {"quality": 0, "value": 0, "momentum": 0, "inflection": 100}})
        self.assertEqual(out[0]["ticker"], "TURN")
        self.assertGreater(out[0]["inflection_pct"], out[1]["inflection_pct"])

    def test_missing_inflection_facts_rank_neutral(self):
        # A name with no QoQ facts yet (fundamentals rotation pending) sits at
        # the neutral 0.5 percentile — between improvers and a clear decliner.
        rows = facts(
            {"ticker": "TURN", "rev_qoq_accel": 8, "gm_delta_qoq": 3},
            {"ticker": "MILD", "rev_qoq_accel": 1},
            {"ticker": "NODATA"},
            {"ticker": "FADE", "rev_qoq_accel": -6, "gm_delta_qoq": -2},
        )
        out = screen.score_screen(
            rows, {"weights": {"quality": 0, "value": 0, "momentum": 0, "inflection": 100}})
        self.assertEqual([r["ticker"] for r in out], ["TURN", "MILD", "NODATA", "FADE"])
        self.assertEqual(next(r for r in out if r["ticker"] == "NODATA")["inflection_pct"], 50)

    def test_collar_tames_micro_denominator_acceleration(self):
        # A tiny-revenue name posting +500pp QoQ acceleration must not dwarf a
        # genuine broad-based improver: the rev component collars at ±30pp.
        rows = facts(
            {"ticker": "JUNK", "rev_qoq_accel": 500, "gm_delta_qoq": -15, "fcf_delta_qoq": -10},
            {"ticker": "REAL", "rev_qoq_accel": 25, "gm_delta_qoq": 4, "fcf_delta_qoq": 3},
        )
        out = screen.score_screen(
            rows, {"weights": {"quality": 0, "value": 0, "momentum": 0, "inflection": 100}})
        self.assertEqual(out[0]["ticker"], "REAL")

    def test_zero_inflection_weight_is_backwards_compatible(self):
        # A config predating the lens (no inflection key) must rank identically
        # even when the facts now carry inflection data.
        rows = facts(
            {"ticker": "A", "rule_of_40": 90, "rev_growth_ttm": 20, "net_margin": 10,
             "fcf_margin": 10, "gross_margin": 60, "ps": 5, "ps_median_12m": 5,
             "rev_qoq_accel": -30, "gm_delta_qoq": -10},
            {"ticker": "B", "rule_of_40": 30, "rev_growth_ttm": 5, "net_margin": 0,
             "fcf_margin": 2, "gross_margin": 30, "ps": 5, "ps_median_12m": 5,
             "rev_qoq_accel": 30, "gm_delta_qoq": 10},
        )
        legacy = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}})
        explicit = screen.score_screen(
            rows, {"weights": {"quality": 100, "value": 0, "momentum": 0, "inflection": 0}})
        self.assertEqual([r["ticker"] for r in legacy], [r["ticker"] for r in explicit])
        for lr, er in zip(legacy, explicit):
            self.assertAlmostEqual(lr["score"], er["score"], places=12)


class TestTurnaroundFilters(unittest.TestCase):
    """Migration 074: washout + survivability fields are plain filters."""

    def test_drawdown_band(self):
        rows = facts(
            {"ticker": "SHALLOW", "drawdown_52w": 20},
            {"ticker": "WASHOUT", "drawdown_52w": 55},
            {"ticker": "KNIFED", "drawdown_52w": 85},
        )
        out = screen.apply_filters(rows, [
            {"field": "drawdown_52w", "op": ">=", "value": 40},
            {"field": "drawdown_52w", "op": "<=", "value": 70},
        ])
        self.assertEqual([r["ticker"] for r in out], ["WASHOUT"])

    def test_above_low_and_ps_vs_median(self):
        rows = facts(
            {"ticker": "BASING", "above_low_26w": 15, "ps_vs_median": -30},
            {"ticker": "ATLOW", "above_low_26w": 2, "ps_vs_median": -30},
            {"ticker": "RICH", "above_low_26w": 15, "ps_vs_median": 20},
        )
        out = screen.apply_filters(rows, [
            {"field": "above_low_26w", "op": ">=", "value": 10},
            {"field": "ps_vs_median", "op": "<=", "value": 0},
        ])
        self.assertEqual([r["ticker"] for r in out], ["BASING"])

    def test_survivability_filters_exclude_missing(self):
        # Hard-gate semantics: a numeric filter excludes names missing the
        # datum (same rule as every other numeric filter).
        rows = facts(
            {"ticker": "SAFE", "net_debt_ebitda": 1.2, "interest_coverage": 8},
            {"ticker": "LEVERED", "net_debt_ebitda": 5.5, "interest_coverage": 1.1},
            {"ticker": "UNKNOWN"},
        )
        out = screen.apply_filters(rows, [
            {"field": "net_debt_ebitda", "op": "<=", "value": 3},
            {"field": "interest_coverage", "op": ">=", "value": 2},
        ])
        self.assertEqual([r["ticker"] for r in out], ["SAFE"])

    def test_inflection_signals_filter(self):
        rows = facts(
            {"ticker": "INFLECTING", "inflection_signals": 2},
            {"ticker": "FLAT", "inflection_signals": 0},
        )
        out = screen.apply_filters(
            rows, [{"field": "inflection_signals", "op": ">=", "value": 1}])
        self.assertEqual([r["ticker"] for r in out], ["INFLECTING"])

    def test_qoq_growth_filters(self):
        # Migration 075: raw QoQ growth + its derivatives are plain filters —
        # "QoQ growth ≥ 5% and improving for 2 straight quarters".
        rows = facts(
            {"ticker": "COMPOUNDING", "rev_growth_qoq": 8, "rev_accel_qtrs": 3},
            {"ticker": "ONEOFF", "rev_growth_qoq": 12, "rev_accel_qtrs": 1},
            {"ticker": "SHRINKING", "rev_growth_qoq": -4, "rev_accel_qtrs": 2},
        )
        out = screen.apply_filters(rows, [
            {"field": "rev_growth_qoq", "op": ">=", "value": 5},
            {"field": "rev_accel_qtrs", "op": ">=", "value": 2},
        ])
        self.assertEqual([r["ticker"] for r in out], ["COMPOUNDING"])


class TestAiBudget(unittest.TestCase):
    """Migration 074: per-screen AI authority — config['aiBudget'] scales the
    research-card adjustment; default stays the classic BUDGET."""

    def _rows(self):
        return facts({"ticker": "STRONG", **carded(moat_score=5, earnings_score=5)})

    def test_default_budget_unchanged(self):
        out = screen.score_screen(self._rows(), {"weights": {"quality": 100, "value": 0, "momentum": 0}})
        self.assertAlmostEqual(out[0]["adj_z"], screen.BUDGET, places=9)

    def test_heavier_budget_scales_adj(self):
        out = screen.score_screen(
            self._rows(),
            {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiBudget": 1.2})
        self.assertAlmostEqual(out[0]["adj_z"], 1.2, places=9)
        self.assertTrue(out[0]["capped"])

    def test_budget_clamped_to_max(self):
        out = screen.score_screen(
            self._rows(),
            {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiBudget": 9})
        self.assertAlmostEqual(out[0]["adj_z"], screen.AI_BUDGET_MAX, places=9)

    def test_zero_budget_silences_the_card(self):
        out = screen.score_screen(
            self._rows(),
            {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiBudget": 0})
        self.assertEqual(out[0]["adj_z"], 0.0)


class TestVerdictZ(unittest.TestCase):
    """Graded bull/bear tilt (migration 066): final_z += verdict_z."""

    def test_neutral_when_either_missing(self):
        self.assertEqual(screen._verdict_z({"bull_score": 5})["verdict_z"], 0.0)
        self.assertEqual(screen._verdict_z({"bear_score": 1})["verdict_z"], 0.0)
        self.assertEqual(screen._verdict_z({})["verdict_z"], 0.0)

    def test_neutral_at_three_three(self):
        self.assertEqual(
            screen._verdict_z({"bull_score": 3, "bear_score": 3})["verdict_z"], 0.0)

    def test_max_positive_strong_bull_weak_bear(self):
        # bull=5 (u=+1), bear=1 (u=-1) → +budget.
        v = screen._verdict_z({"bull_score": 5, "bear_score": 1})
        self.assertAlmostEqual(v["verdict_z"], screen.VERDICT_BUDGET, places=12)

    def test_max_negative_weak_bull_strong_bear(self):
        v = screen._verdict_z({"bull_score": 1, "bear_score": 5})
        self.assertAlmostEqual(v["verdict_z"], -screen.VERDICT_BUDGET, places=12)

    def test_monotonic_in_each_input(self):
        lo = screen._verdict_z({"bull_score": 2, "bear_score": 3})["verdict_z"]
        hi = screen._verdict_z({"bull_score": 4, "bear_score": 3})["verdict_z"]
        self.assertGreater(hi, lo)                      # higher bull → higher
        safe = screen._verdict_z({"bull_score": 3, "bear_score": 1})["verdict_z"]
        risky = screen._verdict_z({"bull_score": 3, "bear_score": 5})["verdict_z"]
        self.assertGreater(safe, risky)                 # higher bear → lower

    def test_verdict_tilts_the_rank(self):
        # Identical base/card; only bull/bear differ → the strong-verdict name wins.
        rows = facts(
            {"ticker": "STRONG", "rule_of_40": 40, "rev_growth_ttm": 20,
             "net_margin": 20, "fcf_margin": 10, "gross_margin": 50, "ps": 5,
             "ps_median_12m": 5, "perf_52w_vs_spy": 0,
             "bull_score": 5, "bear_score": 1},
            {"ticker": "WEAK", "rule_of_40": 40, "rev_growth_ttm": 20,
             "net_margin": 20, "fcf_margin": 10, "gross_margin": 50, "ps": 5,
             "ps_median_12m": 5, "perf_52w_vs_spy": 0,
             "bull_score": 1, "bear_score": 5},
        )
        out = screen.score_screen(rows, {"weights": {"quality": 100, "value": 0, "momentum": 0}})
        self.assertEqual(out[0]["ticker"], "STRONG")
        self.assertAlmostEqual(out[0]["verdict_z"], screen.VERDICT_BUDGET, places=12)
        self.assertAlmostEqual(out[1]["verdict_z"], -screen.VERDICT_BUDGET, places=12)


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
        # Carded so the research-card buy gate (default on) keeps them — this
        # suite isolates the rejection filter, not the card gate.
        return facts(
            {"ticker": "A", "rule_of_40": 90, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "has_card": True},
            {"ticker": "B", "rule_of_40": 50, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "has_card": True},
            {"ticker": "C", "rule_of_40": 10, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "has_card": True},
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


class TestResearchCardGate(unittest.TestCase):
    """The buyer's candidate pool only includes AI-analysed (research-carded)
    names by default, so the portfolio never buys an un-analysed equity. The
    screener display is unaffected — this gates the buyer pool only."""

    def _ranked(self):
        # Mixed: A/C carded (buyable), B/D un-carded (ranked on quant only).
        return facts(
            {"ticker": "A", "rule_of_40": 90, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "has_card": True},
            {"ticker": "B", "rule_of_40": 70, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "has_card": False},
            {"ticker": "C", "rule_of_40": 50, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "has_card": True},
            {"ticker": "D", "rule_of_40": 30, "fcf_margin": 1, "gross_margin": 1, "ps": 5, "ps_median_12m": 5, "has_card": False},
        )

    def _run(self, cfg):
        orig_cfg, orig_run = screen.portfolio_screen_config, screen.run_screen
        ranked = self._ranked()
        screen.portfolio_screen_config = lambda db, pid: cfg
        screen.run_screen = lambda db, c: screen.score_screen(ranked, c)
        try:
            return screen.portfolio_screen_candidates(_FakeDB(cfg, set()), "pid")
        finally:
            screen.portfolio_screen_config, screen.run_screen = orig_cfg, orig_run

    def test_default_on_drops_uncarded_names(self):
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False, "topN": 40}
        out = self._run(cfg)
        self.assertEqual(set(out), {"A", "C"})  # B, D (un-carded) dropped

    def test_off_keeps_uncarded_names(self):
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False, "topN": 40, "requireResearchCard": False}
        out = self._run(cfg)
        self.assertEqual(set(out), {"A", "B", "C", "D"})

    def test_gate_applies_before_topn_slice(self):
        # topN=2 over the gated pool yields the top 2 CARDED names (A, C),
        # not the top-2-then-filter (which would have dropped to just A).
        cfg = {"weights": {"quality": 100, "value": 0, "momentum": 0}, "aiMultiplier": False, "topN": 2}
        out = self._run(cfg)
        self.assertEqual(set(out), {"A", "C"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
