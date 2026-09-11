"""The public Universe summary on a portfolio page — and what it must not claim.

A leaderboard row says how a swarm did. The question it provokes is "out of
what?", and nothing public answered it: a book ranked on a 60-name washed-out
turnaround screen is doing something different from one fishing the whole
liquid US universe. `web/lib/portfolio-universe.ts` is the one-line answer.

The danger in a summary like this is not the arithmetic, it is the claim. Two
of them can be wrong in ways a reader cannot detect from the page:

  * A book whose only buyer is self-sourced (`double_down`, `pelosi_mirror`)
    still HAS a `screen_config` — every book is seeded one at creation — and
    would be described by a pond it never fishes. `showsUniverse` is what
    stops the card rendering there.
  * A book that runs BOTH kinds is described correctly by the screen and
    incorrectly by omission: the Double-Down Buyer's adds did not come through
    it. `selfSourcedLine` is the sentence that says so.

Both turn on classifying an agent by `agents.strategy`, never by its role tag
— `double_down` and `pelosi_mirror` are both tagged buy/buyer. So these tests
also pin the TypeScript classification against the Python registries that
actually run the heartbeat: a strategy that became self-sourced in
`agent_strategies.py` without the web lists learning about it is exactly how
the page would start describing the wrong thing.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tests" / "ts_portfolio_universe_runner.mjs"


def _run_ts() -> dict:
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


class _TsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = _run_ts()


class StrategyParityTests(_TsCase):
    """The web's idea of a self-sourced buyer must BE the heartbeat's."""

    def test_self_sourced_set_matches_agent_strategies(self):
        import agent_strategies
        self.assertEqual(
            self.out["kinds"]["selfSourced"],
            sorted(agent_strategies.SELF_SOURCED_BUYER_STRATEGIES),
        )

    def test_screen_buyers_are_real_registered_strategies(self):
        import agent_strategies
        for name in self.out["kinds"]["screenBuyers"]:
            self.assertIn(name, agent_strategies.STRATEGIES, name)

    def test_screen_buyers_are_not_self_sourced(self):
        import agent_strategies
        for name in self.out["kinds"]["screenBuyers"]:
            self.assertFalse(agent_strategies.is_self_sourced_buyer(name), name)

    def test_reviewers_are_real_registered_strategies(self):
        import agent_strategies
        for name in self.out["kinds"]["reviewers"]:
            self.assertIn(name, agent_strategies.STRATEGIES, name)

    def test_unknown_strategy_degrades_to_other(self):
        # A strategy the web has never heard of is listed by name elsewhere,
        # never described as a screen buyer on the strength of a role tag.
        self.assertEqual(self.out["kinds"]["unknown"], "other")
        self.assertEqual(self.out["kinds"]["nullStrategy"], "other")

    def test_double_down_never_drafts_from_the_screen(self):
        self.assertFalse(self.out["kinds"]["draftsDoubleDown"])
        self.assertTrue(self.out["kinds"]["draftsLlmBuyer"])


class VisibilityTests(_TsCase):
    """When the card is a true statement about the book, and when it isn't."""

    def test_renders_for_a_book_with_a_screen_buyer(self):
        self.assertTrue(self.out["shows"]["mixed"])

    def test_hidden_when_no_hired_buyer_reads_the_screen(self):
        # The Pelosi-only book: a screen_config exists, nothing drafts from it.
        self.assertFalse(self.out["shows"]["pelosiOnly"])

    def test_hidden_when_there_is_no_summary_at_all(self):
        # Fail-closed — a roster read that failed shows nothing, not a claim.
        self.assertFalse(self.out["shows"]["nullSummary"])


class CopyTests(_TsCase):
    """The sentences themselves — each carries a fact that is easy to lose."""

    def test_size_states_the_denominator(self):
        # "63" is narrow or broad depending on a total the reader lacks.
        self.assertEqual(self.out["size"]["full"], "63 of 3,142 names pass today")

    def test_size_survives_a_missing_total(self):
        self.assertEqual(self.out["size"]["noTotal"], "63 names pass today")
        self.assertEqual(self.out["size"]["singular"], "1 name passes today")

    def test_size_says_unavailable_rather_than_zero(self):
        # A failed count must never render as "0 names pass today".
        self.assertEqual(self.out["size"]["unavailable"], "size unavailable")

    def test_draft_line_names_the_depth_and_the_buyers(self):
        self.assertEqual(
            self.out["draft"]["one"],
            "The top 20 ranked names are offered to Buyer · Gemini each run.",
        )
        self.assertEqual(
            self.out["draft"]["three"],
            "The top 20 ranked names are offered to Buyer · Gemini, "
            "Buyer · Claude and Buyer · GPT-5 each run.",
        )

    def test_no_self_sourced_note_when_every_buyer_reads_the_screen(self):
        self.assertIsNone(self.out["selfSourced"]["none"])

    def test_self_sourced_note_names_the_feed_it_reads_instead(self):
        self.assertEqual(
            self.out["selfSourced"]["one"],
            "Double-Down Buyer (the portfolio's own current holdings) "
            "buys outside this screen.",
        )
        self.assertEqual(
            self.out["selfSourced"]["two"],
            "Double-Down Buyer (the portfolio's own current holdings) and "
            "Pelosi Tracker (a member of Congress's disclosed trades) "
            "buy outside this screen.",
        )


if __name__ == "__main__":
    unittest.main()
