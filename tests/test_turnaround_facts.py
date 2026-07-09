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
         "2025-03-31", "2024-12-31", "2024-09-30", "2024-06-30", "2024-03-31"]


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

    def test_qoq_growth_improving_while_still_shrinking(self):
        # Revenue still down YoY but the QoQ decline is easing: the classic
        # turnaround shape. QoQ growth series: -2%, -5%, -10% (newest first).
        revs = [98, 100, 105.26, 116.96, 120]
        out = compute_inflection(self._quarters(revs), [])
        self.assertEqual(out["rev_accel_qtrs"], 2)
        self.assertGreater(out["rev_qoq_accel"], 0)
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
        revs = [130, 115, 105, 100, 98]   # QoQ growth accelerating
        gps = [78, 63, 52, 48, 47]        # GM expanding every quarter
        quarterly = self._quarters(revs, gps)
        cf = [(DATES[0], {"freeCashFlow": 13}),
              (DATES[1], {"freeCashFlow": 5.75}),
              (DATES[2], {"freeCashFlow": 1.05}),
              (DATES[3], {"freeCashFlow": -2})]
        out = compute_inflection(quarterly, cf)
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
