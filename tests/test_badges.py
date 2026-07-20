#!/usr/bin/env python3
"""Unit tests for the badge awarding engine (``badges.py``).

Every badge condition is exercised as a pure function over plain dicts — no
database, no prices API, no LLM. Mirrors the offline decision-core style of
``tests/test_double_down.py`` / ``tests/test_swarm.py``.

Run: pytest tests/test_badges.py
"""

from __future__ import annotations

import datetime as dt
import unittest

import badges
from badges import (
    PeriodStanding,
    PortfolioData,
    aligned_series,
    eval_compounder,
    eval_dark_horse,
    eval_diamond_conviction,
    eval_escape_velocity,
    eval_falling_knife,
    eval_full_deployment,
    eval_molt,
    eval_set_and_forget,
    eval_sniper,
    eval_streaks,
    eval_tuition_paid,
    evaluate_portfolio,
    period_bounds,
    period_id,
    rank_period,
    reconstruct_round_trips,
)

D = dt.date


def _day(n: int) -> dt.date:
    """A weekday-ish sequential date generator anchored at a Monday."""
    return dt.date(2026, 1, 5) + dt.timedelta(days=n)


def _hist(values, cash=None, num=10, start=None):
    """Build a history list from a value series. cash defaults to 1% of value."""
    start = start or dt.date(2026, 1, 5)
    out = []
    for i, v in enumerate(values):
        c = cash[i] if cash is not None else v * 0.01
        out.append({
            "date": start + dt.timedelta(days=i),
            "total_value": v,
            "cash": c,
            "holdings_value": v - c,
            "num_positions": num,
        })
    return out


def _spy(values, start=None):
    start = start or dt.date(2026, 1, 5)
    return {start + dt.timedelta(days=i): v for i, v in enumerate(values)}


class TestAlphaBadges(unittest.TestCase):
    def test_molt_grants_on_30_up_days(self):
        # Portfolio rises 1%/day; SPY flat -> positive daily alpha every day.
        vals = [1_000_000 * (1.01 ** i) for i in range(31)]
        spy = [100.0] * 31
        aligned = aligned_series(_hist(vals), _spy(spy))
        spec = eval_molt(aligned)
        self.assertIsNotNone(spec)
        self.assertEqual(spec.slug, "molt")
        self.assertGreaterEqual(spec.context["days"], 30)

    def test_molt_streak_breaks_below_30(self):
        # 20 up days, one down day, 20 up days -> longest streak 20 < 30.
        vals = [1_000_000.0]
        for _ in range(20):
            vals.append(vals[-1] * 1.01)
        vals.append(vals[-1] * 0.90)  # a down day vs flat SPY
        for _ in range(20):
            vals.append(vals[-1] * 1.01)
        spy = [100.0] * len(vals)
        aligned = aligned_series(_hist(vals), _spy(spy))
        self.assertIsNone(eval_molt(aligned))

    def test_molt_needs_to_beat_spy_not_just_rise(self):
        # Portfolio +1%/day but SPY +2%/day -> negative alpha, no molt.
        vals = [1_000_000 * (1.01 ** i) for i in range(31)]
        spy = [100 * (1.02 ** i) for i in range(31)]
        aligned = aligned_series(_hist(vals), _spy(spy))
        self.assertIsNone(eval_molt(aligned))

    def test_escape_velocity(self):
        # Portfolio +30%, SPY +0% -> +30% cumulative alpha >= 25%.
        vals = [1_000_000.0, 1_300_000.0]
        spy = [100.0, 100.0]
        spec = eval_escape_velocity(aligned_series(_hist(vals), _spy(spy)))
        self.assertIsNotNone(spec)
        self.assertAlmostEqual(spec.context["cumulative_alpha_pct"], 30.0, places=1)

    def test_escape_velocity_not_enough(self):
        vals = [1_000_000.0, 1_200_000.0]  # +20% vs SPY flat -> 20% < 25%
        spy = [100.0, 100.0]
        self.assertIsNone(eval_escape_velocity(aligned_series(_hist(vals), _spy(spy))))

    def test_compounder_four_quarters(self):
        # One aligned point per quarter close for 5 quarters; portfolio beats
        # SPY every step.
        aligned = []
        pv, sv = 1_000_000.0, 100.0
        # Quarter-close dates across 2025Q4..2026Q4
        dates = [D(2025, 12, 31), D(2026, 3, 31), D(2026, 6, 30),
                 D(2026, 9, 30), D(2026, 12, 31)]
        for i, d in enumerate(dates):
            if i > 0:
                pv *= 1.05
                sv *= 1.01
            aligned.append((d, pv, sv))
        spec = eval_compounder(aligned)
        self.assertIsNotNone(spec)
        self.assertEqual(len(spec.context["quarters"]), 4)

    def test_compounder_breaks_on_a_miss(self):
        aligned = []
        pv, sv = 1_000_000.0, 100.0
        dates = [D(2025, 12, 31), D(2026, 3, 31), D(2026, 6, 30),
                 D(2026, 9, 30), D(2026, 12, 31)]
        for i, d in enumerate(dates):
            if i > 0:
                # miss on the 3rd quarter
                pv *= 0.99 if i == 3 else 1.05
                sv *= 1.01
            aligned.append((d, pv, sv))
        self.assertIsNone(eval_compounder(aligned))


