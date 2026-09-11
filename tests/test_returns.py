"""Time-weighted return, pinned against the episode that motivated it.

On 2026-09-02 the Scrappy Fightback live sleeve reported +0.80% while the paper
book it mirrors reported +6.28%. Read literally that is a catastrophic
execution failure. It was not: the sleeve's percentage was
``(value − starting_cash) / starting_cash``, and $29,600 of its $39,600
baseline had arrived six days earlier. The strategy had barely had the money.

The series below are the real ``agent_portfolio_history`` rows and the real
``portfolio_cash_ledger`` flows. If this module is right, they produce +3.12%
and +3.74% — a 0.6pp gap, which is the truth and is explainable (cash drag plus
one day of marking lag). Anything that reproduces 0.80% has failed.
"""
from __future__ import annotations

import unittest

from returns import (
    BASE_INDEX,
    Point,
    advance_index,
    daily_return,
    pct_from_index,
    twr_index,
)

# scrappy-fightback-live, 2026-08-18 → 2026-09-02. Flows: $9,999.97 in-kind on
# the 18th (the funding that created it), $17,451.64 in-kind on the 26th,
# $12,149.00 credited on the 27th.
LIVE = [
    Point(9854.74, 9999.97),   # 08-18 — first snapshot; funding is not a return
    Point(9913.18),            # 08-19
    Point(10091.20),           # 08-20
    Point(10047.98),           # 08-21
    Point(10128.22),           # 08-22
    Point(10128.22),           # 08-23 (weekend — same mark)
    Point(10128.22),           # 08-24
    Point(10127.06),           # 08-25
    Point(27600.00, 17451.64), # 08-26
    Point(39491.03, 12149.00), # 08-27 — 14 real buys, marked at the prior close
    Point(40072.52),           # 08-28
    Point(40139.39),           # 08-29
    Point(40139.39),           # 08-30
    Point(40139.39),           # 08-31
    Point(39916.27),           # 09-01
    Point(39916.27),           # 09-02
]

# portfolio-2 (the paper book) over the identical window. Funded once at
# creation on 2026-07-20, so every flow here is zero.
PAPER = [
    Point(v) for v in (
        1024553.74, 1030714.92, 1049047.38, 1044903.86, 1053197.98,
        1053197.98, 1053197.98, 1053047.80, 1053760.86, 1051354.76,
        1066719.35, 1068646.66, 1068646.66, 1068646.66, 1062848.59,
        1062848.59,
    )
]


class ScrappyEpisodeTests(unittest.TestCase):
    def test_the_live_sleeve_really_made_about_three_percent(self):
        """Not the 0.80% the cost-basis denominator reported."""
        pct = pct_from_index(twr_index(LIVE)[-1])
        self.assertAlmostEqual(pct, 3.12, places=1)

    def test_the_paper_book_is_unchanged_by_the_new_maths(self):
        """No flows ⇒ TWR is exactly the simple return, to the basis point.

        This is the property that makes the change safe to ship: every paper
        portfolio on the public leaderboard has zero ledger rows, so not one
        published number moves.
        """
        pct = pct_from_index(twr_index(PAPER)[-1])
        simple = (PAPER[-1].value / PAPER[0].value - 1) * 100
        self.assertAlmostEqual(pct, simple, places=4)

    def test_the_gap_is_ordinary_not_catastrophic(self):
        """0.6pp of real underperformance, not 5.5pp of reported nonsense."""
        live = pct_from_index(twr_index(LIVE)[-1])
        paper = pct_from_index(twr_index(PAPER)[-1])
        self.assertLess(paper - live, 1.0)
        self.assertGreater(paper - live, 0.0)

    def test_funding_day_is_not_a_return(self):
        """The sleeve was marked $145 below the $9,999.97 moved into it on day
        one — an in-kind transfer priced at a different moment, not a loss. A
        series that starts anywhere but 1.0 has booked it as one."""
        self.assertEqual(twr_index(LIVE)[0], BASE_INDEX)

    def test_a_deposit_day_is_not_a_gain(self):
        """08-26: value nearly triples on a $17,451.64 transfer in. The day's
        return is +0.21%, and anything near +170% means the flow was not
        removed — the single most consequential error this module can make."""
        idx = twr_index(LIVE)
        day = idx[8] / idx[7] - 1
        self.assertAlmostEqual(day * 100, 0.21, places=1)


