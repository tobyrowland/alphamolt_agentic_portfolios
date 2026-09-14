"""The sector cap as a constraint every buyer can see — and the churn guard.

Both exist because of one afternoon on the "Scrappy Fightback!" book, 11 Sep
2026::

    11:33  Sector Rebalancer  SELL BSY, CLBT, AGYS   Technology Services 48% -> under cap
                                                     realises -$9,700, frees ~$174k
    12:01  Double-Down Buyer  BUY  BAM, INTU, ...    spends that cash
                                   ^ Technology Services -> straight back over cap
    12:08  Sector Rebalancer  SELL INTU 47 @ 312.77  the same 47 shares, same price

Seven minutes, one swarm cycle. Two independent holes let it through, and each
alone is enough to reproduce it, so both are pinned here:

1. the cap lived only inside `swarm.snake_draft_plan`, and self-sourced buyers
   (which run FIRST) had no sector parameters at all — `plan_double_down`
   literally could not see it;
2. nothing stopped a reviewer from reversing, minutes later, a buy the same
   cycle had just made.

The numbers below are the real trade sizes and prices, so a regression reads
as the incident rather than as an abstraction.
"""
from __future__ import annotations

import unittest

from double_down import plan_double_down
from pelosi_mirror import plan_mirror
from sector_caps import SectorBudget, cap_pct_for_members
from swarm import Buyer, TradeCycle, snake_draft_plan

# The book as it stood at 12:01, rounded to the figures in the trade tape.
TOTAL_VALUE = 1_040_000.0
TECH_SERVICES = "Technology Services"


def _book(cash: float, holdings: list[tuple[str, float]]) -> dict:
    return {
        "total_value_usd": TOTAL_VALUE,
        "cash_usd": cash,
        "holdings": [
            {"ticker": t, "market_value_usd": v, "quantity": 1} for t, v in holdings
        ],
    }


class CapResolutionTests(unittest.TestCase):
    """Which cap binds, read off the hired team."""

    def test_no_rebalancer_means_no_cap(self):
        """A book that never hired one must behave exactly as it did before —
        None is the signal to leave every buyer unconstrained."""
        members = [{"agent": {"strategy": "llm_watchlist_buyer"}, "config": {}}]
        self.assertIsNone(cap_pct_for_members(members))

    def test_the_tightest_cap_wins(self):
        """A buyer respecting only the loosest would still breach the other."""
        members = [
            {"agent": {"strategy": "sector_rebalancer"}, "config": {"max_sector_pct": 40}},
            {"agent": {"strategy": "sector_rebalancer"}, "config": {"max_sector_pct": 25}},
        ]
        self.assertEqual(cap_pct_for_members(members), 25)

    def test_a_rebalancer_with_no_configured_cap_uses_its_default(self):
        members = [{"agent": {"strategy": "sector_rebalancer"}, "config": {}}]
        self.assertEqual(cap_pct_for_members(members), 30.0)

    def test_a_junk_cap_degrades_to_the_default(self):
        """Config is owner-edited JSON — it must never break a heartbeat."""
        members = [
            {"agent": {"strategy": "sector_rebalancer"}, "config": {"max_sector_pct": "wat"}},
        ]
        self.assertEqual(cap_pct_for_members(members), 30.0)


class SectorBudgetTests(unittest.TestCase):
    def test_an_unclassified_name_is_never_capped(self):
        """Refusing to buy on a missing `securities.gics_sector` row would
        silently shrink the universe every time reference data lagged."""
        budget = SectorBudget.from_book(_book(0, []), {}, cap_pct=30.0)
        self.assertIsNone(budget.headroom("NEWCO"))
        self.assertEqual(budget.cap_qty("NEWCO", 100, 10.0), 100)

    def test_headroom_is_seeded_from_what_the_book_already_holds(self):
        budget = SectorBudget.from_book(
            _book(0, [("AGYS", 200_000.0)]),
            {"AGYS": TECH_SERVICES, "INTU": TECH_SERVICES},
            cap_pct=30.0,
        )
        # 30% of 1.04M = 312,000; 200,000 already held.
        self.assertAlmostEqual(budget.headroom("INTU"), 112_000.0)

    def test_a_disabled_budget_is_the_identity(self):
        """cap_pct None (nobody hired) must not change a single quantity."""
        budget = SectorBudget.from_book(_book(0, []), {"INTU": TECH_SERVICES}, cap_pct=None)
        self.assertFalse(budget.enabled)
        self.assertEqual(budget.cap_qty("INTU", 47, 312.77), 47)
        self.assertFalse(budget.at_cap("INTU", 312.77))

    def test_recording_a_buy_moves_the_headroom_for_the_next_one(self):
        """Without this a planner spends the same headroom on every name."""
        budget = SectorBudget.from_book(
            _book(0, []), {"A": TECH_SERVICES, "B": TECH_SERVICES}, cap_pct=1.0,
        )
        self.assertAlmostEqual(budget.headroom("A"), 10_400.0)
        budget.record("A", 100, 100.0)
        self.assertAlmostEqual(budget.headroom("B"), 400.0)


