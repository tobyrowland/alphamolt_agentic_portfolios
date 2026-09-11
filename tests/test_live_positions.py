"""What the live console says each sleeve holds, and what the mirror will do.

The owner, looking at the broker's own position list: "what are these small
rump shareholdings doing in the live account?" Three names — KRMN $104, TREX
$776, TRU $779 — sat untouched among fourteen positions of $2,200-$3,300. They
had two completely different explanations, and no surface distinguished them:

  * TREX and TRU are CORRECT. The paper book deliberately holds them at ~2.8%
    against 5.7-8.3% for everything else, so a third of the size is the right
    size. They are ~0.85pp under target, just inside the mirror's 1% band.
  * KRMN is STRANDED. It is not in the paper book at all — it arrived through
    an in-kind funding move (migration 084), which transfers share records
    without trading. Its target is zero, so the mirror wants it gone, but at
    0.26% of the sleeve it is inside the same band, so no ordinary run will
    ever sell it.

Both facts are computable, and `web/lib/live-positions.ts` computes them. The
danger is that it computes them with its OWN idea of "on target" — then the
console asserts something the system does not do, which is the exact failure
this console keeps having. So these tests pin the numbers against the real
sleeve AND pin the constants against alpaca_mirror.py itself.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tests" / "ts_live_positions_runner.mjs"


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


class MirrorParityTests(unittest.TestCase):
    """The console's thresholds must BE the mirror's, not resemble them."""

    @classmethod
    def setUpClass(cls):
        cls.consts = _run_ts()["constants"]

    def test_threshold_matches_alpaca_mirror(self):
        import alpaca_mirror
        self.assertEqual(self.consts["threshold"], alpaca_mirror.DEFAULT_THRESHOLD)

    def test_min_order_matches_alpaca_mirror(self):
        import alpaca_mirror
        self.assertEqual(self.consts["minOrderUsd"], alpaca_mirror.MIN_ORDER_USD)


class ScrappySleeveTests(unittest.TestCase):
    """The real book on the day the question was asked."""

    @classmethod
    def setUpClass(cls):
        out = _run_ts()
        cls.rows = out["rows"]
        cls.summary = out["summary"]
        cls.pending = out["pendingBuy"]
        cls.big_orphan = out["bigOrphan"]
        cls.big_orphan_summary = out["bigOrphanSummary"]

    # -- the two explanations, kept apart ---------------------------------
    def test_a_half_weight_name_is_not_flagged_as_stray(self):
        """TREX/TRU are on the paper book — small on purpose, not orphaned."""
        for t in ("TREX", "TRU"):
            with self.subTest(ticker=t):
                self.assertFalse(self.rows[t]["offBook"])

    def test_the_inherited_name_is_flagged(self):
        """KRMN is on no book: target zero, held anyway."""
        self.assertTrue(self.rows["KRMN"]["offBook"])
        self.assertEqual(self.rows["KRMN"]["targetWeight"], 0)

    def test_none_of_the_three_would_be_traded(self):
        """Why they persisted: every one is inside the 1% band.

        This is the fact the old console could not show, and the reason
        'the mirror ran fine' and 'KRMN is still there' were both true.
        """
        for t in ("TREX", "TRU", "KRMN"):
            with self.subTest(ticker=t):
                self.assertEqual(self.rows[t]["action"], "hold")
                self.assertEqual(self.rows[t]["reason"], "within_threshold")

    def test_the_drifts_are_the_real_ones(self):
        """~0.85pp for the half-weights, ~0.26pp for the orphan."""
        self.assertAlmostEqual(self.rows["TREX"]["drift"], 0.00854, places=4)
        self.assertAlmostEqual(self.rows["TRU"]["drift"], 0.00856, places=4)
        self.assertAlmostEqual(self.rows["KRMN"]["drift"], -0.00263, places=4)

    def test_stranded_value_is_reported_separately(self):
        """Off-book AND untradeable is its own category — the one needing a
        human. Counting it with the rest is how it stayed invisible."""
        self.assertEqual(self.summary["strandedCount"], 1)
        self.assertAlmostEqual(self.summary["strandedValue"], 103.80, places=2)

    def test_a_large_inherited_name_is_pending_not_stranded(self):
        """The in-kind move actually brought $17,451.64 across, not $104.

        A big enough orphan clears the 1% band, so the next mirror run sells it
        by itself. Counting every off-book dollar as "stranded" would raise a
        needs-a-human flag on a name the machine is already about to fix —
        the same over-flagging that put a permanent red warning on a converged
        sleeve once before.
        """
        self.assertTrue(self.big_orphan["offBook"])
        self.assertEqual(self.big_orphan["action"], "sell")
        self.assertEqual(self.big_orphan["reason"], "would_trade")
        self.assertEqual(self.big_orphan_summary["strandedCount"], 1)
        self.assertAlmostEqual(
            self.big_orphan_summary["strandedValue"], 103.80, places=2,
        )

    def test_a_converged_sleeve_reports_no_pending_trades(self):
        self.assertEqual(self.summary["wouldTrade"], 0)

    # -- a name the sleeve does not hold yet -------------------------------
    def test_a_wanted_name_never_bought_shows_as_a_pending_buy(self):
        """No price to size shares with, but the notional is still knowable."""
        self.assertEqual(self.pending["action"], "buy")
        self.assertAlmostEqual(self.pending["orderValue"], 1113.11, places=2)


class TargetWeightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = _run_ts()

    def test_paper_cash_is_in_the_denominator(self):
        """plan_mirror divides by total_value_usd, cash included.

        Normalising over holdings alone would overstate every target and make
        a fully converged sleeve read as permanently underweight.
        """
        self.assertEqual(self.out["cashHeavyTarget"], 0.8)

    def test_a_name_neither_held_nor_wanted_is_not_a_row(self):
        self.assertEqual(self.out["emptyRows"], [])


if __name__ == "__main__":
    unittest.main()
