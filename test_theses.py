#!/usr/bin/env python3
"""Unit tests for the investment-thesis framework (``theses.py``).

Covers the four public helpers with stubbed Supabase access — no live
DB calls, no LLM calls. Run directly:

    python test_theses.py
"""

from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace

import theses


# ---------------------------------------------------------------------------
# Stubbed SupabaseDB — captures every operation so tests can assert
# on the exact PostgREST chain that was issued.
# ---------------------------------------------------------------------------


class _Query:
    """Single chainable query — records every call and returns canned data."""

    def __init__(self, db, table_name):
        self._db = db
        self.table_name = table_name
        self.op = None          # 'select' | 'insert' | 'update' | 'delete'
        self.payload = None
        self.filters: dict = {}
        self.neq_filters: dict = {}
        self.eq_filters: dict = {}
        self._next_id = None

    # ---- record verbs ----
    def select(self, _cols="*"):
        self.op = "select"
        return self

    def insert(self, payload):
        self.op = "insert"
        self.payload = payload
        return self

    def update(self, payload):
        self.op = "update"
        self.payload = payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    # ---- filters ----
    def match(self, filters):
        self.filters = dict(filters)
        return self

    def eq(self, key, value):
        self.eq_filters[key] = value
        return self

    def neq(self, key, value):
        self.neq_filters[key] = value
        return self

    # ---- terminal ----
    def execute(self):
        self._db.log.append({
            "table": self.table_name,
            "op": self.op,
            "payload": self.payload,
            "filters": dict(self.filters),
            "eq": dict(self.eq_filters),
            "neq": dict(self.neq_filters),
        })
        if self.op == "insert":
            row = dict(self.payload or {})
            row["id"] = self._db.next_insert_id
            self._db.next_insert_id += 1
            return SimpleNamespace(data=[row])
        # update / delete — return a canned "affected" list so callers
        # can count without us having to maintain a real in-mem rowset.
        if self.op in ("update", "delete"):
            return SimpleNamespace(data=self._db.canned_affected)
        # select — return whatever the test set up
        if self.op == "select":
            key = (self.table_name, frozenset(self.eq_filters.items()))
            return SimpleNamespace(data=self._db.canned_selects.get(key, []))
        return SimpleNamespace(data=[])


