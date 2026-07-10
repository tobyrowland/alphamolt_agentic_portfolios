#!/usr/bin/env python3
"""Screener filter transforms (migration 076).

Three layers:
  1. Python transform semantics against the shared fixture
     (tests/fixtures/transform_parity.json — null rules, streaks, slopes).
  2. Cross-language parity: the SAME fixture evaluated by
     web/lib/screen/transforms.ts under `node --experimental-strip-types`
     must agree with screen.py bit-for-bit (skipped when node is missing).
  3. Filter matching through screen.apply_filters — transform filters read
     the `quarters` series, series-only fields without a transform are a
     no-constraint, missing series excludes.

Plus the write-side: eodhd_updater.compute_quarterly_series building the
series from EODHD-shaped statements. Run: pytest tests/test_transforms.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

import screen
from eodhd_updater import compute_quarterly_series

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "transform_parity.json"


def _load_cases() -> list[dict]:
    return json.loads(FIXTURE.read_text())


class TestTransformSemantics(unittest.TestCase):
    """Python implementation against the shared fixture."""

    def test_fixture_cases(self):
        for c in _load_cases():
            with self.subTest(c["name"]):
                series = [screen._f(v) for v in c["series"]]
                self.assertEqual(
                    screen.apply_transform(series, c["transform"]), c["expected"]
                )

    def test_unknown_transform_is_none(self):
        self.assertIsNone(screen.apply_transform([1.0, 2.0], "nope"))

    def test_none_series_is_none(self):
        self.assertIsNone(screen.apply_transform(None, "delta_qoq"))

    def test_streak_semantics_match_updater(self):
        # Same convention as eodhd_updater._improvement_streak: improving =
        # cur > prev walking back from the latest; None where unassessable.
        self.assertEqual(screen.apply_transform([5.0, 4.0, 4.0], "streak_qtrs"), 1)
        self.assertEqual(screen.apply_transform([4.0, 5.0], "streak_qtrs"), 0)
        self.assertIsNone(screen.apply_transform([5.0], "streak_qtrs"))


class TestTsParity(unittest.TestCase):
    """web/lib/screen/transforms.ts must agree with screen.py exactly."""

    def test_ts_matches_python(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not available")
        proc = subprocess.run(
            [node, "--experimental-strip-types",
             str(ROOT / "tests" / "ts_transform_runner.mjs"), str(FIXTURE)],
            capture_output=True, text=True, cwd=ROOT,
        )
        if proc.returncode != 0:
            self.skipTest(f"node cannot strip types: {proc.stderr[:200]}")
        actuals = {r["name"]: r["actual"] for r in json.loads(proc.stdout)}
        for c in _load_cases():
            with self.subTest(c["name"]):
                self.assertEqual(actuals[c["name"]], c["expected"])


def _row(**kw) -> dict:
    base = {"ticker": "T", "sector": None, "quarters": None}
    base.update(kw)
    return base


QUARTERS = {
    "period_ends": ["2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"],
    "gross_margin": [52.0, 50.0, 47.5, 48.0],
    "rev_growth_qoq": [4.0, 1.0, -2.0, -5.0],
    "revenue": [110.0, 105.0, 100.0, 98.0],
    "fcf_margin": [None, -1.0, -3.0, -4.0],
}


class TestTransformFilters(unittest.TestCase):
    """Transform-aware filter matching (screen._matches via apply_filters)."""

    def test_streak_filter_matches(self):
        rows = [_row(quarters=QUARTERS)]
        # GM improved 2 consecutive quarters (52>50>47.5, then 47.5<48 stops).
        out = screen.apply_filters(rows, [
            {"field": "gross_margin", "transform": "streak_qtrs",
             "op": ">=", "value": 2},
        ])
        self.assertEqual(len(out), 1)
        out = screen.apply_filters(rows, [
            {"field": "gross_margin", "transform": "streak_qtrs",
             "op": ">=", "value": 3},
        ])
        self.assertEqual(out, [])

    def test_series_only_field_requires_transform(self):
        rows = [_row(quarters=QUARTERS)]
        # `revenue` WITH a transform: up 3 straight quarters (110>105>100>98).
        out = screen.apply_filters(rows, [
            {"field": "revenue", "transform": "streak_qtrs",
             "op": ">=", "value": 3},
        ])
        self.assertEqual(len(out), 1)
        # WITHOUT a transform it's a no-constraint (matches everything) —
        # parity with score.ts, which has no scalar column to read either.
        out = screen.apply_filters(rows, [
            {"field": "revenue", "op": ">=", "value": 1e12},
        ])
        self.assertEqual(len(out), 1)

    def test_rev_growth_qoq_scalar_and_transform(self):
        # rev_growth_qoq has BOTH reads since migrations 075/076: transform-less
        # hits the scalar matview column; a transform hits the series.
        rows = [_row(quarters=QUARTERS, rev_growth_qoq=4.0)]
        out = screen.apply_filters(rows, [
            {"field": "rev_growth_qoq", "op": ">=", "value": 5},
        ])
        self.assertEqual(out, [])  # scalar 4 < 5
        out = screen.apply_filters(rows, [
            {"field": "rev_growth_qoq", "transform": "streak_qtrs",
             "op": ">=", "value": 3},  # series improving 3 straight quarters
        ])
        self.assertEqual(len(out), 1)

    def test_missing_series_excludes(self):
        rows = [_row(quarters=None)]
        out = screen.apply_filters(rows, [
            {"field": "gross_margin", "transform": "streak_qtrs",
             "op": ">=", "value": 1},
        ])
        self.assertEqual(out, [])

    def test_null_transform_value_excludes(self):
        # fcf_margin's latest value is None → delta_qoq None → excluded.
        rows = [_row(quarters=QUARTERS)]
        out = screen.apply_filters(rows, [
            {"field": "fcf_margin", "transform": "delta_qoq",
             "op": ">", "value": 0},
        ])
        self.assertEqual(out, [])

    def test_unknown_transform_is_no_constraint(self):
        rows = [_row(quarters=QUARTERS)]
        out = screen.apply_filters(rows, [
            {"field": "gross_margin", "transform": "sorcery",
             "op": ">=", "value": 99},
        ])
        self.assertEqual(len(out), 1)

    def test_transform_on_field_without_series_is_no_constraint(self):
        rows = [_row(quarters=QUARTERS, ps=50.0)]
        out = screen.apply_filters(rows, [
            {"field": "ps", "transform": "streak_qtrs", "op": ">=", "value": 9},
        ])
        self.assertEqual(len(out), 1)

    def test_plain_filters_unchanged(self):
        rows = [_row(quarters=QUARTERS, gross_margin=55.0)]
        # No transform → the row SCALAR (55), not the series latest (52).
        out = screen.apply_filters(rows, [
            {"field": "gross_margin", "op": ">=", "value": 54},
        ])
        self.assertEqual(len(out), 1)


def _q(date: str, rev, gp=None, oi=None, ni=None) -> tuple[str, dict]:
    e: dict = {"totalRevenue": rev}
    if gp is not None:
        e["grossProfit"] = gp
    if oi is not None:
        e["operatingIncome"] = oi
    if ni is not None:
        e["netIncome"] = ni
    return (date, e)


class TestComputeQuarterlySeries(unittest.TestCase):
    """Write-side: the series builder over EODHD-shaped statements."""

    def test_series_shape_and_values(self):
        quarterly = [
            _q("2026-03-31", 110.0, gp=55.0, oi=11.0, ni=5.5),
            _q("2025-12-31", 100.0, gp=48.0, oi=9.0, ni=4.0),
            _q("2025-09-30", 95.0, gp=44.0, oi=8.0, ni=3.0),
        ]
        cf = [("2026-03-31", {"freeCashFlow": 11.0}),
              ("2025-12-31", {"freeCashFlow": -2.0})]
        s = compute_quarterly_series(quarterly, cf)
        self.assertEqual(s["period_ends"],
                         ["2026-03-31", "2025-12-31", "2025-09-30"])
        self.assertEqual(s["revenue"], [110.0, 100.0, 95.0])
        self.assertEqual(s["gross_margin"], [50.0, 48.0, 46.32])
        self.assertEqual(s["operating_margin"], [10.0, 9.0, 8.42])
        self.assertEqual(s["net_margin"], [5.0, 4.0, 3.16])
        # rev_growth_qoq: 110 vs 100 = +10%, 100 vs 95 = +5.26%, oldest None.
        self.assertEqual(s["rev_growth_qoq"], [10.0, 5.26, None])
        # FCF matched by period date; quarter with no CF entry stays None.
        self.assertEqual(s["fcf_margin"], [10.0, -2.0, None])
        # Every array aligned to period_ends.
        for key in ("revenue", "rev_growth_qoq", "gross_margin",
                    "operating_margin", "net_margin", "fcf_margin"):
            self.assertEqual(len(s[key]), 3, key)

    def test_no_quarters_returns_none(self):
        self.assertIsNone(compute_quarterly_series([], []))

    def test_lookback_capped_and_qoq_uses_extra_quarter(self):
        quarterly = [_q(f"d{i:02d}", float(100 - i)) for i in range(14)]
        s = compute_quarterly_series(quarterly, [])
        self.assertEqual(len(s["period_ends"]), 12)  # SERIES_LOOKBACK_QTRS
        # The 12th (oldest stored) quarter still gets a QoQ value because the
        # builder looks one quarter further back.
        self.assertIsNotNone(s["rev_growth_qoq"][11])

    def test_zero_revenue_quarter_is_null_not_crash(self):
        quarterly = [_q("2026-03-31", 0.0, gp=1.0), _q("2025-12-31", 10.0, gp=5.0)]
        s = compute_quarterly_series(quarterly, [])
        self.assertIsNone(s["gross_margin"][0])       # 0-revenue margin → null
        self.assertEqual(s["rev_growth_qoq"][0], -100.0)


if __name__ == "__main__":
    unittest.main()
