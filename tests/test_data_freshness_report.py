"""Unit tests for data_freshness_report.classify (RAG status logic)."""

import unittest

from data_freshness_report import (
    OK, STALE, WATCH, classify, count_past_window, tail_age_days,
)


def _c(**kw):
    base = dict(have=100, total=100, stalest_age_days=1.0, refreshed_24h=50,
                expected_daily=True, max_stale_days=4, min_coverage=0.5)
    base.update(kw)
    return classify(**base)


class ClassifyTests(unittest.TestCase):
    def test_healthy_is_ok(self):
        self.assertEqual(_c(), OK)

    def test_no_data_is_stale(self):
        self.assertEqual(_c(have=0), STALE)

    def test_daily_feed_not_refreshing_is_stale(self):
        self.assertEqual(_c(refreshed_24h=0), STALE)

    def test_far_past_window_is_stale(self):
        self.assertEqual(_c(stalest_age_days=10, max_stale_days=4), STALE)

    def test_just_past_window_is_watch(self):
        self.assertEqual(_c(stalest_age_days=5, max_stale_days=4), WATCH)

    def test_low_coverage_is_watch(self):
        self.assertEqual(_c(have=30, total=100, min_coverage=0.5), WATCH)

    def test_rotation_within_window_ok_even_if_old(self):
        # A rotation feed: stalest near cycle length but still refreshing daily.
        self.assertEqual(
            _c(stalest_age_days=20, max_stale_days=30, refreshed_24h=150), OK)

    def test_rotation_stale_tail_is_watch_not_stale(self):
        # Rotation feed actively refreshing but with a far-past-window tail
        # (dropped-from-universe names) → WATCH, never STALE.
        self.assertEqual(
            _c(rotation=True, stalest_age_days=100, max_stale_days=30,
               refreshed_24h=200), WATCH)

    def test_non_rotation_far_past_window_still_stale(self):
        # Same numbers without rotation → STALE (a full-universe daily feed
        # really should have refreshed every name).
        self.assertEqual(
            _c(rotation=False, stalest_age_days=100, max_stale_days=30,
               refreshed_24h=200), STALE)

    def test_non_daily_feed_zero_24h_not_auto_stale(self):
        # expected_daily=False → 0 in 24h is not penalised on that rule alone.
        self.assertEqual(_c(expected_daily=False, refreshed_24h=0), OK)


class TailAgeTests(unittest.TestCase):
    def test_empty_is_none(self):
        self.assertIsNone(tail_age_days([]))

    def test_small_feed_trims_nothing(self):
        # Below 100 names int(n * 0.01) is 0, so the exact maximum decides.
        self.assertEqual(tail_age_days([1.0, 2.0, 99.0]), 99.0)

    def test_trims_the_worst_one_percent(self):
        # 300 current names + 6 dead ones: 3 are trimmed, so the reported
        # decision age is the 4th-worst — still a dead name, still not 1 day.
        ages = [1.0] * 300 + [40.0, 41.0, 42.0, 43.0, 44.0, 45.0]
        self.assertEqual(tail_age_days(ages), 42.0)

    def test_a_handful_of_dead_names_no_longer_reds_a_fresh_feed(self):
        # The live case: 3030 names at Friday's close, 6 with a dark feed.
        ages = [2.0] * 3030 + [22.0, 21.0, 20.0, 17.0, 16.0, 12.0]
        self.assertEqual(
            _c(stalest_age_days=tail_age_days(ages), max_stale_days=5,
               expected_daily=False),
            OK,
        )

    def test_a_genuinely_stale_feed_still_trips(self):
        # Trimming the tail must not mask a feed that stopped for everyone.
        ages = [30.0] * 3036
        self.assertEqual(
            _c(stalest_age_days=tail_age_days(ages), max_stale_days=5,
               expected_daily=False),
            STALE,
        )


class PastWindowTests(unittest.TestCase):
    def test_counts_only_names_past_the_window(self):
        self.assertEqual(count_past_window([1.0, 4.0, 5.0, 22.0], 4), 2)

    def test_empty_is_zero(self):
        self.assertEqual(count_past_window([], 4), 0)


if __name__ == "__main__":
    unittest.main()
