#!/usr/bin/env python3
"""The owner cash policy (migration 088) — how the shared pot is split.

WHY IT EXISTS. A portfolio's buyers share one cash pool and nothing allocated
it between them. `agent_heartbeat._run_portfolio_swarm` runs self-sourced
buyers (double_down) BEFORE the snake draft, and the draft then buys until cash
reaches its floor. So the draft always left ~2%, and the Double-Down Buyer
always arrived to find ~2% — it made ZERO trades in its entire life while the
screen buyer made 25 on the same book.

`swarm.snake_draft_plan` always accepted a `cash_reserve_pct`; the heartbeat
never passed one. This module is the missing half — somewhere for the owner to
set that number — so the tests here cover the pure resolution, the ONE unit
conversion (a percent where a fraction is expected is a 50x sizing error), the
draft actually honouring it, and the TS twin agreeing key-for-key.

Run: pytest tests/test_cash_policy.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import cash_policy as cp  # noqa: E402
import swarm as _swarm  # noqa: E402

RUNNER = ROOT / "tests" / "ts_cash_policy_runner.mjs"


class ResolveTests(unittest.TestCase):
    def test_empty_policy_is_the_pre_088_default(self):
        """`{}` must behave exactly as the draft did before the column."""
        self.assertEqual(cp.resolve_policy({})["reserve_pct"], 2.0)
        self.assertEqual(
            cp.reserve_fraction({}),
            2.0 / 100.0,
        )

    def test_the_default_matches_the_drafts_own_default(self):
        """If these drift, applying the migration silently changes behaviour."""
        import inspect
        sig = inspect.signature(_swarm.snake_draft_plan)
        self.assertEqual(
            sig.parameters["cash_reserve_pct"].default,
            cp.reserve_fraction({}),
        )

    def test_a_malformed_policy_never_raises(self):
        for raw in (None, [], "nope", 42, {"reserve_pct": "3"},
                    {"reserve_pct": True}, {"reserve_pct": None},
                    {"unknown": 1}):
            with self.subTest(raw=raw):
                self.assertEqual(cp.resolve_policy(raw), dict(cp.DEFAULTS))

    def test_out_of_range_values_are_clamped_not_rejected(self):
        self.assertEqual(cp.resolve_policy({"reserve_pct": 999})["reserve_pct"],
                         cp.MAX_RESERVE_PCT)
        self.assertEqual(cp.resolve_policy({"reserve_pct": -5})["reserve_pct"], 0.0)

    def test_zero_is_honoured_as_a_real_choice(self):
        """0 means "let the screen buyer use everything" — not "unset"."""
        self.assertEqual(cp.resolve_policy({"reserve_pct": 0})["reserve_pct"], 0.0)
        self.assertEqual(cp.reserve_fraction({"reserve_pct": 0}), 0.0)


class UnitConversionTests(unittest.TestCase):
    """A percent passed where a fraction is expected is a 50x sizing error."""

    def test_percent_and_fraction_are_not_the_same_number(self):
        policy = cp.resolve_policy({"reserve_pct": 3})
        self.assertEqual(cp.reserve_pct(policy), 3.0)
        self.assertEqual(cp.reserve_fraction(policy), 0.03)

    def test_reserve_usd_is_the_owners_percent_of_the_book(self):
        policy = cp.resolve_policy({"reserve_pct": 3})
        self.assertAlmostEqual(cp.reserve_usd(policy, 1_053_760.86), 31_612.83, places=2)

    def test_reserve_usd_is_zero_on_an_unvalued_book(self):
        for nav in (0, -1, None, "x"):
            with self.subTest(nav=nav):
                self.assertEqual(cp.reserve_usd(cp.DEFAULTS, nav), 0.0)


class DraftHonoursTheReserveTests(unittest.TestCase):
    """The reserve is only real if the draft actually stops at it."""

    BUYER = _swarm.Buyer(agent_id="a1", gate=5, max_per_name=0.065)

    def _plan(self, reserve_pct: float):
        return _swarm.snake_draft_plan(
            [self.BUYER], ["AAA", "BBB", "CCC"],
            {"AAA": 100.0, "BBB": 100.0, "CCC": 100.0},
            total_value=1_000_000.0, cash=100_000.0,
            cash_reserve_pct=cp.reserve_fraction({"reserve_pct": reserve_pct}),
            convictions={"a1": {"AAA": 5, "BBB": 5, "CCC": 5}},
        )

    def test_a_bigger_reserve_leaves_more_behind(self):
        low = self._plan(2.0)
        high = self._plan(9.0)
        self.assertGreater(high.cash_remaining, low.cash_remaining)

    def test_the_reserve_is_what_survives_the_draft(self):
        """9% of a $1M book = $90k held back; the draft may spend the other $10k."""
        plan = self._plan(9.0)
        self.assertGreaterEqual(plan.cash_remaining, 90_000.0)

    def test_zero_reserve_lets_the_draft_spend_it_all(self):
        plan = self._plan(0.0)
        self.assertLess(plan.cash_remaining, 100_000.0)


class PolicyForPortfolioTests(unittest.TestCase):
    class _DB:
        def __init__(self, row=None, boom=False):
            self.row, self.boom = row, boom

        def get_portfolio_by_id(self, pid):
            if self.boom:
                raise RuntimeError("no such column: cash_policy")
            return self.row

    def test_a_pre_088_database_falls_back_to_defaults(self):
        """A heartbeat must never abort because a policy could not be read."""
        self.assertEqual(
            cp.policy_for_portfolio(self._DB(boom=True), "pid"), dict(cp.DEFAULTS))

    def test_no_portfolio_is_defaults(self):
        self.assertEqual(cp.policy_for_portfolio(self._DB(), None), dict(cp.DEFAULTS))

    def test_a_stored_policy_is_resolved(self):
        db = self._DB(row={"cash_policy": {"reserve_pct": 4}})
        self.assertEqual(cp.policy_for_portfolio(db, "pid")["reserve_pct"], 4.0)


class HeartbeatWiringTests(unittest.TestCase):
    """The policy is inert unless the heartbeat actually passes it.

    Every other test here would still pass if `agent_heartbeat` dropped the
    `cash_reserve_pct=` argument: the module would resolve the owner's number
    correctly, the draft would honour a reserve it was given, and the draft
    would silently keep using its own 2% default. That is exactly the bug this
    migration exists to fix, so the wiring needs its own check.

    Driving `_run_portfolio_swarm` for real would need a DB, a broker, a screen
    and a full member roster — a fixture heavy enough to rot. So this inspects
    the call STRUCTURE instead: the argument must be passed, and its value must
    come from `cash_policy`. It does not prove the runtime number is right —
    `UnitConversionTests` and `DraftHonoursTheReserveTests` cover that.
    """

    @classmethod
    def setUpClass(cls):
        import ast
        source = (ROOT / "agent_heartbeat.py").read_text()
        tree = ast.parse(source)
        cls.ast = ast
        cls.calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "snake_draft_plan"
        ]

    def test_the_draft_is_called_exactly_once(self):
        """Two call sites would mean one could quietly miss the reserve."""
        self.assertEqual(len(self.calls), 1)

    def test_the_call_passes_a_cash_reserve(self):
        kwargs = {kw.arg for kw in self.calls[0].keywords}
        self.assertIn("cash_reserve_pct", kwargs)

    def test_the_reserve_comes_from_the_cash_policy_module(self):
        """A hardcoded literal here would ignore the owner's setting."""
        source = (ROOT / "agent_heartbeat.py").read_text()
        self.assertIn("_cash_policy.reserve_fraction(", source)
        self.assertIn("_cash_policy.policy_for_portfolio(", source)
        # And it must be the FRACTION helper — passing the percent would size
        # the reserve 50x too large and stop the draft buying anything.
        self.assertNotIn("_cash_policy.reserve_pct(", source)