class TheIntuRoundTripTests(unittest.TestCase):
    """The exact trade, through the planner that made it."""

    def _qualifying(self):
        return [{"ticker": "INTU", "conviction": 5, "rationale": "quality compounder"}]

    # One book for both tests below, so the ONLY difference between "the add
    # happens" and "the add is refused" is whether the planner was handed the
    # cap. Technology Services sits at exactly 30% of NAV — where the
    # Rebalancer had just put it — so there is no headroom at all.
    def _book_at_the_cap(self):
        return _book(80_000.0, [("INTU", 68_450.0), ("AGYS", 243_550.0)])

    def test_without_a_cap_the_add_happens_as_it_did(self):
        """The pre-fix behaviour, so the fix below is shown to be the cause."""
        book = self._book_at_the_cap()
        plan = plan_double_down(
            self._qualifying(), book, {"INTU": 312.77},
            add_position_pct=4.0, max_position_pct=8.0,
            cash_reserve_pct=0.02, min_add_usd=500.0,
        )
        self.assertEqual([b["ticker"] for b in plan.buys], ["INTU"])
        self.assertEqual(plan.buys[0]["qty"], 47)  # the real fill

    def test_with_the_cap_the_add_is_refused_with_a_sector_reason(self):
        """Technology Services was already at 30% of the book. The money should
        go somewhere else rather than be trimmed back seven minutes later."""
        book = self._book_at_the_cap()
        plan = plan_double_down(
            self._qualifying(), book, {"INTU": 312.77},
            add_position_pct=4.0, max_position_pct=8.0,
            cash_reserve_pct=0.02, min_add_usd=500.0,
            sector_budget=SectorBudget.from_book(
                book, {"INTU": TECH_SERVICES, "AGYS": TECH_SERVICES}, cap_pct=30.0,
            ),
        )
        self.assertEqual(plan.buys, [])
        self.assertIn(TECH_SERVICES, plan.skips[0]["reason"])
        # The reason must say *sector*, not *cash*: only one of those is fixed
        # by waiting, and the owner reads this.
        self.assertNotIn("cash", plan.skips[0]["reason"].lower())

    def test_partial_headroom_sizes_the_add_down_rather_than_refusing_it(self):
        """$20k of room on a $41.6k step buys what fits — the draft has always
        behaved this way and the self-sourced buyers now match it."""
        book = _book(80_000.0, [("INTU", 67_600.0), ("AGYS", 224_400.0)])
        plan = plan_double_down(
            self._qualifying(), book, {"INTU": 312.77},
            add_position_pct=4.0, max_position_pct=12.0,
            cash_reserve_pct=0.02, min_add_usd=500.0,
            sector_budget=SectorBudget.from_book(
                book, {"INTU": TECH_SERVICES, "AGYS": TECH_SERVICES}, cap_pct=30.0,
            ),
        )
        self.assertEqual(len(plan.buys), 1)
        self.assertEqual(plan.buys[0]["qty"], 63)  # floor(20_000 / 312.77)

    def test_a_name_in_another_sector_is_untouched(self):
        """The cap must not become a general brake — BAM (Finance) was a fine
        add on the same run and should still happen."""
        book = _book(80_000.0, [("BAM", 63_400.0), ("AGYS", 312_000.0)])
        plan = plan_double_down(
            [{"ticker": "BAM", "conviction": 5}], book, {"BAM": 47.24},
            add_position_pct=4.0, max_position_pct=8.0,
            cash_reserve_pct=0.02, min_add_usd=500.0,
            sector_budget=SectorBudget.from_book(
                book, {"BAM": "Finance", "AGYS": TECH_SERVICES}, cap_pct=30.0,
            ),
        )
        self.assertEqual([b["ticker"] for b in plan.buys], ["BAM"])


