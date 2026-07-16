#!/usr/bin/env python3
"""Homepage "swarm manager" hero — stat-strip logic (web/lib/hero-stats.ts).

The stat strip's numbers are compiled from live data with hard rules from the
hero brief: quarter-vs-trailing-90d window selection (14-day minimum quarter
age), first-point-on-or-after-start return baselines, best-alpha-in-bps with
sign kept, the FOUNDING_COHORT_CAP=500 Stat A variant, and "DD Mon YYYY"
snapshot dating. All of it lives in one pure TS module so it can be tested
without Next/Supabase — this test evaluates the shared fixture
(tests/fixtures/hero_stats_cases.json) through the real implementation under
`node --experimental-strip-types` (same pattern as tests/test_transforms.py).

Run: pytest tests/test_hero_stats.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "hero_stats_cases.json"
RUNNER = ROOT / "tests" / "ts_hero_stats_runner.mjs"


def _load_cases() -> list[dict]:
    return json.loads(FIXTURE.read_text())


class TestHeroStatsLogic(unittest.TestCase):
    """web/lib/hero-stats.ts evaluated over the shared fixture."""

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
            raise unittest.SkipTest(f"node cannot strip types: {proc.stderr[:200]}")
        cls.actuals = {r["name"]: r["actual"] for r in json.loads(proc.stdout)}

    def test_fixture_cases(self):
        cases = _load_cases()
        self.assertGreater(len(cases), 0)
        for c in cases:
            with self.subTest(c["name"]):
                self.assertIn(c["name"], self.actuals)
                self.assertEqual(self.actuals[c["name"]], c["expected"])

    def test_fixture_covers_every_rule(self):
        # Guard against the fixture silently losing a rule family.
        fns = {c["fn"] for c in _load_cases()}
        self.assertEqual(
            fns,
            {
                "resolveAlphaWindow",
                "windowReturnPct",
                "bestAlphaBps",
                "formatBps",
                "statAVariant",
                "formatSnapshotDate",
            },
        )


if __name__ == "__main__":
    unittest.main()
