#!/usr/bin/env python3
"""Unit tests for the Buyer's optional P/S-vs-median band (migration 064).

passes_ps_band(ps, median, mode, pct):
  off       -> no constraint (default; nobody excluded, incl. missing median).
  at_most   -> ps <= median*(1 + pct/100)  (ceiling; pct signed).
  at_least  -> ps >= median*(1 + pct/100)  (floor / premium).
When engaged, names with no usable ps/median are EXCLUDED. Pure logic, no
DB/LLM. Run: pytest tests/test_buyer_value_gate.py
"""

from __future__ import annotations

import unittest

import llm_watchlist_buyer as b


class PsBandTests(unittest.TestCase):
    # ---- OFF / unknown -> never excludes ----------------------------------
    def test_off_includes_everyone(self):
        self.assertTrue(b.passes_ps_band(100.0, 10.0, "off", 0))    # richly valued
        self.assertTrue(b.passes_ps_band(5.0, 10.0, "off", -20))    # cheap
        self.assertTrue(b.passes_ps_band(None, None, "off", 0))     # no valuation read
        self.assertTrue(b.passes_ps_band(10.0, None, "off", 0))

    def test_unknown_mode_treated_as_off(self):
        self.assertTrue(b.passes_ps_band(100.0, 10.0, "", 0))
        self.assertTrue(b.passes_ps_band(100.0, 10.0, None, 0))
        self.assertTrue(b.passes_ps_band(100.0, 10.0, "bogus", 0))

    # ---- engaged -> excludes names with no usable valuation ---------------
    def test_engaged_excludes_missing_or_zero_median(self):
        for mode in ("at_most", "at_least"):
            self.assertFalse(b.passes_ps_band(10.0, None, mode, 0))
            self.assertFalse(b.passes_ps_band(10.0, 0, mode, 0))
            self.assertFalse(b.passes_ps_band(None, 10.0, mode, 0))
            self.assertFalse(b.passes_ps_band(0, 10.0, mode, 0))

    # ---- at_most (ceiling), pct negative = discount required --------------
    def test_at_most_negative_pct_requires_discount(self):
        # need ps <= 10 * 0.85 = 8.5
        self.assertTrue(b.passes_ps_band(8.0, 10.0, "at_most", -15))   # 20% below -> ok
        self.assertTrue(b.passes_ps_band(8.5, 10.0, "at_most", -15))   # exactly -> inclusive
        self.assertFalse(b.passes_ps_band(8.51, 10.0, "at_most", -15)) # just over -> fail
        self.assertFalse(b.passes_ps_band(10.0, 10.0, "at_most", -15)) # at median -> fail

    # ---- at_most (ceiling), pct positive = tolerate premium --------------
    def test_at_most_positive_pct_tolerates_premium(self):
        # need ps <= 10 * 1.10 = 11.0  (don't pay > 10% over median)
        self.assertTrue(b.passes_ps_band(11.0, 10.0, "at_most", 10))   # inclusive
        self.assertTrue(b.passes_ps_band(9.0, 10.0, "at_most", 10))    # cheap -> ok
        self.assertFalse(b.passes_ps_band(12.0, 10.0, "at_most", 10))  # too rich -> fail

    # ---- at_least (floor / "double-positive") ----------------------------
    def test_at_least_requires_premium(self):
        # need ps >= 10 * 1.20 = 12.0
        self.assertTrue(b.passes_ps_band(12.0, 10.0, "at_least", 20))  # inclusive
        self.assertTrue(b.passes_ps_band(15.0, 10.0, "at_least", 20))  # well above -> ok
        self.assertFalse(b.passes_ps_band(11.0, 10.0, "at_least", 20)) # not enough premium
        self.assertFalse(b.passes_ps_band(8.0, 10.0, "at_least", 20))  # cheap -> fail

    # ---- coercion / casing ------------------------------------------------
    def test_string_inputs_and_casing(self):
        self.assertTrue(b.passes_ps_band("8.0", "10.0", "AT_MOST", -15))
        self.assertFalse(b.passes_ps_band("9.9", "10.0", " at_most ", -15))


if __name__ == "__main__":
    unittest.main(verbosity=2)
