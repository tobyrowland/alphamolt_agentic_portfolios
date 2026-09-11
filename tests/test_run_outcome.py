#!/usr/bin/env python3
"""The live run panel's completion summary (web/lib/run-outcome.ts).

The panel is generic across the whole agent library, but the summary it
shipped with was buy-agent-shaped: it always printed a buy count and a pass
count and mentioned sells only when there were some. So a Portfolio Review
Agent — which can ONLY sell — finished a clean run and told its owner

    Run complete in 1:53 — 0 buys, 0 passes.

two numbers describing work it cannot do, and silence on the one outcome it
can produce. The same asymmetry made the chip row read "0 bought · 1 sold ·
0 passed" after a real sale.

Nothing crashed, so nothing caught it — the defect IS the sentence. Hence this
test: every case is a real run shape (a reviewer with nothing to do, a reviewer
that sold, a buyer that passed on everything, a full swarm round) pinned to the
exact words and chips it should produce.

Same pattern as tests/test_live_hub.py: the logic lives in one pure TS module
so it can be evaluated without Next, under `node --experimental-strip-types`.

Run: pytest tests/test_run_outcome.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "run_outcomes.json"
RUNNER = ROOT / "tests" / "ts_run_outcome_runner.mjs"


class TestRunOutcomeSummary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node not available")
        proc = subprocess.run(
            [node, "--experimental-strip-types", str(RUNNER), str(FIXTURE)],
            capture_output=True, text=True, cwd=ROOT,
        )
        if proc.returncode != 0:
            raise unittest.SkipTest(f"node cannot strip types: {proc.stderr[:300]}")
        cls.actual = {c["name"]: c for c in json.loads(proc.stdout)["cases"]}
        cls.expected = json.loads(FIXTURE.read_text())["cases"]

    def test_every_case_produces_the_expected_sentence(self):
        for case in self.expected:
            with self.subTest(case["name"], why=case["why"]):
                got = self.actual[case["name"]]
                self.assertEqual(got["sentence"], case["sentence"])

    def test_every_case_produces_the_expected_chips(self):
        for case in self.expected:
            with self.subTest(case["name"], why=case["why"]):
                got = self.actual[case["name"]]
                self.assertEqual(got["chips"], case["chips"])

    def test_an_outcome_that_did_not_happen_is_never_mentioned(self):
        """The defect in one assertion: no zero ever reaches the owner."""
        for case in self.expected:
            with self.subTest(case["name"]):
                got = self.actual[case["name"]]
                self.assertNotIn(" 0 ", f" {got['sentence']} ")
                for chip in got["chips"]:
                    self.assertFalse(
                        chip["chip"].startswith("0 "), chip["chip"],
                    )

    def test_a_run_that_did_nothing_still_says_something(self):
        """Silence is ambiguous; 'no changes' is a result."""
        self.assertEqual(
            self.actual["reviewer_clean_run"]["sentence"],
            "Run complete in 1:53 — no changes.",
        )


if __name__ == "__main__":
    unittest.main()