class TestProcessBadges(unittest.TestCase):
    def test_full_deployment(self):
        vals = [1_000_000.0] * 30
        cash = [10_000.0] * 30  # 1% < 5% for 30 days
        spec = eval_full_deployment(_hist(vals, cash=cash))
        self.assertIsNotNone(spec)
        self.assertGreaterEqual(spec.context["days"], 30)

    def test_full_deployment_breaks_on_cash_spike(self):
        vals = [1_000_000.0] * 40
        cash = [10_000.0] * 20 + [200_000.0] + [10_000.0] * 19  # 20% spike day 20
        self.assertIsNone(eval_full_deployment(_hist(vals, cash=cash)))

    def test_sniper_fires_after_dry_spell(self):
        trades = [
            {"ticker": "AAA", "side": "buy", "quantity": 1, "price": 10,
             "date": D(2026, 1, 1), "rules_based": True},
            {"ticker": "BBB", "side": "buy", "quantity": 1, "price": 10,
             "date": D(2026, 3, 20), "rules_based": True},  # 78 days later
        ]
        spec = eval_sniper(trades)
        self.assertIsNotNone(spec)
        self.assertGreaterEqual(spec.context["dry_days"], 60)

    def test_sniper_ignores_non_rules_agents(self):
        trades = [
            {"ticker": "AAA", "side": "buy", "quantity": 1, "price": 10,
             "date": D(2026, 1, 1), "rules_based": False},
            {"ticker": "BBB", "side": "buy", "quantity": 1, "price": 10,
             "date": D(2026, 6, 1), "rules_based": False},
        ]
        self.assertIsNone(eval_sniper(trades))


