#!/usr/bin/env python3
"""Unit tests for the Buyer's synchronous P/S-discount value gate (migration 058).

Verifies passes_value_gate: OFF (default 0) includes everyone incl. names with no
P/S median; ON excludes missing/zero median (no valuation read) and names not at
least N% below their own 12-mo median; boundary is inclusive. Pure logic, no
DB/LLM. Run: python test_buyer_value_gate.py
"""

from __future__ import annotations

import unittest

import llm_watchlist_buyer as b


class ValueGateTests(unittest.TestCase):
    # ---- gate OFF (default) -> never excludes -----------------------------
    def test_off_includes_everyone(self):
        self.assertTrue(b.passes_value_gate(100.0, 10.0, 0))      # richly valued
        self.assertTrue(b.passes_value_gate(5.0, 10.0, 0))        # cheap
        self.assertTrue(b.passes_value_gate(None, None, 0))       # no valuation read
        self.assertTrue(b.passes_value_gate(10.0, None, 0))

    def test_negative_pct_treated_as_off(self):
        self.assertTrue(b.passes_value_gate(100.0, 10.0, -5))

    # ---- gate ON -> excludes names with no usable valuation ---------------
    def test_on_excludes_missing_or_zero_median(self):
        self.assertFalse(b.passes_value_gate(10.0, None, 15))
        self.assertFalse(b.passes_value_gate(10.0, 0, 15))
        self.assertFalse(b.passes_value_gate(None, 10.0, 15))
        self.assertFalse(b.passes_value_gate(0, 10.0, 15))

    # ---- gate ON -> discount maths ---------------------------------------
    def test_on_richer_than_median_fails(self):
        # ps == median -> 0% discount, needs 15% -> fail
        self.assertFalse(b.passes_value_gate(10.0, 10.0, 15))
        # ps above median -> fail
        self.assertFalse(b.passes_value_gate(12.0, 10.0, 15))

    def test_on_cheaper_passes(self):
        # 20% below median, needs 15% -> pass
        self.assertTrue(b.passes_value_gate(8.0, 10.0, 15))

    def test_on_boundary_is_inclusive(self):
        # exactly 15% below median (8.5 == 10 * 0.85) -> pass
        self.assertTrue(b.passes_value_gate(8.5, 10.0, 15))
        # a hair above the threshold -> fail
        self.assertFalse(b.passes_value_gate(8.51, 10.0, 15))

    def test_string_inputs_coerced(self):
        # safe_float handles strings; gate still works
        self.assertTrue(b.passes_value_gate("8.0", "10.0", 15))
        self.assertFalse(b.passes_value_gate("9.9", "10.0", 15))


if __name__ == "__main__":
    unittest.main(verbosity=2)