class _StubDB:
    def __init__(self):
        self.log: list[dict] = []
        self.next_insert_id = 100
        self.canned_affected: list[dict] = []
        self.canned_selects: dict = {}
        # Catalogue of company rows (ticker → row dict) for get_company.
        self.companies: dict[str, dict] = {}
        self.client = self  # so theses.py's `db.client.table(...)` resolves to us

    def table(self, name):
        return _Query(self, name)

    def get_company(self, ticker):
        return self.companies.get(ticker)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _company(ticker="NVDA", **overrides) -> dict:
    """Realistic companies row, full extended-tier fields populated."""
    base = {
        "ticker": ticker, "company_name": "NVIDIA Corp",
        "country": "United States", "sector": "Technology Services",
        "rating": 1.4, "r40_score": 88.2, "rule_of_40": 85.4,
        "rev_growth_ttm_pct": 90.1, "rev_growth_qoq_pct": 22.3,
        "rev_cagr_pct": 65.4, "rev_consistency_score": 9.1,
        "gross_margin_pct": 75.2, "operating_margin_pct": 55.1,
        "net_margin_pct": 50.0, "net_margin_yoy_pct": 14.0,
        "fcf_margin_pct": 48.0, "opex_pct_revenue": 20.1,
        "sm_rd_pct_revenue": 18.0, "eps_only": 3.1, "eps_yoy_pct": 80.0,
        "qrtrs_to_profitability": None, "gm_trend": "stable",
        "price": 612.34, "ps_now": 32.1, "price_pct_of_52w_high": 0.92,
        "perf_52w_vs_spy": 0.45, "composite_score": 85.4,
        "short_outlook": "🟢", "key_risks": "concentration in hyperscalers",
        "full_outlook": "...", "bull_eval": "✅ ...", "bear_eval": "✅ ...",
        "status": None, "flags": {}, "ai_analyzed_at": "2026-05-01T00:00:00Z",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# build_snapshot
# ---------------------------------------------------------------------------


class BuildSnapshotTests(unittest.TestCase):
    def test_returns_only_declared_fields(self):
        db = _StubDB()
        db.companies["NVDA"] = _company()
        snap = theses.build_snapshot(db, "NVDA")
        # Exactly the field set, no more, no less.
        self.assertEqual(set(snap.keys()), set(theses._SNAPSHOT_FIELDS))
        self.assertEqual(snap["ticker"], "NVDA")
        self.assertEqual(snap["fcf_margin_pct"], 48.0)
        self.assertEqual(snap["bull_eval"], "✅ ...")

    def test_missing_fields_become_none(self):
        # Sparse companies row — fields that don't exist on the row are None.
        db = _StubDB()
        db.companies["AAPL"] = {"ticker": "AAPL", "price": 200.0}
        snap = theses.build_snapshot(db, "AAPL")
        self.assertEqual(snap["ticker"], "AAPL")
        self.assertEqual(snap["price"], 200.0)
        # Every other declared field is None — not missing from the dict.
        self.assertIn("fcf_margin_pct", snap)
        self.assertIsNone(snap["fcf_margin_pct"])

    def test_unknown_ticker_raises(self):
        db = _StubDB()
        with self.assertRaises(ValueError):
            theses.build_snapshot(db, "GHOST")


# ---------------------------------------------------------------------------
# record_thesis
# ---------------------------------------------------------------------------


class RecordThesisTests(unittest.TestCase):
    def test_snapshot_only_when_no_thesis(self):
        db = _StubDB()
        db.companies["NVDA"] = _company()
        new_id = theses.record_thesis(
            db, agent_id="A", ticker="NVDA", trade_id=42,
        )
        self.assertEqual(new_id, 100)
        # Should have done a supersede update + an insert.
        ops = [(op["op"], op["table"]) for op in db.log]
        self.assertEqual(ops, [
            ("update", "investment_theses"),  # supersede prior
            ("insert", "investment_theses"),
        ])
        # Supersede targets the right (agent, ticker, status='active').
        self.assertEqual(db.log[0]["filters"], {
            "agent_id": "A", "ticker": "NVDA", "status": "active",
        })
        # Insert payload: source='auto', snapshot populated, no text fields.
        inserted = db.log[1]["payload"]
        self.assertEqual(inserted["source"], "auto")
        self.assertEqual(inserted["agent_id"], "A")
        self.assertEqual(inserted["ticker"], "NVDA")
        self.assertEqual(inserted["trade_id"], 42)
        self.assertIsNone(inserted["thesis_text"])
        self.assertIsNone(inserted["extend_signals"])
        self.assertIsNone(inserted["break_signals"])
        self.assertEqual(inserted["snapshot"]["ticker"], "NVDA")
        self.assertEqual(inserted["status"], "active")

    def test_source_agent_when_text_provided(self):
        db = _StubDB()
        db.companies["NVDA"] = _company()
        theses.record_thesis(
            db, agent_id="A", ticker="NVDA", trade_id=42,
            thesis_text="bullish on accelerators",
        )
        inserted = db.log[1]["payload"]
        self.assertEqual(inserted["source"], "agent")
        self.assertEqual(inserted["thesis_text"], "bullish on accelerators")

    def test_source_agent_when_only_signals_provided(self):
        db = _StubDB()
        db.companies["NVDA"] = _company()
        theses.record_thesis(
            db, agent_id="A", ticker="NVDA", trade_id=42,
            break_signals=[{"field": "fcf_margin_pct", "op": "<", "value": 30}],
        )
        inserted = db.log[1]["payload"]
        self.assertEqual(inserted["source"], "agent")
        self.assertEqual(len(inserted["break_signals"]), 1)

    def test_portfolio_id_threaded_when_provided(self):
        # Migration 021 added portfolio_id; verify it lands on the insert.
        db = _StubDB()
        db.companies["NVDA"] = _company()
        theses.record_thesis(
            db, agent_id="A", portfolio_id="P-1", ticker="NVDA", trade_id=42,
        )
        # Supersede match should target portfolio_id, not agent_id.
        supersede = db.log[0]
        self.assertEqual(supersede["op"], "update")
        self.assertEqual(supersede["filters"].get("portfolio_id"), "P-1")
        self.assertNotIn("agent_id", supersede["filters"])
        # Insert payload also has portfolio_id.
        inserted = db.log[1]["payload"]
        self.assertEqual(inserted["portfolio_id"], "P-1")
        self.assertEqual(inserted["agent_id"], "A")

    def test_portfolio_id_defaults_to_agent_id_when_omitted(self):
        # Backwards-compat: callers that don't pass portfolio_id still
        # produce a valid row (NOT NULL on the column).
        db = _StubDB()
        db.companies["NVDA"] = _company()
        theses.record_thesis(
            db, agent_id="A", ticker="NVDA", trade_id=42,
        )
        supersede = db.log[0]
        self.assertEqual(supersede["filters"].get("agent_id"), "A")
        inserted = db.log[1]["payload"]
        self.assertEqual(inserted["portfolio_id"], "A")


# ---------------------------------------------------------------------------
# close_theses_for_position
# ---------------------------------------------------------------------------


class CloseThesesTests(unittest.TestCase):
    def test_updates_non_closed_rows(self):
        db = _StubDB()
        db.canned_affected = [{"id": 1}, {"id": 2}]  # pretend 2 rows updated
        n = theses.close_theses_for_position(db, agent_id="A", ticker="NVDA")
        self.assertEqual(n, 2)
        self.assertEqual(db.log[0]["op"], "update")
        self.assertEqual(db.log[0]["filters"], {"agent_id": "A", "ticker": "NVDA"})
        self.assertEqual(db.log[0]["neq"], {"status": "closed"})
        payload = db.log[0]["payload"]
        self.assertEqual(payload["status"], "closed")
        self.assertIn("status_changed_at", payload)
        self.assertIn("closed_at", payload)

    def test_no_rows_is_idempotent(self):
        db = _StubDB()
        db.canned_affected = []
        n = theses.close_theses_for_position(db, agent_id="A", ticker="ZZZ")
        self.assertEqual(n, 0)


# ---------------------------------------------------------------------------
# _evaluate_signal — the operator engine
# ---------------------------------------------------------------------------


class EvaluateSignalTests(unittest.TestCase):
    def setUp(self):
        self.snap = _company(fcf_margin_pct=48.0, rating=1.4)
        self.cur = _company(fcf_margin_pct=42.0, rating=1.8)

    def test_static_lt_triggered(self):
        # "FCF margin drops below 45%" — current=42 < 45 → triggered.
        sig = {"field": "fcf_margin_pct", "op": "<", "value": 45}
        self.assertTrue(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_static_lt_not_triggered(self):
        # "FCF margin drops below 40%" — current=42, not below 40.
        sig = {"field": "fcf_margin_pct", "op": "<", "value": 40}
        self.assertFalse(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_static_gt(self):
        # "Rating climbs above 1.6" — current=1.8 > 1.6 → triggered.
        sig = {"field": "rating", "op": ">", "value": 1.6}
        self.assertTrue(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_change_pct_lt(self):
        # "FCF margin drops by more than 5pp" — delta=42-48=-6, < -5 → triggered.
        sig = {"field": "fcf_margin_pct", "op": "change_pct_lt", "value": -5}
        self.assertTrue(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_change_pct_lt_not_triggered(self):
        # Delta=-6, not less than -10.
        sig = {"field": "fcf_margin_pct", "op": "change_pct_lt", "value": -10}
        self.assertFalse(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_change_pct_gt(self):
        # "Rating climbs by more than 0.3 points" — delta=1.8-1.4=0.4 > 0.3.
        sig = {"field": "rating", "op": "change_pct_gt", "value": 0.3}
        self.assertTrue(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_unknown_op_safe(self):
        sig = {"field": "rating", "op": "nope", "value": 0}
        self.assertFalse(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_missing_field_safe(self):
        sig = {"field": "no_such_field", "op": "<", "value": 0}
        self.assertFalse(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_non_numeric_current_safe(self):
        # bear_eval is a text/emoji field — not numeric, signal is unevaluable.
        sig = {"field": "bear_eval", "op": "<", "value": 1}
        self.assertFalse(theses._evaluate_signal(sig, self.snap, self.cur))

    def test_em_dash_treated_as_none(self):
        # Companies table uses em-dash for missing numbers; must not raise.
        snap = _company(fcf_margin_pct=48.0)
        cur = _company(fcf_margin_pct="—")
        sig = {"field": "fcf_margin_pct", "op": "<", "value": 45}
        self.assertFalse(theses._evaluate_signal(sig, snap, cur))


# ---------------------------------------------------------------------------
# check_thesis — end-to-end verdict logic over a stubbed thesis row
# ---------------------------------------------------------------------------


def _seed_thesis_row(db, *, thesis_id, ticker, snapshot,
                     break_signals=None, extend_signals=None):
    """Make the next ``select * eq(id, thesis_id)`` return this row."""
    db.canned_selects[("investment_theses", frozenset({("id", thesis_id)}))] = [{
        "id": thesis_id,
        "ticker": ticker,
        "snapshot": snapshot,
        "break_signals": break_signals,
        "extend_signals": extend_signals,
    }]


class CheckThesisTests(unittest.TestCase):
    def test_active_when_no_signals_triggered(self):
        db = _StubDB()
        snap = _company(fcf_margin_pct=48.0)
        cur = _company(fcf_margin_pct=47.5)  # tiny drift, no signal triggered
        db.companies["NVDA"] = cur
        _seed_thesis_row(
            db, thesis_id=7, ticker="NVDA", snapshot=snap,
            break_signals=[{"field": "fcf_margin_pct", "op": "<", "value": 40}],
        )
        result = theses.check_thesis(db, 7)
        self.assertEqual(result["verdict"], "active")
        self.assertEqual(result["broken_signals"], [])
        # Delta still captured.
        self.assertIn("fcf_margin_pct", result["delta"])

    def test_broken_when_break_signal_triggers(self):
        db = _StubDB()
        snap = _company(fcf_margin_pct=48.0)
        cur = _company(fcf_margin_pct=30.0)  # collapse
        db.companies["NVDA"] = cur
        _seed_thesis_row(
            db, thesis_id=7, ticker="NVDA", snapshot=snap,
            break_signals=[
                {"field": "fcf_margin_pct", "op": "<", "value": 40,
                 "description": "FCF margin collapse"},
            ],
        )
        result = theses.check_thesis(db, 7)
        self.assertEqual(result["verdict"], "broken")
        self.assertEqual(len(result["broken_signals"]), 1)

    def test_improved_when_extend_triggers_and_break_clean(self):
        db = _StubDB()
        snap = _company(rev_growth_ttm_pct=60.0)
        cur = _company(rev_growth_ttm_pct=120.0)  # accelerated
        db.companies["NVDA"] = cur
        _seed_thesis_row(
            db, thesis_id=8, ticker="NVDA", snapshot=snap,
            extend_signals=[
                {"field": "rev_growth_ttm_pct", "op": ">", "value": 100,
                 "description": "Hypergrowth"},
            ],
        )
        result = theses.check_thesis(db, 8)
        self.assertEqual(result["verdict"], "improved")

    def test_broken_precedes_improved(self):
        # Both triggered → 'broken' wins (downside risk dominates).
        db = _StubDB()
        snap = _company(fcf_margin_pct=48.0, rev_growth_ttm_pct=60.0)
        cur = _company(fcf_margin_pct=30.0, rev_growth_ttm_pct=120.0)
        db.companies["NVDA"] = cur
        _seed_thesis_row(
            db, thesis_id=9, ticker="NVDA", snapshot=snap,
            break_signals=[{"field": "fcf_margin_pct", "op": "<", "value": 40}],
            extend_signals=[{"field": "rev_growth_ttm_pct", "op": ">", "value": 100}],
        )
        result = theses.check_thesis(db, 9)
        self.assertEqual(result["verdict"], "broken")

    def test_auto_thesis_no_signals_still_active(self):
        # source='auto' row — no signals at all — verdict is 'active'.
        db = _StubDB()
        snap = _company()
        cur = _company(fcf_margin_pct=10.0)  # huge drift, but no signal cares
        db.companies["NVDA"] = cur
        _seed_thesis_row(
            db, thesis_id=10, ticker="NVDA", snapshot=snap,
            break_signals=None, extend_signals=None,
        )
        result = theses.check_thesis(db, 10)
        self.assertEqual(result["verdict"], "active")
        self.assertEqual(result["broken_signals"], [])
        # Drift still surfaced in delta so caller can inspect.
        self.assertIn("fcf_margin_pct", result["delta"])

    def test_unknown_thesis_raises(self):
        db = _StubDB()
        with self.assertRaises(ValueError):
            theses.check_thesis(db, 999)


# ---------------------------------------------------------------------------
# mark_thesis_status
# ---------------------------------------------------------------------------


class MarkThesisStatusTests(unittest.TestCase):
    def test_writes_status_and_timestamp(self):
        db = _StubDB()
        theses.mark_thesis_status(db, 7, status="broken")
        self.assertEqual(db.log[0]["op"], "update")
        self.assertEqual(db.log[0]["filters"], {"id": 7})
        self.assertEqual(db.log[0]["payload"]["status"], "broken")
        self.assertIn("status_changed_at", db.log[0]["payload"])
        self.assertNotIn("closed_at", db.log[0]["payload"])

    def test_closed_sets_closed_at(self):
        db = _StubDB()
        theses.mark_thesis_status(db, 7, status="closed")
        self.assertIn("closed_at", db.log[0]["payload"])

    def test_rejects_invalid_status(self):
        db = _StubDB()
        with self.assertRaises(ValueError):
            theses.mark_thesis_status(db, 7, status="bogus")


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
