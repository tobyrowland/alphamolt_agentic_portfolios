"""Unit tests for the turnaround facts (migration 074) computed at write time
by eodhd_updater: quarterly inflection streaks/deltas (compute_inflection) and
balance-sheet survivability (compute_survivability). Pure — no API, no DB."""

import unittest

from eodhd_updater import (
    INTEREST_COVERAGE_CAP,
    _improvement_streak,
    compute_inflection,
    compute_survivability,
)


def q(date, **fields):
    """One (date, entry) income-statement quarter, newest-first when listed."""
    return (date, fields)


DATES = ["2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30",
         "2025-03-31", "2024-12-31", "2024-09-30", "2024-06-30", "2024-03-31",
         "2023-12-31", "2023-09-30", "2023-06-30", "2023-03-31"]


class ImprovementStreakTests(unittest.TestCase):
    def test_counts_consecutive_improvements(self):
        self.assertEqual(_improvement_streak([5, 4, 3, 2]), 3)
        self.assertEqual(_improvement_streak([5, 4, 6, 2]), 1)
        self.assertEqual(_improvement_streak([3, 4, 5]), 0)

    def test_missing_leading_values_mean_unknown(self):
        self.assertIsNone(_improvement_streak([]))
        self.assertIsNone(_improvement_streak([5]))
        self.assertIsNone(_improvement_streak([None, 4, 3]))
        self.assertIsNone(_improvement_streak([5, None, 3]))

    def test_gap_mid_series_ends_streak(self):
        self.assertEqual(_improvement_streak([5, 4, None, 2]), 1)


class ComputeInflectionTests(unittest.TestCase):
    def _quarters(self, revs, gps=None, nis=None):
        gps = gps or [None] * len(revs)
        rows = []
        for i, rev in enumerate(revs):
            entry = {"totalRevenue": rev}
            if gps[i] is not None:
                entry["grossProfit"] = gps[i]
            rows.append((DATES[i], entry))
        return rows

    def test_two_quarters_of_gm_expansion(self):
        # GM 50% → 48% → 45% oldest-to-newest... listed newest-first:
        revs = [100, 100, 100, 100]
        gps = [50, 48, 45, 44]
        out = compute_inflection(self._quarters(revs, gps), [])
        self.assertEqual(out["gm_expansion_qtrs"], 3)
        self.assertAlmostEqual(out["gm_delta_qoq"], 2.0)
        self.assertEqual(out["inflection_signals"], 1)  # GM only; no FCF data

    def test_legacy_sequential_facts_still_computed(self):
        # The sequential family (074/075) stays populated for saved configs —
        # but with only 5 quarters the YoY basis can't be assessed, so it no
        # longer produces an inflection signal (migration 077).
        revs = [98, 100, 105.26, 116.96, 120]
        out = compute_inflection(self._quarters(revs), [])
        self.assertEqual(out["rev_accel_qtrs"], 2)
        self.assertGreater(out["rev_qoq_accel"], 0)
        self.assertIsNone(out["rev_yoy_accel_qtrs"])
        self.assertIsNone(out["inflection_signals"])

    def test_yoy_growth_ignores_seasonality(self):
        # A seasonal business (big Q4, weak Q1) with YoY quarterly growth
        # steadily accelerating: the sequential read whipsaws with the seasons,
        # the YoY read sees the clean acceleration — and the inflection signal
        # follows the YoY read (migration 077).
        base = [148.68, 143.84, 139.08, 134.4, 118, 116, 114, 112,
                100, 100, 100, 100]
        season = [1.3, 0.9, 1.0, 1.0]
        revs = [round(season[i % 4] * b, 4) for i, b in enumerate(base)]
        out = compute_inflection(self._quarters(revs), [])
        # YoY growth: 26% → 24% → 22% → 20% … (season cancels: same quarter
        # position a year apart shares the multiplier).
        self.assertAlmostEqual(out["rev_growth_yoy_q"], 26.0, places=1)
        self.assertAlmostEqual(out["rev_yoy_accel"], 2.0, places=1)
        self.assertEqual(out["rev_yoy_accel_qtrs"], 7)
        # The sequential read is seasonal noise (Q4 spike then Q1 drop).
        self.assertLessEqual(out["rev_accel_qtrs"], 1)
        self.assertEqual(out["inflection_signals"], 1)

    def test_fcf_matched_by_period_date(self):
        revs = [100, 100, 100, 100]
        quarterly = self._quarters(revs)
        # FCF margin improving toward breakeven: -5 → -10 → -20 (newest first).
        cf = [(DATES[0], {"freeCashFlow": -5}),
              (DATES[1], {"freeCashFlow": -10}),
              (DATES[2], {"freeCashFlow": -20})]
        out = compute_inflection(quarterly, cf)
        self.assertEqual(out["fcf_improving_qtrs"], 2)
        self.assertAlmostEqual(out["fcf_delta_qoq"], 5.0)
        self.assertEqual(out["inflection_signals"], 1)

    def test_no_data_yields_none_not_zero(self):
        out = compute_inflection([], [])
        self.assertIsNone(out["gm_expansion_qtrs"])
        self.assertIsNone(out["rev_accel_qtrs"])
        self.assertIsNone(out["fcf_improving_qtrs"])
        self.assertIsNone(out["inflection_signals"])
        self.assertIsNone(out["gm_delta_qoq"])

    def test_all_three_signals_count(self):
        # YoY quarterly growth accelerating (needs 6+ quarters so consecutive
        # YoY steps are assessable), GM expanding, FCF margin improving.
        revs = [148.68, 143.84, 139.08, 134.4, 118, 116, 114, 112,
                100, 100, 100, 100]
        gps = [round(r * (60 - i) / 100, 4) for i, r in enumerate(revs)]
        quarterly = self._quarters(revs, gps)
        cf = [(DATES[0], {"freeCashFlow": 14.9}),
              (DATES[1], {"freeCashFlow": 7.2}),
              (DATES[2], {"freeCashFlow": 1.4}),
              (DATES[3], {"freeCashFlow": -2.7})]
        out = compute_inflection(quarterly, cf)
        self.assertGreaterEqual(out["rev_yoy_accel_qtrs"], 2)
        self.assertGreaterEqual(out["gm_expansion_qtrs"], 2)
        self.assertGreaterEqual(out["fcf_improving_qtrs"], 2)
        self.assertEqual(out["inflection_signals"], 3)


