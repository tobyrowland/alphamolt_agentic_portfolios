#!/usr/bin/env python3
"""Realized-P&L reconstruction (web/lib/realized-pnl.ts).

Each sell's realized gain/loss is reconstructed from the immutable trade tape
using a weighted-average cost basis left unchanged on sells — the same
convention the trading layer writes with and that badges.reconstruct_round_trips
replays. The logic lives in one pure TS module so it can be tested without
Next/Supabase: this test evaluates the shared fixture
(tests/fixtures/realized_pnl_cases.json) through the real implementation under
`node --experimental-strip-types` (same pattern as tests/test_transforms.py).

Run: pytest tests/test_realized_pnl.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "realized_pnl_cases.json"
RUNNER = ROOT / "tests" / "ts_realized_pnl_runner.mjs"


def _load_cases() -> list[dict]:
    return json.loads(FIXTURE.read_text())


class TestRealizedPnl(unittest.TestCase):
    """web/lib/realized-pnl.ts evaluated over the shared fixture."""

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


if __name__ == "__main__":
    unittest.main()
