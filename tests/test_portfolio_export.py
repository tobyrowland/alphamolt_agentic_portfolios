"""The portfolio review pack — a book rendered for a DIFFERENT model to critique.

The point of the export is that someone pastes it into another model and asks
"what do you think?". That makes it a document whose failures are all failures
of honesty rather than of formatting:

  * omit the closed positions and it describes a portfolio that never existed,
    inviting praise for the survivors while hiding what was cut;
  * call day-old closing marks "current" and the reviewer reasons about a move
    that has already happened;
  * say a healthy break signal "cannot be evaluated" and the reviewer is told
    something plainly false about the sell discipline.

These pin the content that makes the review worth having, not the layout.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tests" / "ts_portfolio_export_runner.mjs"


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


class ReviewPackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = _run_ts()
        cls.doc = out["doc"]
        cls.empty = out["empty"]
        cls.filename = out["filename"]
        cls.zero_weight = out["zeroWeight"]

    # -- the honesty requirements -----------------------------------------
    def test_it_says_the_prices_are_closes_not_live(self):
        """Marks are close-to-close. A reviewer told these are current quotes
        reasons about the wrong day."""
        self.assertIn("2026-09-01", self.doc)
        self.assertIn("not live quotes", self.doc)

    def test_closed_positions_and_their_losses_are_included(self):
        """ADMA lost $430.50 and is gone. An export of survivors only is a
        different portfolio."""
        self.assertIn("Closed positions", self.doc)
        self.assertIn("ADMA", self.doc)
        self.assertIn("-$430.50", self.doc)

    def test_a_realised_loss_is_shown_on_the_sell_itself(self):
        self.assertIn("realised -$430.50", self.doc)

    def test_it_states_this_is_paper_money(self):
        self.assertIn("no real money", self.doc)

    # -- the signal tri-state ---------------------------------------------
    def test_a_firing_break_signal_is_called_out(self):
        """The reviewer's first question is which theses are already broken."""
        self.assertIn("`rev_growth_ttm_pct < 32`", self.doc)
        self.assertIn("FIRING NOW", self.doc)

    def test_an_unevaluable_signal_says_so(self):
        """price_pct_of_52w_high has no snapshot data, so this tripwire can
        never trip. Showing it as an ordinary signal would overstate the
        discipline actually in force."""
        self.assertIn("cannot be evaluated", self.doc)

    def test_an_unchecked_signal_is_not_called_unevaluable(self):
        """The bug this caught: `firing` absent means NOT CHECKED, and `== null`
        conflated it with null, labelling a healthy extend signal as impossible
        to evaluate — telling the reviewer something false."""
        line = next(
            ln for ln in self.doc.splitlines()
            if "rev_growth_ttm_pct > 30" in ln
        )
        self.assertNotIn("cannot be evaluated", line)
        self.assertNotIn("FIRING", line)

    # -- what makes the critique possible at all ---------------------------
    def test_the_strategy_comes_before_the_positions(self):
        """Handed 16 tickers a reviewer can only discuss 16 tickers. The
        mandate has to arrive first for 'does this match the strategy' to be
        answerable."""
        self.assertLess(self.doc.index("## Strategy"), self.doc.index("## Positions"))
        self.assertIn("fallen hard and are fighting back", self.doc)

    def test_the_sell_rules_are_prose_not_json(self):
        """`{"require_fired_break_signal": true}` is not reviewable."""
        self.assertIn("first **30 days**", self.doc)
        self.assertIn("requires a recorded break signal", self.doc)
        self.assertNotIn("require_fired_break_signal", self.doc)

    # -- the universe ------------------------------------------------------
    def test_the_screen_comes_before_the_positions(self):
        """A reviewer that sees the filter first can ask whether the book
        reflects it. Seeing the holdings first, it can only take them as given.
        """
        self.assertLess(
            self.doc.index("## Universe"), self.doc.index("## Positions"),
        )

    def test_the_filters_are_listed_in_the_owners_own_words(self):
        """Same labels as the Universe tab's chips (screenFilterLabel), so the
        pack and the page never describe one screen two ways."""
        self.assertIn("Drawdown from 52w high ≥ 30%", self.doc)
        self.assertIn("OR", self.doc)

    def test_the_ranking_weights_are_shown(self):
        self.assertIn("inflection 60%", self.doc)

    def test_a_zero_weight_lens_is_not_listed(self):
        """A lens at 0% contributes nothing to the rank. Printing
        'inflection 0%' invites a reviewer to comment on a lens that is off."""
        line = next(
            ln for ln in self.zero_weight.splitlines() if "Ranked by" in ln
        )
        self.assertIn("momentum 30%", line)
        self.assertNotIn("inflection", line)

    def test_the_candidate_cap_is_stated(self):
        """Only the top N reach the buyer. Without this a reviewer assumes the
        whole ranked universe was considered."""
        self.assertIn("top **40**", self.doc)

    def test_it_says_passed_names_are_hidden(self):
        """Explains an absence a reviewer would otherwise read as an oversight."""
        self.assertIn("hidden for ~30 days", self.doc)

    def test_a_portfolio_with_no_screen_omits_the_section(self):
        self.assertNotIn("## Universe", self.empty)

    def test_each_trade_carries_the_agents_own_reason(self):
        self.assertIn("Double-down 5/5", self.doc)
        self.assertIn("Thesis broken.", self.doc)

    def test_holdings_carry_cost_value_weight_and_purchase_date(self):
        for fragment in ("$162.63", "$63,061.50", "6.08%", "2026-07-20", "425"):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, self.doc)

    def test_it_suggests_what_to_ask(self):
        """Without prompts the likely question is 'thoughts?', which gets a
        generic answer from any model."""
        self.assertIn("Questions worth asking", self.doc)


class EmptyBookTests(unittest.TestCase):
    """A brand-new portfolio must still produce a valid document."""

    @classmethod
    def setUpClass(cls):
        cls.empty = _run_ts()["empty"]

    def test_it_renders_without_holdings_or_trades(self):
        self.assertIn("## Positions", self.empty)
        self.assertIn("None.", self.empty)

    def test_it_omits_sections_it_has_no_data_for(self):
        """An empty 'Closed positions' table reads as a claim that nothing was
        ever sold badly; absence of the heading does not."""
        self.assertNotIn("Closed positions", self.empty)
        self.assertNotIn("Every trade", self.empty)

    def test_the_staleness_line_survives_a_missing_date(self):
        self.assertIn("closing marks", self.empty)


class FilenameTests(unittest.TestCase):
    def test_it_is_dated_and_slugged(self):
        self.assertEqual(_run_ts()["filename"], "portfolio-2-portfolio-2026-09-02.md")


if __name__ == "__main__":
    unittest.main()