class ComputeSurvivabilityTests(unittest.TestCase):
    def _raw(self, bs=None, shares_stats=None):
        raw = {"Financials": {}}
        if bs is not None:
            raw["Financials"]["Balance_Sheet"] = {"quarterly": bs}
        if shares_stats is not None:
            raw["SharesStats"] = shares_stats
        return raw

    def _quarters(self, ebitda, oi, interest):
        return [
            (DATES[i], {"ebitda": ebitda[i], "operatingIncome": oi[i],
                        "interestExpense": interest[i]})
            for i in range(4)
        ]

    def test_net_debt_ebitda_and_coverage(self):
        bs = {DATES[0]: {"cashAndShortTermInvestments": 200,
                         "shortLongTermDebtTotal": 500,
                         "commonStockSharesOutstanding": 1000}}
        quarterly = self._quarters([50, 50, 50, 50], [40, 40, 40, 40],
                                   [10, 10, 10, 10])
        out = compute_survivability(self._raw(bs), quarterly)
        self.assertEqual(out["cash"], 200)
        self.assertEqual(out["debt"], 500)
        self.assertEqual(out["shares_out"], 1000)
        self.assertEqual(out["ebitda_ttm"], 200)
        self.assertAlmostEqual(out["net_debt_ebitda"], 1.5)   # (500-200)/200
        self.assertAlmostEqual(out["interest_coverage"], 4.0)  # 160/40

    def test_negative_ebitda_yields_null_ratio(self):
        bs = {DATES[0]: {"cashAndShortTermInvestments": 100,
                         "shortLongTermDebtTotal": 300}}
        quarterly = self._quarters([-20, -20, -20, -20], [-25, -25, -25, -25],
                                   [5, 5, 5, 5])
        out = compute_survivability(self._raw(bs), quarterly)
        self.assertIsNone(out["net_debt_ebitda"])

    def test_debt_free_profitable_gets_coverage_cap(self):
        # No interest line at all + profitable ⇒ effectively infinite coverage,
        # stored as the cap so a ≥-filter still passes the safest names.
        bs = {DATES[0]: {"cashAndShortTermInvestments": 400,
                         "shortLongTermDebtTotal": 0}}
        quarterly = self._quarters([30, 30, 30, 30], [25, 25, 25, 25],
                                   [None, None, None, None])
        out = compute_survivability(self._raw(bs), quarterly)
        self.assertEqual(out["interest_coverage"], INTEREST_COVERAGE_CAP)
        self.assertLess(out["net_debt_ebitda"], 0)  # net cash

    def test_netdebt_field_used_directly_when_present(self):
        bs = {DATES[0]: {"netDebt": 120}}
        quarterly = self._quarters([40, 40, 40, 40], [30, 30, 30, 30],
                                   [2, 2, 2, 2])
        out = compute_survivability(self._raw(bs), quarterly)
        self.assertAlmostEqual(out["net_debt_ebitda"], 0.75)  # 120/160

    def test_partial_ttm_is_refused(self):
        # Fewer than 4 EBITDA quarters ⇒ no TTM, no ratio (never a partial sum).
        bs = {DATES[0]: {"netDebt": 100}}
        quarterly = self._quarters([50, None, 50, 50], [40, 40, 40, 40],
                                   [10, 10, 10, 10])
        out = compute_survivability(self._raw(bs), quarterly)
        self.assertIsNone(out["ebitda_ttm"])
        self.assertIsNone(out["net_debt_ebitda"])

    def test_no_balance_sheet_is_all_none(self):
        out = compute_survivability(self._raw(), [])
        self.assertIsNone(out["cash"])
        self.assertIsNone(out["net_debt_ebitda"])
        self.assertIsNone(out["interest_coverage"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
