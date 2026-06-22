"""Unit tests for fundamentals_updater.select_stale_batch (rotation selection)."""

import unittest

from fundamentals_updater import select_stale_batch


class SelectStaleBatchTests(unittest.TestCase):
    def test_never_fetched_first_then_oldest(self):
        tickers = ["AAA", "BBB", "CCC", "DDD"]
        freshness = {
            "AAA": "2026-06-20T00:00:00Z",
            "BBB": "2026-06-01T00:00:00Z",  # oldest stamped
            "CCC": "2026-06-10T00:00:00Z",
            # DDD missing entirely → must sort first
        }
        out = select_stale_batch(tickers, freshness, limit=10)
        self.assertEqual(out, ["DDD", "BBB", "CCC", "AAA"])

    def test_limit_caps(self):
        tickers = ["AAA", "BBB", "CCC"]
        freshness = {
            "AAA": "2026-06-03T00:00:00Z",
            "BBB": "2026-06-02T00:00:00Z",
            "CCC": "2026-06-01T00:00:00Z",
        }
        out = select_stale_batch(tickers, freshness, limit=2)
        self.assertEqual(out, ["CCC", "BBB"])  # two oldest

    def test_all_missing_keeps_input_order(self):
        tickers = ["AAA", "BBB", "CCC"]
        out = select_stale_batch(tickers, {}, limit=10)
        # All equal-key (0, "") → stable sort preserves input order.
        self.assertEqual(out, ["AAA", "BBB", "CCC"])

    def test_zero_or_negative_limit(self):
        self.assertEqual(select_stale_batch(["AAA"], {}, limit=0), [])
        self.assertEqual(select_stale_batch(["AAA"], {}, limit=-5), [])


if __name__ == "__main__":
    unittest.main()
