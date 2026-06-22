"""Unit tests for data_freshness_report.classify (RAG status logic)."""

import unittest

from data_freshness_report import classify, OK, WATCH, STALE


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


if __name__ == "__main__":
    unittest.main()
