#!/usr/bin/env python3
"""Unit tests for the 200-week average sniper core (ma_sniper.py).

Pure-logic tests of weekly resampling, the 200-week MA, and the price→
conviction mapping — plus the sniper_convictions wrapper against a tiny fake
db. No real DB, no LLM. Run: python test_ma_sniper.py
"""

from __future__ import annotations

import unittest
from datetime import date, timedelta

import ma_sniper as ms


def _daily_series(weeks: int, value: float, *, start: str = "2019-01-07") -> list[dict]:
    """A flat daily price series spanning `weeks` ISO weeks (Mon+Wed per week)."""
    d0 = date.fromisoformat(start)
    rows: list[dict] = []
    for w in range(weeks):
        monday = d0 + timedelta(weeks=w)
        for offset in (0, 2):  # two trading days per week
            rows.append(
                {"date": (monday + timedelta(days=offset)).isoformat(),
                 "adj_close": value, "close": value}
            )
    return rows


class TestWeeklyResample(unittest.TestCase):
    def test_one_close_per_iso_week_last_wins(self):
        rows = [
            {"date": "2024-01-01", "adj_close": 10.0},  # ISO 2024-W01 Mon
            {"date": "2024-01-03", "adj_close": 11.0},  # same week, later → wins
            {"date": "2024-01-08", "adj_close": 20.0},  # ISO 2024-W02
        ]
        self.assertEqual(ms.weekly_closes(rows), [11.0, 20.0])

    def test_adj_close_preferred_then_close(self):
        rows = [
            {"date": "2024-01-01", "adj_close": None, "close": 9.0},
            {"date": "2024-01-08", "adj_close": 12.0, "close": 99.0},
        ]
        self.assertEqual(ms.weekly_closes(rows), [9.0, 12.0])

    def test_bad_rows_skipped(self):
        rows = [
            {"date": "not-a-date", "adj_close": 5.0},
            {"date": "2024-01-01", "adj_close": 0},      # non-positive → skip
            {"date": "2024-01-02", "adj_close": -3.0},   # negative → skip
            {"date": "2024-01-03", "adj_close": 7.0},
        ]
        self.assertEqual(ms.weekly_closes(rows), [7.0])


class TestMovingAverage(unittest.TestCase):
    def test_none_when_too_short(self):
        rows = _daily_series(ms.MIN_WEEKS - 1, 50.0)
        self.assertIsNone(ms.two_hundred_week_ma(rows))

    def test_computes_when_long_enough(self):
        rows = _daily_series(ms.MIN_WEEKS, 50.0)
        self.assertAlmostEqual(ms.two_hundred_week_ma(rows), 50.0)

    def test_only_last_window_weeks_count(self):
        # 100 weeks at 10, then 200 weeks at 30 → MA over the last 200 is 30.
        rows = _daily_series(100, 10.0, start="2017-01-02")
        rows += _daily_series(200, 30.0, start="2019-01-07")
        ma = ms.two_hundred_week_ma(rows)
        self.assertAlmostEqual(ma, 30.0)


class TestConvictionMapping(unittest.TestCase):
    def test_above_band_waits(self):
        # 6% above MA with a 5% band → no conviction (the sniper waits).
        self.assertEqual(ms.sniper_conviction(106.0, 100.0, band=0.05), 0)

    def test_within_band_above_ma(self):
        self.assertEqual(ms.sniper_conviction(104.0, 100.0, band=0.05), 1)

    def test_at_or_below_ma_scales(self):
        self.assertEqual(ms.sniper_conviction(100.0, 100.0), 3)
        self.assertEqual(ms.sniper_conviction(94.0, 100.0), 4)   # ~6% below
        self.assertEqual(ms.sniper_conviction(85.0, 100.0), 5)   # deep discount

    def test_degenerate_inputs(self):
        self.assertEqual(ms.sniper_conviction(0.0, 100.0), 0)
        self.assertEqual(ms.sniper_conviction(100.0, 0.0), 0)


class _FakeDB:
    def __init__(self, series: dict[str, list[dict]]):
        self._series = series

    def get_prices_daily(self, ticker, since=None):
        return self._series.get(ticker, [])


class TestSniperConvictions(unittest.TestCase):
    def test_only_on_sale_quality_names_clear(self):
        db = _FakeDB({
            "DIP": _daily_series(ms.WINDOW_WEEKS, 100.0),   # MA = 100
            "HIGH": _daily_series(ms.WINDOW_WEEKS, 100.0),  # MA = 100
            "NEW": _daily_series(10, 100.0),                # too short → no MA
        })
        prices = {"DIP": 90.0, "HIGH": 130.0, "NEW": 50.0}
        details: dict[str, dict] = {}
        convs = ms.sniper_convictions(
            db, ["DIP", "HIGH", "NEW"], prices, band=0.05, details=details,
        )
        # DIP is on sale → clears; HIGH is way above band; NEW lacks history.
        self.assertEqual(set(convs), {"DIP"})
        self.assertEqual(convs["DIP"], 5)
        self.assertIn("DIP", details)
        self.assertAlmostEqual(details["DIP"]["discount_pct"], -10.0)

    def test_missing_price_skipped(self):
        db = _FakeDB({"DIP": _daily_series(ms.WINDOW_WEEKS, 100.0)})
        convs = ms.sniper_convictions(db, ["DIP"], {}, band=0.05)
        self.assertEqual(convs, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
