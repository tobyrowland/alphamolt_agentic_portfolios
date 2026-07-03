#!/usr/bin/env python3
"""Unit tests for the buyer's PASS-only rejection recording (migration 051).

Verifies _pass_rejection_rows only hides true PASSes — a sub-gate BUY (a name
the agent wants, just not its top pick) and a qualifying BUY are NOT recorded,
so they stay eligible. Pure logic, no DB/LLM. Run: pytest tests/test_buyer_rejections.py
"""

from __future__ import annotations

import unittest

import llm_watchlist_buyer as b


class PassRejectionRowsTests(unittest.TestCase):
    def _evals(self):
        return [
            {"ticker": "AAA", "verdict": "PASS", "conviction": 1, "rationale": "weak growth"},
            {"ticker": "BBB", "verdict": "BUY", "conviction": 4, "rationale": "near miss"},   # sub-gate
            {"ticker": "CCC", "verdict": "BUY", "conviction": 5, "rationale": "top pick"},     # qualifier
            {"ticker": "DDD", "verdict": "pass", "conviction": 2, "rationale": ""},            # case-insensitive
        ]

    def test_only_passes_recorded(self):
        rows = b._pass_rejection_rows(self._evals(), "agent-x")
        self.assertEqual({r["ticker"] for r in rows}, {"AAA", "DDD"})

    def test_sub_gate_buy_not_hidden(self):
        rows = b._pass_rejection_rows(self._evals(), "agent-x")
        self.assertNotIn("BBB", {r["ticker"] for r in rows})  # 4/5 BUY stays eligible

    def test_qualifying_buy_not_hidden(self):
        rows = b._pass_rejection_rows(self._evals(), "agent-x")
        self.assertNotIn("CCC", {r["ticker"] for r in rows})

    def test_row_shape(self):
        rows = b._pass_rejection_rows(self._evals(), "agent-x")
        aaa = next(r for r in rows if r["ticker"] == "AAA")
        self.assertEqual(aaa["rejected_by_agent_id"], "agent-x")
        self.assertEqual(aaa["verdict"], "PASS")
        self.assertEqual(aaa["reason"], "weak growth")
        # empty rationale collapses to None
        ddd = next(r for r in rows if r["ticker"] == "DDD")
        self.assertIsNone(ddd["reason"])

    def test_empty(self):
        self.assertEqual(b._pass_rejection_rows([], "a"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
