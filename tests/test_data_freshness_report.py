"""Unit tests for data_freshness_report — the RAG status logic and the
window summary behind the daily email.

The email said "4 item(s) need attention" every day for weeks while every
pipeline was running as designed. These tests pin the rows from the real
2026-09-13 email against the rule that classifies them: the designed state is
green, and red/amber mean an Action broke.
"""

from datetime import datetime, timedelta, timezone
import unittest

from data_freshness_report import (
    ALIVE_DAYS, OK, STALE, WATCH, classify, summarize,
)


def _c(**kw):
    base = dict(have=100, total=100, fresh=100, newest_age_days=0.3,
                expected_daily=True, ok_fraction=0.97, min_coverage=0.5)
    base.update(kw)
    return classify(**base)


class ClassifyTests(unittest.TestCase):
    def test_healthy_is_ok(self):
        self.assertEqual(_c(), OK)

    def test_no_data_is_stale(self):
        self.assertEqual(_c(have=0, fresh=0), STALE)

    def test_daily_feed_that_stopped_writing_is_stale(self):
        self.assertEqual(_c(newest_age_days=ALIVE_DAYS + 0.1), STALE)

    def test_daily_feed_a_lagging_cron_apart_is_alive(self):
        """Yesterday's run at 09:30, today's at 17:00, report at 16:30 — the
        newest stamp is ~31h old. The old 24h rule called that STALE."""
        self.assertEqual(_c(newest_age_days=31 / 24), OK)

    def test_non_daily_feed_ignores_newest_age(self):
        # Prices: markets close on weekends; judged by window fraction only.
        self.assertEqual(_c(expected_daily=False, newest_age_days=3.0), OK)

    def test_small_stale_tail_is_ok(self):
        """The regression: a 0.2% tail turned every row red."""
        self.assertEqual(_c(have=3041, fresh=3028), OK)   # 99.6% inside 5d
        self.assertEqual(_c(have=3041, fresh=2940), WATCH)  # 96.7% - just under
        self.assertEqual(_c(have=3041, fresh=2400), STALE)  # 78.9%

    def test_rotation_feed_uses_its_own_threshold(self):
        self.assertEqual(_c(have=3025, fresh=2900, ok_fraction=0.95), OK)
        self.assertEqual(_c(have=3025, fresh=2800, ok_fraction=0.95), WATCH)

    def test_low_coverage_is_watch_even_when_fresh(self):
        self.assertEqual(_c(have=30, total=100, fresh=30), WATCH)

    def test_coverage_floor_is_per_feed(self):
        # Valuation covers ~96% (P/S needs revenue) against a 0.5 floor.
        self.assertEqual(_c(have=2911, total=3041, fresh=2898), OK)

    def test_stale_fraction_beats_coverage(self):
        self.assertEqual(_c(have=100, total=100, fresh=10), STALE)


class RealEmailRowsTests(unittest.TestCase):
    """The four rows the 2026-09-13 email flagged, with what the data actually
    looked like, must classify green under the new rule."""

    def test_current_price_sep_13(self):
        # 3041 priced; 3028 inside 5 days; 7 names last priced Aug 21.
        self.assertEqual(_c(have=3041, total=3041, fresh=3028, expected_daily=False,
                            newest_age_days=1.9), OK)

    def test_valuation_sep_13(self):
        # 2911 of 3041 maintained; 13 with no row in 7 days; wrote today.
        self.assertEqual(_c(have=2911, total=3041, fresh=2898, newest_age_days=0.3,
                            ok_fraction=0.97, min_coverage=0.5), OK)

    def test_fundamentals_sep_13(self):
        # Scoped to Tier-1: 3025 maintained, 3024 inside 30d (one at 35d).
        # Unscoped it had a Jun 04 delisted name dragging it to WATCH.
        self.assertEqual(_c(have=3025, total=3041, fresh=3024, newest_age_days=0.3,
                            ok_fraction=0.95, min_coverage=0.5), OK)

    def test_ai_analysis_sep_13(self):
        # Scoped to Tier-1: 2950 maintained, 2948 inside 30d.
        self.assertEqual(_c(have=2950, total=3041, fresh=2948, newest_age_days=1.25,
                            ok_fraction=0.95, min_coverage=0.3), OK)

    def test_a_broken_action_still_shows(self):
        # Fundamentals cron dead for two days → newest stamp 2.3d → STALE.
        self.assertEqual(_c(have=3025, total=3041, fresh=3000, newest_age_days=2.3,
                            ok_fraction=0.95), STALE)
        # Prices job failing for a week → most names past the 5d window.
        self.assertEqual(_c(have=3041, total=3041, fresh=300, expected_daily=False,
                            newest_age_days=7), STALE)


class SummarizeTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 14, 16, 30, tzinfo=timezone.utc)

    def _ago(self, days):
        return (self.now - timedelta(days=days)).isoformat()

    def test_counts_fresh_inside_window_and_refreshed_24h(self):
        stamps = [self._ago(0.2), self._ago(0.9), self._ago(3), self._ago(6), self._ago(40)]
        s = summarize(stamps, self.now, window_days=5)
        self.assertEqual(s.have, 5)
        self.assertEqual(s.fresh, 3)
        self.assertEqual(s.refreshed_24h, 2)
        self.assertEqual(s.newest, stamps[0])
        self.assertEqual(s.oldest, stamps[-1])

    def test_date_only_stamps_parse(self):
        s = summarize(["2026-09-11", "2026-06-27"], self.now, window_days=5)
        self.assertEqual(s.fresh, 1)
        self.assertEqual(s.have, 2)

    def test_unparseable_and_empty_are_dropped(self):
        s = summarize([None, "", "not a date", self._ago(1)], self.now, window_days=5)
        self.assertEqual(s.have, 1)
        self.assertEqual(s.fresh, 1)

    def test_empty(self):
        s = summarize([], self.now, window_days=5)
        self.assertEqual((s.newest, s.oldest, s.refreshed_24h, s.fresh, s.have),
                         (None, None, 0, 0, 0))


if __name__ == "__main__":
    unittest.main()