class MirrorCapTests(unittest.TestCase):
    """`pelosi_mirror` is the other self-sourced buyer — same blindness."""

    def _trade(self, ticker):
        return [{"id": 1, "ticker": ticker, "txn_type": "buy", "txn_date": "2026-09-10"}]

    def test_a_disclosure_into_a_full_sector_is_skipped_not_bought(self):
        book = _book(200_000.0, [("AGYS", 312_000.0)])
        plan = plan_mirror(
            self._trade("INTU"), book, {"INTU": 312.77},
            target_position_pct=5.0, cash_reserve_pct=0.02,
            min_trade_usd=500.0, max_positions=30,
            sector_budget=SectorBudget.from_book(
                book, {"INTU": TECH_SERVICES, "AGYS": TECH_SERVICES}, cap_pct=30.0,
            ),
        )
        self.assertEqual(plan.buys, [])
        self.assertIn(TECH_SERVICES, plan.skips[0]["reason"])

    def test_the_skipped_disclosure_is_still_logged_as_handled(self):
        """Every input trade id must land in exactly one bucket, or the mirror
        replays the same filing on every future run, forever."""
        book = _book(200_000.0, [("AGYS", 312_000.0)])
        plan = plan_mirror(
            self._trade("INTU"), book, {"INTU": 312.77},
            target_position_pct=5.0, cash_reserve_pct=0.02,
            min_trade_usd=500.0, max_positions=30,
            sector_budget=SectorBudget.from_book(
                book, {"INTU": TECH_SERVICES, "AGYS": TECH_SERVICES}, cap_pct=30.0,
            ),
        )
        self.assertEqual(plan.skips[0]["trade_ids"], [1])


class DraftStillRespectsTheCapTests(unittest.TestCase):
    """The draft was already correct; the refactor onto SectorBudget must not
    have changed it."""

    def test_the_draft_sizes_down_to_sector_headroom(self):
        plan = snake_draft_plan(
            [Buyer("b1", gate=1, max_per_name=0.10)],
            ["INTU"], {"INTU": 100.0}, 1_000_000.0, 500_000.0,
            convictions={"b1": {"INTU": 5}},
            sector_of={"INTU": TECH_SERVICES},
            sector_start_value={TECH_SERVICES: 280_000.0},
            max_sector_value=300_000.0,
        )
        self.assertEqual(len(plan.picks), 1)
        self.assertEqual(plan.picks[0].qty, 200)  # 20_000 of headroom / $100

    def test_no_cap_configured_leaves_the_draft_unchanged(self):
        plan = snake_draft_plan(
            [Buyer("b1", gate=1, max_per_name=0.10)],
            ["INTU"], {"INTU": 100.0}, 1_000_000.0, 500_000.0,
            convictions={"b1": {"INTU": 5}},
        )
        self.assertEqual(plan.picks[0].qty, 1000)


class TradeCycleTests(unittest.TestCase):
    """The second hole: a cycle that reverses itself."""

    def test_selling_a_name_bought_this_cycle_is_blocked(self):
        cycle = TradeCycle()
        cycle.record("buy", "INTU")
        reason = cycle.blocks("sell", "INTU")
        self.assertIsNotNone(reason)
        self.assertIn("INTU", reason)
        self.assertIn("bought", reason)

    def test_buying_a_name_sold_this_cycle_is_blocked(self):
        cycle = TradeCycle()
        cycle.record("sell", "INTU")
        self.assertIsNotNone(cycle.blocks("buy", "INTU"))

    def test_the_same_direction_twice_is_allowed(self):
        """Two buyers topping up one name, or two reviewers trimming it, are
        not reversals — the rule is deliberately narrow."""
        cycle = TradeCycle()
        cycle.record("buy", "INTU")
        self.assertIsNone(cycle.blocks("buy", "INTU"))
        cycle2 = TradeCycle()
        cycle2.record("sell", "BSY")
        self.assertIsNone(cycle2.blocks("sell", "BSY"))

    def test_an_untouched_name_is_never_blocked(self):
        cycle = TradeCycle()
        cycle.record("buy", "INTU")
        self.assertIsNone(cycle.blocks("sell", "BSY"))

    def test_tickers_are_matched_case_insensitively(self):
        cycle = TradeCycle()
        cycle.record("buy", "intu")
        self.assertIsNotNone(cycle.blocks("sell", "INTU"))

    def test_a_refusal_is_recorded_for_the_journal(self):
        """A blocked reversal is a decision the owner should be able to see."""
        cycle = TradeCycle()
        cycle.record("buy", "INTU")
        cycle.note_blocked("sell", "INTU", "agent-1", cycle.blocks("sell", "INTU"))
        self.assertEqual(len(cycle.blocked), 1)
        self.assertEqual(cycle.blocked[0]["ticker"], "INTU")
        self.assertEqual(cycle.blocked[0]["side"], "sell")


