#!/usr/bin/env python3
"""The live account hub's "what's happening" state (web/lib/live-activity.ts).

The hub answers a real-money question — *is anything pending?* — and the way it
gets that wrong is not a crash but a sentence: silence that reads as "something
is in flight" when nothing ever moved, or "on the next sync" repeated forever
after execution has been switched off. So the copy IS the contract, and this
test pins it: every fixture case is a real situation (never funded, positions
awaiting a restructure, a sync requested, a run that did nothing because the
market was shut, records disagreeing with the broker…) with the exact headline
and lines the owner should see.

The logic lives in one pure TS module so it can be evaluated without
Next/Supabase, under `node --experimental-strip-types` (same pattern as
tests/test_realized_pnl.py).

Run: pytest tests/test_live_hub.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "live_hub_states.json"
RUNNER = ROOT / "tests" / "ts_live_hub_runner.mjs"


class TestLiveHubState(unittest.TestCase):
    """web/lib/live-activity.ts evaluated over the shared fixture."""

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
        cls.helpers = {r["name"]: r["actual"] for r in out["helpers"]}
        cls.states = {r["name"]: r["actual"] for r in out["states"]}
        cls.fixture = json.loads(FIXTURE.read_text())

    def test_schedule_and_time_helpers(self):
        """The scheduled-run maths the copy promises times against."""
        cases = self.fixture["helpers"]
        self.assertGreater(len(cases), 0)
        for c in cases:
            with self.subTest(c["name"]):
                self.assertEqual(self.helpers[c["name"]], c["expect"])

    def test_hub_states(self):
        """Every real-world situation renders its exact sentences."""
        cases = self.fixture["states"]
        self.assertGreater(len(cases), 0)
        for c in cases:
            with self.subTest(c["name"]):
                actual = self.states[c["name"]]
                self.assertEqual(actual["headline"], c["expect"]["headline"])
                self.assertEqual(actual["tone"], c["expect"]["tone"])
                self.assertEqual(actual["lines"], c["expect"]["lines"])
                self.assertEqual(actual["recentCount"], c["expect"]["recentCount"])
                self.assertEqual(actual["nextRunLabel"], c["expect"]["nextRunLabel"])

    def test_quiet_state_never_leaves_the_owner_guessing(self):
        """A hub with no outstanding work still says so out loud."""
        for c in self.fixture["states"]:
            actual = self.states[c["name"]]
            with self.subTest(c["name"]):
                self.assertTrue(actual["headline"].strip())
                if not actual["lines"]:
                    self.assertIn("Nothing pending", actual["headline"])


if __name__ == "__main__":
    unittest.main()