class TestRoundTrips(unittest.TestCase):
    def test_simple_round_trip(self):
        trades = [
            {"ticker": "NVDA", "side": "buy", "quantity": 10, "price": 100.0,
             "date": D(2026, 1, 1)},
            {"ticker": "NVDA", "side": "sell", "quantity": 10, "price": 150.0,
             "date": D(2026, 2, 1)},
        ]
        rts = reconstruct_round_trips(trades)
        self.assertEqual(len(rts), 1)
        rt = rts[0]
        self.assertAlmostEqual(rt.entry_avg_cost, 100.0)
        self.assertAlmostEqual(rt.realized_return, 0.5)
        self.assertEqual(rt.open_date, D(2026, 1, 1))
        self.assertEqual(rt.close_date, D(2026, 2, 1))

    def test_weighted_average_and_partial(self):
        # Buy 10@100, buy 10@200 (avg 150), sell 5@180, sell 15@180 -> close.
        trades = [
            {"ticker": "X", "side": "buy", "quantity": 10, "price": 100.0,
             "date": D(2026, 1, 1)},
            {"ticker": "X", "side": "buy", "quantity": 10, "price": 200.0,
             "date": D(2026, 1, 2)},
            {"ticker": "X", "side": "sell", "quantity": 5, "price": 180.0,
             "date": D(2026, 1, 3)},
            {"ticker": "X", "side": "sell", "quantity": 15, "price": 180.0,
             "date": D(2026, 1, 4)},
        ]
        rts = reconstruct_round_trips(trades)
        self.assertEqual(len(rts), 1)
        # cost basis = 20 * 150 = 3000; proceeds = 20 * 180 = 3600.
        self.assertAlmostEqual(rts[0].entry_avg_cost, 150.0)
        self.assertAlmostEqual(rts[0].realized_pnl, 600.0)
        self.assertAlmostEqual(rts[0].realized_return, 0.2)

    def test_open_position_not_emitted(self):
        trades = [
            {"ticker": "X", "side": "buy", "quantity": 10, "price": 100.0,
             "date": D(2026, 1, 1)},
        ]
        self.assertEqual(reconstruct_round_trips(trades), [])


class TestHonestyBadges(unittest.TestCase):
    def test_tuition_paid_first_big_loss(self):
        rts = reconstruct_round_trips([
            {"ticker": "A", "side": "buy", "quantity": 1, "price": 100.0,
             "date": D(2026, 1, 1)},
            {"ticker": "A", "side": "sell", "quantity": 1, "price": 95.0,
             "date": D(2026, 1, 10)},   # -5% (not enough)
            {"ticker": "B", "side": "buy", "quantity": 1, "price": 100.0,
             "date": D(2026, 2, 1)},
            {"ticker": "B", "side": "sell", "quantity": 1, "price": 80.0,
             "date": D(2026, 2, 10)},   # -20% -> tuition
        ])
        spec = eval_tuition_paid(rts)
        self.assertIsNotNone(spec)
        self.assertEqual(spec.context["ticker"], "B")
        self.assertAlmostEqual(spec.context["loss_pct"], -20.0)

    def test_diamond_conviction(self):
        rts = reconstruct_round_trips([
            {"ticker": "Z", "side": "buy", "quantity": 1, "price": 100.0,
             "date": D(2026, 1, 1)},
            {"ticker": "Z", "side": "sell", "quantity": 1, "price": 120.0,
             "date": D(2026, 3, 1)},  # +20% realized
        ])
        # Price dipped to 70 (30% drawdown) mid-hold.
        series = {D(2026, 1, 15): 70.0, D(2026, 2, 1): 90.0, D(2026, 3, 1): 120.0}
        spec = eval_diamond_conviction(rts, lambda t: series)
        self.assertIsNotNone(spec)
        self.assertGreaterEqual(spec.context["max_drawdown_pct"], 20.0)

    def test_diamond_needs_profitable_close(self):
        rts = reconstruct_round_trips([
            {"ticker": "Z", "side": "buy", "quantity": 1, "price": 100.0,
             "date": D(2026, 1, 1)},
            {"ticker": "Z", "side": "sell", "quantity": 1, "price": 60.0,
             "date": D(2026, 3, 1)},  # closed at a loss
        ])
        series = {D(2026, 1, 15): 50.0}
        self.assertIsNone(eval_diamond_conviction(rts, lambda t: series))

    def test_falling_knife(self):
        rts = reconstruct_round_trips([
            {"ticker": "K", "side": "buy", "quantity": 1, "price": 40.0,
             "date": D(2026, 1, 1)},
            {"ticker": "K", "side": "sell", "quantity": 1, "price": 60.0,
             "date": D(2026, 6, 1)},  # +50% realized
        ])
        # 52w high before entry was 100 -> bought at 40 = 60% discount.
        series = {D(2025, 6, 1): 100.0, D(2026, 1, 1): 40.0}
        spec = eval_falling_knife(rts, lambda t: series)
        self.assertIsNotNone(spec)
        self.assertGreaterEqual(spec.context["discount_to_52w_high_pct"], 50.0)

    def test_falling_knife_needs_big_gain(self):
        rts = reconstruct_round_trips([
            {"ticker": "K", "side": "buy", "quantity": 1, "price": 40.0,
             "date": D(2026, 1, 1)},
            {"ticker": "K", "side": "sell", "quantity": 1, "price": 44.0,
             "date": D(2026, 6, 1)},  # +10% only
        ])
        series = {D(2025, 6, 1): 100.0, D(2026, 1, 1): 40.0}
        self.assertIsNone(eval_falling_knife(rts, lambda t: series))


