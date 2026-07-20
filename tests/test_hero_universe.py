#!/usr/bin/env python3
"""Homepage "fifty analysts" hero — stat-strip logic (web/lib/hero-universe.ts).

The strip shows one live number (the US-listed universe count, thousands
separated) and a data-compile snapshot date ("DD Mon YYYY"). Both are produced
by one pure TS module so they can be tested without Next/Supabase — this test
evaluates the shared fixture (tests/fixtures/hero_universe_cases.json) through
the real implementation under `node --experimental-strip-types` (same pattern
as tests/test_transforms.py).

Run: pytest tests/test_hero_universe.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "hero_universe_cases.json"
RUNNER = ROOT / "tests" / "ts_hero_universe_runner.mjs"


def _load_cases() -> list[dict]:
    return json.loads(FIXTURE.read_text())


class TestHeroUniverseLogic(unittest.TestCase):
    """web/lib/hero-universe.ts evaluated over the shared fixture."""

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
        self.assertEqual(fns, {"formatUniverseCount", "formatSnapshotDate"})


if __name__ == "__main__":
    unittest.main()
