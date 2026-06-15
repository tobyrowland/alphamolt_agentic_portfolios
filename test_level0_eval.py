#!/usr/bin/env python3
"""Unit tests for level0_eval (Stage A2) — the Tier-1 eval candidate loader.

Pure-logic + a tiny fake PostgREST client for the staleness ordering. No DB,
no LLM. Run: python test_level0_eval.py
"""

from __future__ import annotations

import unittest
from types import SimpleNamespace

import level0_eval as L


class LatestByTickerTests(unittest.TestCase):
    def test_keeps_latest(self):
        rows = [
            {"ticker": "A", "period_end": "2024-12-31", "gm": 50},
            {"ticker": "A", "period_end": "2025-03-31", "gm": 52},
            {"ticker": "B", "period_end": "2025-01-01", "gm": 40},
        ]
        out = L._latest_by_ticker(rows, "period_end")
        self.assertEqual(out["A"]["gm"], 52)
        self.assertEqual(out["B"]["gm"], 40)


class AssembleTests(unittest.TestCase):
    def test_level0_to_companies_keys_and_ai_fallback(self):
        row = L._assemble(
            "TSM",
            {"name": "Taiwan Semi", "country": "Taiwan", "gics_sector": "Technology"},
            {"rev_growth_ttm": 30, "gross_margin": 53, "rule_of_40": 55, "eps": 6.1},
            {"ps": 9.1, "ps_median_12m": 8.0},
            None,  # not in companies
            {"bull_eval": "✅ strong", "bear_eval": "❌ none"},
        )
        self.assertEqual(row["company_name"], "Taiwan Semi")
        self.assertEqual(row["sector"], "Technology")
        self.assertEqual(row["rev_growth_ttm_pct"], 30)
        self.assertEqual(row["rule_of_40"], 55)
        self.assertEqual(row["eps_only"], 6.1)
        self.assertEqual(row["ps_now"], 9.1)
        self.assertEqual(row["bull_eval"], "✅ strong")  # ai fallback

    def test_companies_overlay_wins(self):
        row = L._assemble(
            "AAA", {"name": "X"}, {"gross_margin": 40}, None,
            {"company_name": "Acme", "annual_revenue_5y": [1, 2, 3], "bull_eval": "✅ co"},
            {"bull_eval": "✅ ai"},
        )
        self.assertEqual(row["company_name"], "Acme")
        self.assertEqual(row["annual_revenue_5y"], [1, 2, 3])
        self.assertEqual(row["bull_eval"], "✅ co")  # companies, not ai


# --- staleness ordering with a minimal fake PostgREST client ---------------

class _FakeQ:
    def __init__(self, table, data):
        self.table_name = table
        self._data = data
    def select(self, *_a, **_k): return self
    def eq(self, *_a, **_k): return self
    def in_(self, *_a, **_k): return self
    def range(self, *_a, **_k): return self
    def execute(self):
        return SimpleNamespace(data=self._data)


class _FakeClient:
    def __init__(self, securities, ai):
        self._securities = securities
        self._ai = ai
    def table(self, name):
        return _FakeQ(name, self._securities if name == "securities" else self._ai)


class _FakeDB:
    def __init__(self, securities, ai):
        self.client = _FakeClient(securities, ai)
    def get_ai_analysis(self, tickers):
        return {}


class StaleOrderingTests(unittest.TestCase):
    def test_never_evaluated_first_then_oldest(self):
        securities = [{"ticker": t} for t in ("AAA", "BBB", "CCC", "DDD")]
        # AAA has no ai row at all (NULL), BBB NULL clock, CCC old, DDD recent.
        ai = [
            {"ticker": "BBB", "bull_at": None},
            {"ticker": "CCC", "bull_at": "2025-01-01T00:00:00Z"},
            {"ticker": "DDD", "bull_at": "2026-06-01T00:00:00Z"},
        ]
        db = _FakeDB(securities, ai)
        order = L.stale_tier1_tickers(db, "bull", top_n=4)
        # NULLs (AAA, BBB) first, then oldest (CCC) before recent (DDD).
        self.assertEqual(set(order[:2]), {"AAA", "BBB"})
        self.assertEqual(order[2], "CCC")
        self.assertEqual(order[3], "DDD")

    def test_top_n_caps(self):
        securities = [{"ticker": f"T{i}"} for i in range(10)]
        db = _FakeDB(securities, [])
        self.assertEqual(len(L.stale_tier1_tickers(db, "bear", top_n=3)), 3)

    def test_unknown_kind_raises(self):
        db = _FakeDB([], [])
        with self.assertRaises(ValueError):
            L.stale_tier1_tickers(db, "sideways", top_n=1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