class TsTwinTests(unittest.TestCase):
    """A key TypeScript doesn't know about is DELETED on the owner's next save."""

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
        cls.ts = json.loads(proc.stdout)

    def test_defaults_match_key_for_key(self):
        self.assertEqual(self.ts["defaults"], cp.DEFAULTS)

    def test_the_bound_matches(self):
        self.assertEqual(self.ts["max_reserve_pct"], cp.MAX_RESERVE_PCT)

    def test_resolution_agrees_case_for_case(self):
        expected = {
            "empty": {}, "null": None, "array": [1, 2],
            "over_max": {"reserve_pct": 999},
            "negative": {"reserve_pct": -5},
            "string": {"reserve_pct": "3"},
            "nan": {"reserve_pct": float("nan")},
            "ok": {"reserve_pct": 3.5},
        }
        for name, raw in expected.items():
            with self.subTest(name):
                self.assertEqual(self.ts["resolved"][name], cp.resolve_policy(raw))

    def test_the_collapsed_header_states_the_reserve_and_its_value(self):
        """"3%" means nothing until you see it is $31,612."""
        header = self.ts["headers"]["raised"]
        self.assertEqual(
            header["summary"], "3% held back for other agents ($31,613)")
        self.assertTrue(header["customised"])

    def test_the_default_header_is_not_marked_customised(self):
        self.assertFalse(self.ts["headers"]["defaults"]["customised"])

    def test_zero_reads_as_a_consequence_not_a_number(self):
        self.assertEqual(
            self.ts["headers"]["zero"]["summary"],
            "no cash held back — the screen buyer may spend it all")

    def test_a_book_with_no_valuation_still_states_the_percent(self):
        self.assertEqual(
            self.ts["headers"]["no_nav"]["summary"],
            "3% held back for other agents")


if __name__ == "__main__":
    unittest.main()