class ContextGuardTests(unittest.TestCase):
    """The guard where it actually sits — `RebalanceContext.buy/sell`.

    Put on the context rather than in each strategy so it covers every member
    of a swarm, including strategies not yet written. These use a stub manager
    rather than a DB: the question is whether the order is placed at all.
    """

    def _ctx(self, cycle, calls, result=None):
        from agent_strategies import RebalanceContext

        class _PM:
            def buy_portfolio_atomic(self, *a, **k):
                calls.append(("buy", a[2]))
                return result if result is not None else {"status": "ok"}

            def sell_portfolio_atomic(self, *a, **k):
                calls.append(("sell", a[2]))
                return result if result is not None else {"status": "ok"}

        return RebalanceContext(
            db=None, pm=_PM(), agent={"id": "a1"},
            portfolio_id="p1", cycle=cycle,
        )

    def test_the_reversal_never_reaches_the_broker(self):
        """The refusal is raised BEFORE the order, so a blocked trade writes
        nothing and — on a live book — places nothing."""
        from portfolio import CycleConflict

        cycle, calls = TradeCycle(), []
        ctx = self._ctx(cycle, calls)
        ctx.buy("INTU", 47)
        with self.assertRaises(CycleConflict):
            ctx.sell("INTU", 47)
        self.assertEqual(calls, [("buy", "INTU")])

    def test_a_cycle_of_none_changes_nothing(self):
        """The legacy 1:1 agent path passes no cycle and must be untouched."""
        calls = []
        ctx = self._ctx(None, calls)
        ctx.buy("INTU", 47)
        ctx.sell("INTU", 47)
        self.assertEqual(calls, [("buy", "INTU"), ("sell", "INTU")])

    def test_a_trade_the_db_refused_is_not_recorded_in_the_cycle(self):
        """The atomic RPCs RETURN a rejection rather than raising it. Counting
        one as a trade would block a legitimate later trade on something that
        never happened."""
        cycle, calls = TradeCycle(), []
        ctx = self._ctx(cycle, calls, result={"status": "insufficient_cash"})
        ctx.buy("INTU", 47)
        self.assertEqual(cycle.bought, set())
        self.assertIsNone(cycle.blocks("sell", "INTU"))

    def test_an_unfilled_live_order_is_not_recorded_either(self):
        """`filled_qty: 0` is what the live path returns for a rejected or
        market-closed order."""
        cycle, calls = TradeCycle(), []
        ctx = self._ctx(cycle, calls, result={"status": "alpaca_canceled", "filled_qty": 0})
        ctx.buy("INTU", 47)
        self.assertEqual(cycle.bought, set())


class HeartbeatWiringTests(unittest.TestCase):
    """Both fixes are inert unless the heartbeat hands them to every member.

    Everything above would still pass if `_run_portfolio_swarm` built the cycle
    and the cap and then forgot to put them on a `RebalanceContext`: the pure
    modules would be correct, the strategies would honour what they were given,
    and the swarm would go on behaving exactly as it did on 11 September. The
    self-sourced buyers are the ones that matter most and they are also the
    easiest to miss, because they are constructed in a loop of their own,
    forty lines before the draft.

    Driving the swarm for real needs a DB, a broker, a screen and a roster — a
    fixture heavy enough to rot — so this inspects the call STRUCTURE: every
    RebalanceContext built inside the swarm must pass both arguments.
    """

    @classmethod
    def setUpClass(cls):
        import ast
        import pathlib as _p

        root = _p.Path(__file__).resolve().parents[1]
        tree = ast.parse((root / "agent_heartbeat.py").read_text())
        swarm_fn = next(
            n for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name == "_run_portfolio_swarm"
        )
        cls.contexts = [
            n for n in ast.walk(swarm_fn)
            if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id == "RebalanceContext"
        ]

    def test_the_swarm_builds_several_contexts(self):
        """Self-sourced buyers, the draft's buys and the reviewers — if this
        drops to one, the assertions below stopped covering what they claim."""
        self.assertGreaterEqual(len(self.contexts), 3)

    def test_every_member_of_the_cycle_shares_the_same_cycle_object(self):
        for call in self.contexts:
            kwargs = {k.arg: k.value for k in call.keywords}
            self.assertIn("cycle", kwargs, "a swarm member was built without a cycle")

    def test_every_member_is_told_the_sector_cap(self):
        """The self-sourced buyers running FIRST are exactly the ones that were
        blind to it."""
        for call in self.contexts:
            kwargs = {k.arg: k.value for k in call.keywords}
            self.assertIn(
                "sector_cap_pct", kwargs,
                "a swarm member was built without the hired team's sector cap",
            )

    def test_the_cap_is_resolved_through_the_shared_helper(self):
        """Not re-derived inline from `max_sector_pct`: two readers of the same
        knob is how the draft and the buyers came to disagree in the first
        place."""
        source = (
            __import__("pathlib").Path(__file__).resolve().parents[1]
            / "agent_heartbeat.py"
        ).read_text()
        self.assertIn("cap_pct_for_members(member_rows)", source)


if __name__ == "__main__":
    unittest.main()