class TestSwarmBadges(unittest.TestCase):
    def test_set_and_forget(self):
        # 70 up days, no manual trades -> a manual-free 60-day window with +alpha.
        vals = [1_000_000 * (1.005 ** i) for i in range(70)]
        spy = [100.0] * 70
        aligned = aligned_series(_hist(vals), _spy(spy))
        spec = eval_set_and_forget(aligned, trades=[])
        self.assertIsNotNone(spec)

    def test_set_and_forget_blocked_by_manual_trade(self):
        vals = [1_000_000 * (1.005 ** i) for i in range(70)]
        spy = [100.0] * 70
        aligned = aligned_series(_hist(vals), _spy(spy))
        # A manual trade in the middle contaminates every 60-day window.
        trades = [{"ticker": "X", "side": "sell", "manual": True,
                   "date": _day(35)}]
        self.assertIsNone(eval_set_and_forget(aligned, trades))

    def test_streaks(self):
        hbs = [{"date": D(2026, 1, 1) + dt.timedelta(days=i), "status": "ok"}
               for i in range(25)]
        specs = {s.slug for s in eval_streaks(hbs)}
        self.assertIn("streak_10", specs)
        self.assertIn("streak_25", specs)
        self.assertNotIn("streak_50", specs)

    def test_streak_broken_by_error(self):
        hbs = [{"date": D(2026, 1, 1) + dt.timedelta(days=i), "status": "ok"}
               for i in range(12)]
        hbs.append({"date": D(2026, 1, 13), "status": "error"})
        hbs += [{"date": D(2026, 1, 14) + dt.timedelta(days=i), "status": "ok"}
                for i in range(5)]
        # Longest clean run is 12 -> streak_10 only.
        specs = {s.slug for s in eval_streaks(hbs)}
        self.assertEqual(specs, {"streak_10"})

    def test_streak_ignores_skipped_days(self):
        hbs = []
        d = D(2026, 1, 1)
        for i in range(15):
            hbs.append({"date": d, "status": "ok"})
            d += dt.timedelta(days=1)
            hbs.append({"date": d, "status": "skipped"})  # cadence not due
            d += dt.timedelta(days=1)
        specs = {s.slug for s in eval_streaks(hbs)}
        self.assertIn("streak_10", specs)  # skipped days don't break it


class TestDarkHorse(unittest.TestCase):
    def test_bottom_quartile_to_top_decile(self):
        # 10 portfolios. p0 starts worst then rockets to best within 90 days.
        rbp: dict[str, list] = {}
        d0 = D(2026, 1, 1)
        d1 = D(2026, 3, 1)  # ~59 days later
        for k in range(10):
            # day 0: portfolio k has return k/100 (p0 worst)
            # day 1: p0 jumps to top, others unchanged
            rbp[f"p{k}"] = [(d0, k / 100.0), (d1, (0.50 if k == 0 else k / 100.0))]
        out = eval_dark_horse(rbp)
        self.assertIn("p0", out)
        self.assertEqual(out["p0"].slug, "dark_horse")

    def test_no_dark_horse_when_stable(self):
        rbp = {}
        d0 = D(2026, 1, 1)
        d1 = D(2026, 3, 1)
        for k in range(10):
            rbp[f"p{k}"] = [(d0, k / 100.0), (d1, k / 100.0)]
        self.assertEqual(eval_dark_horse(rbp), {})

    def test_needs_min_portfolios(self):
        rbp = {"a": [(D(2026, 1, 1), 0.0)], "b": [(D(2026, 1, 1), 1.0)]}
        self.assertEqual(eval_dark_horse(rbp), {})


