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


def _run_ts() -> dict:
    """Evaluate the copy module through Node and return everything it exports.

    Shared by the test classes below rather than inherited: subclassing a
    TestCase to reuse its loader also re-runs every one of its tests.
    """
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node not available")
    proc = subprocess.run(
        [node, "--experimental-strip-types", str(RUNNER)],
        capture_output=True, text=True, cwd=ROOT,
    )
    if proc.returncode != 0:
        raise unittest.SkipTest(f"node cannot strip types: {proc.stderr[:300]}")
    return json.loads(proc.stdout)


class BrokerCashStatusCopyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = _run_ts()
        cls.notes = out["notes"]
        cls.tags = out["tags"]
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


class SpareCashLabelTests(unittest.TestCase):
    """The credit panel must name the pot the hub names, and show its size.

    Reported by the owner, with the panel open in front of them: "where is the
    spare cash to add?" The figure was $12,149.18, at the top of the hub, under
    a different word — while the panel was headed with the NAME of an amount
    and never showed it, despite already holding the number for its own
    disabled check.
    """

    @classmethod
    def setUpClass(cls):
        out = _run_ts()
        cls.spare_labels = out["spareLabels"]
        cls.ceilings = out["ceilings"]

    def test_it_shows_the_amount_next_to_the_input(self):
        label = self.spare_labels["typical"]
        self.assertIn("12,149.18", label)

    def test_it_uses_the_same_word_as_the_account_header(self):
        """One quantity, one name — the header says 'unassigned'."""
        for key in ("typical", "zero", "unknown", "whole"):
            with self.subTest(key=key):
                self.assertIn("UNASSIGNED", self.spare_labels[key])
                self.assertNotIn(
                    "SPARE", self.spare_labels[key].upper(),
                    "two names for one pot is what caused the question",
                )

    def test_an_unreadable_balance_shows_no_figure(self):
        """Never invent one — brokerCashNote explains this case."""
        self.assertEqual(self.spare_labels["unknown"], "UNASSIGNED CASH")
        self.assertNotIn("$", self.spare_labels["unknown"])

    def test_zero_is_shown_as_zero_not_hidden(self):
        self.assertIn("$0.00", self.spare_labels["zero"])

    def test_it_is_always_two_decimal_places(self):
        self.assertIn("$500.00", self.spare_labels["whole"])

    def test_an_empty_pot_says_what_to_do_instead(self):
        """A credit of anything would be refused server-side; say so first."""
        hint = self.ceilings["zero"]
        self.assertIsNotNone(hint)
        self.assertIn("nothing unassigned", hint)

    def test_a_funded_pot_carries_no_warning(self):
        self.assertIsNone(self.ceilings["typical"])
        self.assertIsNone(self.ceilings["unknown"])


if __name__ == "__main__":
    unittest.main()


class BrokerCashTagTests(unittest.TestCase):
    """The tag that sits where the missing number is.

    The full note shipped as 11px grey text at the foot of the panel, while the
    symptom — "broker cash —" — sat at the top in its own row. The answer was
    on the page and still invisible: the owner reloaded, looked at the dash,
    and reported seeing nothing. A diagnostic nobody's eye lands on is not a
    diagnostic, so the reason now sits beside the dash and the note is its
    tooltip.
    """

    @classmethod
    def setUpClass(cls):
        BrokerCashStatusCopyTests.setUpClass()
        cls.tags = BrokerCashStatusCopyTests.tags
        cls.notes = BrokerCashStatusCopyTests.notes

    def test_a_successful_read_shows_no_tag(self):
        self.assertIsNone(self.tags["ok"])

    def test_every_failure_is_tagged(self):
        for status in ("not_configured", "rejected", "unreachable"):
            with self.subTest(status):
                self.assertTrue(self.tags[status])

    def test_the_tags_are_distinct(self):
        failures = [self.tags[s] for s in
                    ("not_configured", "rejected", "unreachable")]
        self.assertEqual(len(set(failures)), 3, failures)

    def test_a_tag_is_short_enough_to_sit_on_one_line(self):
        """It shares a row with two figures — a sentence would wrap it."""
        for status, tag in self.tags.items():
            if tag is None:
                continue
            with self.subTest(status):
                self.assertLessEqual(len(tag), 16, tag)

    def test_the_rejected_tag_says_rejected_not_missing(self):
        self.assertIn("reject", self.tags["rejected"].lower())