class DailyReturnTests(unittest.TestCase):
    def test_flow_is_removed_from_the_closing_value(self):
        # Started at 100, ended at 210 after 100 was paid in: +10%, not +110%.
        self.assertAlmostEqual(daily_return(100.0, 210.0, 100.0), 0.10)

    def test_a_withdrawal_is_added_back(self):
        # Started at 100, ended at 60 after 50 was taken out: +10%, not -40%.
        self.assertAlmostEqual(daily_return(100.0, 60.0, -50.0), 0.10)

    def test_no_prior_value_is_undefined_not_flat(self):
        """None, never 0.0 — reporting 'flat' would blend missing data into a
        performance series, which is how a gap becomes a claim."""
        for prev in (None, 0.0, -1.0):
            with self.subTest(prev=prev):
                self.assertIsNone(daily_return(prev, 100.0))


class IndexMechanicsTests(unittest.TestCase):
    def test_a_sleeve_emptied_by_a_transfer_records_no_loss(self):
        """The real case: Alphamolt (House) was drained to $0 by a transfer out
        and later refunded. Moving your money elsewhere is not a -100% return,
        so the flow must be added back and the index must not move."""
        idx = twr_index([Point(100.0), Point(0.0, -100.0), Point(50.0, 50.0), Point(55.0)])
        self.assertAlmostEqual(idx[1], BASE_INDEX)   # withdrawal, not a wipeout
        self.assertAlmostEqual(idx[2], BASE_INDEX)   # refunding is not a gain
        self.assertAlmostEqual(idx[3], BASE_INDEX * 1.1)

    def test_a_genuine_wipeout_stays_wiped_out(self):
        """Zero with no flow really is -100%, and no later day recovers it."""
        idx = twr_index([Point(100.0), Point(0.0), Point(50.0, 50.0), Point(55.0)])
        self.assertEqual(idx[1], 0.0)
        self.assertEqual(idx[-1], 0.0)

    def test_the_two_paths_agree_through_a_wipeout(self):
        """The bug this caught: the batch keeps multiplying through the zero
        while the writer treated a zero index as 'no history' and restarted at
        1.0 — quietly redrawing a wiped-out book as flat. Both write the same
        column, so they must never disagree."""
        series = [Point(100.0), Point(0.0), Point(50.0, 50.0), Point(55.0)]
        batch = twr_index(series)
        index, prev = BASE_INDEX, None
        for i, pt in enumerate(series):
            index = BASE_INDEX if prev is None else advance_index(index, prev, pt.value, pt.flow)
            self.assertAlmostEqual(index, batch[i], places=10)
            prev = pt.value

    def test_the_index_never_goes_negative(self):
        """Below -100% is not a thing a long-only book can report."""
        idx = twr_index([Point(100.0), Point(-500.0)])
        self.assertGreaterEqual(idx[-1], 0.0)

    def test_advance_matches_the_batch_computation(self):
        """The daily writer takes one step; the backfill runs the series. They
        must agree, or a portfolio's index depends on which one last touched
        it."""
        batch = twr_index(LIVE)
        index = BASE_INDEX
        prev = None
        for i, p in enumerate(LIVE):
            index = BASE_INDEX if prev is None else advance_index(index, prev, p.value, p.flow)
            self.assertAlmostEqual(index, batch[i], places=10)
            prev = p.value

    def test_a_missing_yesterday_starts_a_fresh_series(self):
        """No prior index at all — a portfolio's first ever snapshot."""
        self.assertEqual(advance_index(None, None, 100.0), BASE_INDEX)

    def test_a_missing_prior_value_holds_the_index(self):
        """A gap in the snapshots (a cron outage) must not restart the series
        at 1.0 and wipe the portfolio's history to date; there is simply no
        return to apply for that day."""
        self.assertEqual(advance_index(1.5, None, 100.0), 1.5)

    def test_pct_from_index_is_none_when_unknown(self):
        self.assertIsNone(pct_from_index(None))
        self.assertEqual(pct_from_index(1.0), 0.0)
        self.assertEqual(pct_from_index(1.0312), 3.12)


if __name__ == "__main__":
    unittest.main()
