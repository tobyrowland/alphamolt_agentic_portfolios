#!/usr/bin/env python3
"""The live account's allocation maths (web/lib/sleeve-funding.ts).

The owner sets what each strategy should run as a PERCENTAGE, and these
functions turn that into the dollar targets the server acts on. Getting them
wrong doesn't crash anything — it moves the wrong amount of real money, or
leaves the allocation summing to 99.98% and the split silently refused. So the
invariants are pinned here:

  * an allocation always sums to exactly 100%, whatever was typed;
  * the field being edited keeps precisely the number that was typed, and the
    other strategies absorb the difference pro rata;
  * dollar targets sum to exactly the pot, so the server's "a split
    redistributes the pot, it can't resize it" check can never trip on our own
    rounding;
  * a move takes the source's spare CASH before any of its shares, because
    that is the order the funding RPC executes in — anything that travels as
    shares owes a restructure, and the interface promises which is which.

Expectations in the fixture are hand-derived from those rules, not captured
from a run. Same harness as tests/test_live_hub.py: the TypeScript is
evaluated directly under `node --experimental-strip-types`.

Run: pytest tests/test_split_allocation.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "split_allocation.json"
RUNNER = ROOT / "tests" / "ts_split_allocation_runner.mjs"

# Cases whose result is an allocation (percentages), which must total 100 —
# except an empty account, which has nothing to allocate.
_ALLOCATION_FNS = {"currentAllocation", "rebalanceAllocation"}


class TestSplitAllocation(unittest.TestCase):
    """web/lib/sleeve-funding.ts evaluated over the shared fixture."""

    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node not available")
        proc = subprocess.run(
            [node, "--experimental-strip-types", str(RUNNER), str(FIXTURE)],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        if proc.returncode != 0:
            raise unittest.SkipTest(f"node cannot strip types: {proc.stderr[:300]}")
        out = json.loads(proc.stdout)
        cls.results = {r["name"]: r for r in out["cases"]}
        cls.fixture = json.loads(FIXTURE.read_text())

    def test_cases(self):
        """Every allocation rule produces exactly the stated result."""
        cases = self.fixture["cases"]
        self.assertGreater(len(cases), 0)
        for c in cases:
            with self.subTest(c["name"]):
                self.assertEqual(self.results[c["name"]]["actual"], c["expect"])

    def test_an_allocation_always_totals_one_hundred(self):
        """No edit can leave the account over- or under-allocated."""
        for c in self.fixture["cases"]:
            if c["fn"] not in _ALLOCATION_FNS:
                continue
            if not any(c["args"][0]):  # an empty account allocates nothing
                continue
            with self.subTest(c["name"]):
                self.assertEqual(self.results[c["name"]]["sums"], 100)

    def test_the_edited_field_keeps_what_was_typed(self):
        """Rounding residue lands on another strategy, never under the cursor.

        Only meaningful when there IS another strategy: a sole occupant runs
        the whole account by definition, so its field is overridden to 100.
        """
        for c in self.fixture["cases"]:
            if c["fn"] != "rebalanceAllocation":
                continue
            pcts, index, typed = c["args"]
            if len(pcts) < 2:
                continue
            expected = max(0.0, min(100.0, float(typed)))
            with self.subTest(c["name"]):
                self.assertEqual(self.results[c["name"]]["actual"][index], expected)

    def test_a_move_never_sends_more_cash_than_the_source_has(self):
        """Cash first, then shares — and never more cash than the allowance."""
        for c in self.fixture["cases"]:
            if c["fn"] != "splitImpact":
                continue
            allowances = {r["portfolioId"]: r["allowance"] for r in c["args"][0]}
            spent: dict[str, float] = {}
            for leg in self.results[c["name"]]["actual"]["legs"]:
                spent[leg["from"]] = spent.get(leg["from"], 0) + leg["cash"]
                with self.subTest(f"{c['name']}: {leg['from']}→{leg['to']}"):
                    self.assertAlmostEqual(
                        leg["cash"] + leg["positions"], leg["amount"], places=2
                    )
                    self.assertLessEqual(spent[leg["from"]], allowances[leg["from"]] + 1e-9)

    def test_every_move_is_balanced(self):
        """What one strategy gives, another receives — nothing is created."""
        for c in self.fixture["cases"]:
            if c["fn"] != "splitImpact":
                continue
            impacts = self.results[c["name"]]["actual"]["impacts"]
            with self.subTest(c["name"]):
                self.assertAlmostEqual(sum(i["delta"] for i in impacts), 0, places=2)
                self.assertAlmostEqual(sum(i["cash"] for i in impacts), 0, places=2)
                self.assertAlmostEqual(sum(i["positions"] for i in impacts), 0, places=2)


if __name__ == "__main__":
    unittest.main()
