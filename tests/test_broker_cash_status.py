#!/usr/bin/env python3
"""Why the website could not read the broker balance (web/lib/live-cash-status.ts).

`fetchBrokerCash` returned a bare `null` for three unrelated situations — no
keys configured, Alpaca rejecting the keys, and the call never completing — and
logged NOTHING on a non-OK response:

    if (!res.ok) return null;

So a 403 was indistinguishable from an unconfigured server, both in the UI and
in the server logs. The hub then asserted the cause it could not know ("This
server can't read your broker balance"), and that sentence sent a real
investigation looking for missing environment variables which were in fact
present. A diagnostic that names the WRONG cause is worse than one that says
nothing, so the copy is pinned here.

Run: pytest tests/test_broker_cash_status.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "tests" / "ts_broker_cash_status_runner.mjs"


class BrokerCashStatusCopyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node not available")
        proc = subprocess.run(
            [node, "--experimental-strip-types", str(RUNNER)],
            capture_output=True, text=True, cwd=ROOT,
        )
        if proc.returncode != 0:
            raise unittest.SkipTest(f"node cannot strip types: {proc.stderr[:300]}")
        out = json.loads(proc.stdout)
        cls.notes = out["notes"]
        cls.credit = out["creditBlocked"]

    def test_a_successful_read_explains_nothing(self):
        self.assertIsNone(self.notes["ok"])

    def test_each_failure_says_something_different(self):
        failures = [self.notes[s] for s in
                    ("not_configured", "rejected", "unreachable")]
        self.assertEqual(len(set(failures)), 3, failures)
        for note in failures:
            self.assertTrue(note and note.strip())

    def test_a_rejected_key_is_never_reported_as_a_missing_one(self):
        """The exact wrong turn: correct-looking vars, and we blamed their absence."""
        rejected = self.notes["rejected"]
        self.assertIn("rejected", rejected.lower())
        self.assertNotIn("no alpaca keys", rejected.lower())

    def test_the_rejected_note_names_the_likeliest_cause(self):
        """Alpaca issues separate credentials per endpoint; a key from one
        returns 403 against the other. That is the first thing to check."""
        rejected = self.notes["rejected"]
        self.assertIn("ALPACA_BASE_URL", rejected)
        self.assertIn("paper", rejected.lower())

    def test_the_unconfigured_note_still_says_keys_are_missing(self):
        self.assertIn("no alpaca keys", self.notes["not_configured"].lower())

    def test_a_transient_failure_is_not_blamed_on_configuration(self):
        unreachable = self.notes["unreachable"]
        self.assertNotIn("keys", unreachable.lower())
        self.assertIn("reach", unreachable.lower())

    def test_every_failure_leaves_the_owner_a_way_through(self):
        """Crediting is disabled in the UI — the CLI is not."""
        for status in ("not_configured", "rejected", "unreachable"):
            with self.subTest(status):
                self.assertIn("live_cash.py --credit", self.credit[status])

    def test_the_credit_refusal_carries_the_same_reason_as_the_panel(self):
        """One story, two places — they must not drift apart."""
        for status in ("not_configured", "rejected", "unreachable"):
            with self.subTest(status):
                self.assertIn(self.notes[status], self.credit[status])


if __name__ == "__main__":
    unittest.main()
