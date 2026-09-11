"""The one money-moving verb: which action carries a move, and its ceiling.

The live hub used to offer three operations with three mental models — a
percentage stepper that re-split between strategies (a target, applied in a
second step, which moved the strategies you did not touch), a Credit box that
brought money in from the unassigned pot, and a Debit box that sent it back.
Two were hidden behind a disclosure and the visible one was the most complex.
The owner's verdict, with the panel open in front of them: "it's really hard."

They are one act — take an amount out of one bucket, put it in another — so the
UI offers one verb and `web/lib/money-move.ts` decides which of the three
existing server actions carries it. These are the rules that are easy to get
wrong, and they are invisible in the component.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tests" / "ts_money_move_runner.mjs"


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


class MoneyMoveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = _run_ts()
        cls.routes = out["routes"]
        cls.ceilings = out["ceilings"]
        cls.refusals = out["refusals"]
        cls.preview = out["preview"]
        cls.preview_none = out["previewNoAmount"]
        cls.explainers = out["explainers"]
        cls.headline = out["headline"]

    # -- routing ----------------------------------------------------------
    def test_each_pair_picks_the_right_server_action(self):
        self.assertEqual(self.routes["potToStrategy"]["kind"], "credit")
        self.assertEqual(self.routes["strategyToPot"]["kind"], "debit")
        self.assertEqual(self.routes["strategyToStrategy"]["kind"], "transfer")

    def test_a_transfer_names_both_sides(self):
        """credit/debit name one portfolio; a transfer needs two."""
        transfer = self.routes["strategyToStrategy"]
        self.assertEqual(transfer["fromPortfolioId"], "p-scrappy")
        self.assertEqual(transfer["toPortfolioId"], "p-house")

    def test_a_no_op_pair_routes_nowhere(self):
        """Kept here rather than in a disabled-button expression."""
        for key in ("sameBucket", "potToPot", "empty"):
            with self.subTest(key=key):
                self.assertIsNone(self.routes[key])

    # -- ceilings ---------------------------------------------------------
    def test_the_ceiling_is_a_property_of_the_route_not_the_bucket(self):
        """The same sleeve can move $1,360.48 or $27,599.99 — it depends where.

        To the pot it is cash-bounded: freeing money that is in shares would
        mean selling them, and a cash movement must never quietly become a
        trade. To another strategy the shares move in kind (migration 084), so
        the ceiling is the sleeve's whole equity.
        """
        self.assertEqual(self.ceilings["strategyToPot"], 1360.48)
        self.assertEqual(self.ceilings["strategyToStrategy"], 27599.99)

    def test_the_pot_is_all_spendable(self):
        self.assertEqual(self.ceilings["outOfPot"], 12149.18)

    def test_an_empty_bucket_can_move_nothing(self):
        self.assertEqual(self.ceilings["emptyStrategy"], 0)

    # -- refusals ---------------------------------------------------------
    def test_a_legal_move_is_not_refused(self):
        self.assertIsNone(self.refusals["fine"])
        self.assertIsNone(self.refusals["inKindWithinEquity"])

    def test_nothing_typed_is_not_an_error(self):
        """An empty field is not a mistake; do not shout at someone mid-type."""
        self.assertIsNone(self.refusals["nothingTyped"])

    def test_over_the_pot_says_what_the_pot_holds(self):
        self.assertIn("$12,149.18", self.refusals["overPot"])

    def test_a_cash_bounded_refusal_explains_the_shares(self):
        """The number alone would read as a bug: the sleeve is worth $27.6k."""
        msg = self.refusals["overCashToPot"]
        self.assertIn("$1,360.48", msg)
        self.assertIn("shares", msg)
        self.assertIn("won't sell", msg)

    def test_it_names_the_bucket_rather_than_saying_invalid(self):
        for key in ("overPot", "fromEmpty", "overCashToPot"):
            with self.subTest(key=key):
                self.assertRegex(
                    self.refusals[key], r"(Not assigned|Scrappy|Alphamolt)",
                )

    # -- preview ----------------------------------------------------------
    def test_it_shows_both_sides_after(self):
        """The thing the old UI never did: prove the move before committing."""
        after = {r["name"]: r["after"] for r in self.preview}
        self.assertEqual(after["Not assigned"], 7149.18)
        self.assertEqual(after["Scrappy Fightback!"], 32599.99)

    def test_the_preview_touches_only_the_two_buckets(self):
        """Listing the others unchanged would imply a move might touch them.

        This is the substantive difference from the percentage steppers, which
        moved every strategy you did not touch.
        """
        self.assertEqual(len(self.preview), 2)

    def test_no_amount_previews_nothing(self):
        self.assertEqual(self.preview_none, [])

    # -- the sentence that prevents the expensive misreading ---------------
    def test_every_route_says_nothing_is_traded(self):
        """Assigned is not invested. That is the misreading that costs money."""
        for key, text in self.explainers.items():
            with self.subTest(route=key):
                self.assertRegex(text, r"Nothing is (bought|sold|traded)")

    def test_the_in_kind_route_admits_shares_move(self):
        """It is the one route where positions change hands; say so."""
        self.assertIn("shares", self.explainers["transfer"])


class AccountHeadlineTests(unittest.TestCase):
    """The headline must not claim to cover money it cannot see."""

    @classmethod
    def setUpClass(cls):
        cls.headline = _run_ts()["headline"]

    def test_a_readable_balance_reports_the_whole_account(self):
        self.assertEqual(self.headline["known"]["amount"], 39749.17)
        self.assertEqual(self.headline["known"]["caption"], "at your broker")

    def test_an_unreadable_balance_narrows_the_claim(self):
        """The pot is unknown, so the account total is unknown — say less."""
        self.assertEqual(self.headline["unknown"]["amount"], 27599.99)
        self.assertEqual(self.headline["unknown"]["caption"], "in your strategies")
        self.assertNotIn("broker", self.headline["unknown"]["caption"])

    def test_a_genuinely_empty_pot_still_covers_the_account(self):
        """Zero is a known figure; only null is unknown."""
        self.assertEqual(self.headline["emptyPot"]["caption"], "at your broker")


if __name__ == "__main__":
    unittest.main()