class TestPeriods(unittest.TestCase):
    def test_period_bounds_and_ids(self):
        s, e = period_bounds("month", D(2026, 2, 14))
        self.assertEqual((s, e), (D(2026, 2, 1), D(2026, 2, 28)))
        self.assertEqual(period_id("month", s), "2026-02")
        s, e = period_bounds("quarter", D(2026, 5, 9))
        self.assertEqual((s, e), (D(2026, 4, 1), D(2026, 6, 30)))
        self.assertEqual(period_id("quarter", s), "2026-Q2")
        s, e = period_bounds("year", D(2026, 7, 1))
        self.assertEqual((s, e), (D(2026, 1, 1), D(2026, 12, 31)))
        self.assertEqual(period_id("year", s), "2026")

    def test_rank_period_champion_and_podium(self):
        standings = [
            PeriodStanding("p1", 0.30, True, True, 0.10, 12),
            PeriodStanding("p2", 0.20, True, True, 0.10, 12),
            PeriodStanding("p3", 0.10, True, True, 0.10, 12),
            PeriodStanding("p4", 0.05, True, True, 0.10, 12),
        ]
        grants = rank_period("month", D(2026, 1, 1), standings)
        by_pid = {}
        for pid, spec in grants:
            by_pid.setdefault(pid, []).append(spec.slug)
        self.assertIn("champion_month", by_pid["p1"])
        self.assertIn("podium", by_pid["p1"])
        self.assertIn("podium", by_pid["p3"])
        self.assertNotIn("p4", by_pid)  # 4th place gets nothing

    def test_ineligible_portfolios_excluded(self):
        standings = [
            PeriodStanding("cash_sitter", 0.99, True, True, 0.80, 12),  # too much cash
            PeriodStanding("one_name", 0.90, True, True, 0.10, 2),      # too few holds
            PeriodStanding("newborn", 0.80, False, True, 0.10, 12),     # too new
            PeriodStanding("private", 0.70, True, False, 0.10, 12),     # not public
            PeriodStanding("legit", 0.10, True, True, 0.10, 12),
        ]
        grants = rank_period("month", D(2026, 1, 1), standings)
        champs = [pid for pid, spec in grants if spec.slug == "champion_month"]
        self.assertEqual(champs, ["legit"])


class TestEvaluatePortfolio(unittest.TestCase):
    def test_end_to_end_collects_multiple(self):
        # A portfolio that rises 1%/day for 35 days vs flat SPY, fully invested.
        vals = [1_000_000 * (1.01 ** i) for i in range(35)]
        spy = [100.0] * 35
        data = PortfolioData(
            portfolio_id="pid",
            slug="test",
            history=_hist(vals, cash=[v * 0.01 for v in vals]),
            trades=[],
            heartbeats=[],
            spy_by_date=_spy(spy),
            price_lookup=lambda t: {},
        )
        slugs = {s.slug for s in evaluate_portfolio(data)}
        self.assertIn("molt", slugs)
        self.assertIn("escape_velocity", slugs)
        self.assertIn("full_deployment", slugs)


class TestConstantsMatchCatalog(unittest.TestCase):
    def test_thresholds_are_named(self):
        self.assertEqual(badges.MOLT_DAYS, 30)
        self.assertEqual(set(badges.STREAK_THRESHOLDS.values()), {10, 25, 50})


if __name__ == "__main__":
    unittest.main()
