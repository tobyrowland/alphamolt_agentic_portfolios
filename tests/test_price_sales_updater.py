"""Unit tests for the price_sales_updater run-budget fixes.

Context: every scheduled run from 2026-09-04 was killed by the workflow's
30-minute timeout, so the last complete pass was 2026-09-03 and daily P/S
coverage decayed from 2,909 names to 1,424 against a 3,051-name Tier 1
universe. Two things here guard the fix — that a truncated run serves the
stalest names rather than an arbitrary slice, and that the pre-091 fallback
read stays bounded instead of scanning the whole 211 MB table.
"""

import unittest
from datetime import date, timedelta

import db as db_module
from price_sales_updater import order_by_staleness


def _items(*tickers):
    return [{"ticker": t, "exchange": "NASDAQ", "company_name": t} for t in tickers]


class OrderByStalenessTests(unittest.TestCase):
    def test_never_valued_names_go_first(self):
        items = _items("AAA", "BBB", "CCC")
        ps_map = {
            "AAA": {"last_updated": "2026-09-08"},
            "CCC": {"last_updated": "2026-09-01"},
            # BBB has no valuation row at all
        }
        out = [i["ticker"] for i in order_by_staleness(items, ps_map)]
        self.assertEqual(out, ["BBB", "CCC", "AAA"])

    def test_oldest_date_first(self):
        items = _items("AAA", "BBB", "CCC")
        ps_map = {
            "AAA": {"last_updated": "2026-09-08"},
            "BBB": {"last_updated": "2026-08-20"},
            "CCC": {"last_updated": "2026-09-03"},
        }
        out = [i["ticker"] for i in order_by_staleness(items, ps_map)]
        self.assertEqual(out, ["BBB", "CCC", "AAA"])

    def test_a_truncated_run_serves_the_starved_tail(self):
        # The real failure mode: a run gets through ~1,400 of 3,051 names. The
        # names it reaches must be the ones that have gone longest without an
        # update, so successive partial runs converge instead of starving a tail.
        items = _items(*[f"T{i:03d}" for i in range(10)])
        today = date(2026, 9, 8)
        ps_map = {
            # T000-T004 refreshed today; T005-T009 last seen a week+ ago.
            f"T{i:03d}": {
                "last_updated": (today if i < 5 else today - timedelta(days=8 + i)).isoformat()
            }
            for i in range(10)
        }
        out = [i["ticker"] for i in order_by_staleness(items, ps_map)]
        self.assertEqual(set(out[:5]), {"T005", "T006", "T007", "T008", "T009"})

    def test_missing_last_updated_key_is_treated_as_never_valued(self):
        items = _items("AAA", "BBB")
        ps_map = {"AAA": {"last_updated": None}, "BBB": {"last_updated": "2026-09-08"}}
        out = [i["ticker"] for i in order_by_staleness(items, ps_map)]
        self.assertEqual(out, ["AAA", "BBB"])

    def test_every_item_survives_the_reordering(self):
        items = _items("AAA", "BBB", "CCC", "DDD")
        out = order_by_staleness(items, {"BBB": {"last_updated": "2026-09-08"}})
        self.assertEqual(len(out), 4)
        self.assertEqual({i["ticker"] for i in out}, {"AAA", "BBB", "CCC", "DDD"})
        self.assertIs(out[0].__class__, dict)


class _FakeQuery:
    """Records the PostgREST filters a read applies, and returns canned rows."""

    def __init__(self, recorder, rows):
        self.recorder = recorder
        self.rows = rows

    def select(self, cols):
        self.recorder["columns"] = cols
        return self

    def gte(self, col, val):
        self.recorder["gte"] = (col, val)
        return self

    def order(self, col, desc=False):
        return self

    def range(self, lo, hi):
        self.recorder["ranges"].append((lo, hi))
        self._lo, self._hi = lo, hi
        return self

    def execute(self):
        return type("R", (), {"data": self.rows if self._lo == 0 else []})()


class _FakeClient:
    def __init__(self, recorder, rows, rpc_works):
        self.recorder = recorder
        self.rows = rows
        self.rpc_works = rpc_works

    def rpc(self, name, *_a, **_kw):
        self.recorder["rpc"] = name
        if not self.rpc_works:
            raise RuntimeError(
                'Could not find the function public.latest_valuation_state'
            )
        return _FakeQuery(self.recorder, self.rows)

    def table(self, name):
        self.recorder["table"] = name
        return _FakeQuery(self.recorder, self.rows)


class LatestValuationReadTests(unittest.TestCase):
    def _db(self, rows, rpc_works):
        recorder = {"ranges": []}
        inst = db_module.SupabaseDB.__new__(db_module.SupabaseDB)
        inst.client = _FakeClient(recorder, rows, rpc_works)
        return inst, recorder

    def test_prefers_the_rpc(self):
        rows = [{"ticker": "AAA", "date": "2026-09-08", "ps": 3.0,
                 "ps_ath": 5.0, "history_json": []}]
        inst, rec = self._db(rows, rpc_works=True)
        out = inst.get_all_valuation_latest()
        self.assertEqual(rec["rpc"], "latest_valuation_state")
        self.assertNotIn("table", rec)  # never touched the raw table
        self.assertEqual(set(out), {"AAA"})

    def test_falls_back_to_a_bounded_window_when_the_rpc_is_missing(self):
        # Pre-091 deploys must still work — and the fallback must NOT repeat the
        # unbounded full-table scan that caused the timeout.
        rows = [{"ticker": "AAA", "date": "2026-09-08", "ps": 3.0,
                 "ps_ath": 5.0, "history_json": []}]
        inst, rec = self._db(rows, rpc_works=False)
        out = inst.get_all_valuation_latest(lookback_days=30)
        self.assertEqual(rec["table"], "valuation")
        col, floor = rec["gte"]
        self.assertEqual(col, "date")
        self.assertEqual(
            floor, (date.today() - timedelta(days=30)).isoformat()
        )
        self.assertEqual(set(out), {"AAA"})

    def test_fallback_never_selects_star(self):
        # Migration 044 already learned that dragging history_json wholesale is
        # what makes valuation reads expensive; keep the column list narrow.
        inst, rec = self._db([], rpc_works=False)
        inst.get_all_valuation_latest()
        self.assertNotIn("*", rec["columns"])
        self.assertIn("history_json", rec["columns"])

    def test_empty_rpc_result_is_not_mistaken_for_an_unavailable_rpc(self):
        inst, rec = self._db([], rpc_works=True)
        out = inst.get_all_valuation_latest()
        self.assertEqual(out, {})
        self.assertNotIn("table", rec)  # did not fall back


if __name__ == "__main__":
    unittest.main()
