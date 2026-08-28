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


class EvalPromptHasNoCashTests(unittest.TestCase):
    """The per-name BUY/PASS prompt must not tell the model what cash is left.

    A PASS is recorded as a ~30-day screener rejection, indistinguishable from
    "this business is bad". So a PASS caused by an empty wallet quarantines a
    name the buyer would want the moment it has money — and on a fully-invested
    book that is a slow, silent depletion of the candidate pool.

    It was happening. Of 84 names hidden on the Scrappy Fightback book, 15 cited
    the cash position in their rationale, e.g. SPOT: "the $6.24 P/S multiple is
    rich ... and the portfolio lacks sufficient cash ($467) to purchase a
    significant position". Most also gave a genuine mandate reason, so cash was
    a contaminant rather than the whole cause — but a contaminant with a 30-day
    consequence, on the input that decides it.

    Affordability is the DRAFT's decision, made downstream against the shared
    pot, and the prioritisation call's — which ranks names precisely because
    cash is scarce, and which therefore keeps its cash line.
    """

    def _rendered(self) -> str:
        """The eval prompt as the model receives it, for a broke portfolio."""
        return b.BUYER_USER_TEMPLATE.format(
            portfolio_mandate_block="",
            total_value_usd=1_051_355.0,
            current_holdings="ADBE, MELI, ZBRA",
            ticker="SPOT",
            curator_rationale="turnaround",
            bull_eval="—",
            bear_eval="—",
            research_card="—",
            recent_news="—",
            equity_data_json="{}",
        )

    def test_the_template_takes_no_cash_placeholder(self):
        """Checked on the template, so removing the ARGUMENT alone can't pass."""
        self.assertNotIn("{cash_usd", b.BUYER_USER_TEMPLATE)
        self.assertNotIn("{cash_pct", b.BUYER_USER_TEMPLATE)

    def test_a_broke_portfolio_renders_no_cash_figure(self):
        """The end-to-end claim: nothing in the prompt says how much is left."""
        rendered = self._rendered()
        self.assertNotIn("Cash available", rendered)
        self.assertNotIn("467", rendered)

    def test_it_still_states_size_and_holdings(self):
        """Not a blanket removal of portfolio context. Position size and what
        is already owned are mandate-fit inputs — 'do we already own this
        exposure?' is exactly what this call should weigh."""
        rendered = self._rendered()
        self.assertIn("1,051,355", rendered)
        self.assertIn("ADBE, MELI, ZBRA", rendered)

    def test_the_prioritisation_prompt_keeps_its_cash_line(self):
        """The complement, and the reason this is a move rather than a purge:
        ranking under scarcity NEEDS to know the scarcity."""
        self.assertIn("{cash_usd", b.PRIORITISATION_USER_TEMPLATE)
