#!/usr/bin/env python3
"""Unit tests for the per-name buy-time web search.

Covers the shared `web_search.recent_developments` helper and the buyer's
`llm_watchlist_buyer.attach_recent_news` enrichment (cache + no-op behaviour).
SerpAPI is mocked — no network. Run: python test_web_search.py
"""

from __future__ import annotations

import logging
import unittest
from unittest import mock

import web_search
import llm_watchlist_buyer as buyer

LOG = logging.getLogger("test_web_search")


class TestRecentDevelopments(unittest.TestCase):
    def test_empty_key_is_noop(self):
        # No API key → no search, returns "" (never raises).
        with mock.patch.object(web_search, "serpapi_search") as m:
            out = web_search.recent_developments("Foo Inc", "FOO", api_key="", logger=LOG)
        self.assertEqual(out, "")
        m.assert_not_called()

    def test_single_query_by_default(self):
        with mock.patch.object(web_search, "serpapi_search", return_value="- Headline: body") as m:
            out = web_search.recent_developments("Foo Inc", "FOO", api_key="k", logger=LOG)
        self.assertEqual(m.call_count, 1)
        self.assertIn("Headline", out)

    def test_two_queries_when_requested(self):
        with mock.patch.object(web_search, "serpapi_search", return_value="- H: b") as m:
            web_search.recent_developments(
                "Foo Inc", "FOO", api_key="k", logger=LOG, max_queries=2,
            )
        self.assertEqual(m.call_count, 2)

    def test_truncates_to_max_chars(self):
        long = "x" * 5000
        with mock.patch.object(web_search, "serpapi_search", return_value=long):
            out = web_search.recent_developments(
                "Foo Inc", "FOO", api_key="k", logger=LOG, max_chars=100,
            )
        self.assertLessEqual(len(out), 100)


class TestAttachRecentNews(unittest.TestCase):
    def setUp(self):
        self.data = {
            "AAA": {"ticker": "AAA", "company_name": "Alpha"},
            "BBB": {"ticker": "BBB", "company_name": "Beta"},
        }

    def test_noop_without_key(self):
        n = buyer.attach_recent_news(self.data, api_key="", cache={})
        self.assertEqual(n, 0)
        self.assertNotIn("recent_news", self.data["AAA"])

    def test_populates_recent_news(self):
        with mock.patch.object(
            buyer, "recent_developments", return_value="news for it"
        ):
            n = buyer.attach_recent_news(
                self.data, api_key="k", cache={}, concurrency=2,
            )
        self.assertEqual(n, 2)
        self.assertEqual(self.data["AAA"]["recent_news"], "news for it")
        self.assertEqual(self.data["BBB"]["recent_news"], "news for it")

    def test_cache_dedupes_across_calls(self):
        cache: dict[str, str] = {}
        with mock.patch.object(
            buyer, "recent_developments", return_value="cached"
        ) as m:
            buyer.attach_recent_news(self.data, api_key="k", cache=cache)
            self.assertEqual(m.call_count, 2)
            # Second call over the same tickers hits the cache — no new fetches.
            again = {"AAA": {"ticker": "AAA", "company_name": "Alpha"}}
            fetched = buyer.attach_recent_news(again, api_key="k", cache=cache)
        self.assertEqual(fetched, 0)
        self.assertEqual(again["AAA"]["recent_news"], "cached")

    def test_empty_news_not_attached(self):
        # A name with no results stays without a recent_news key (so the prompt
        # default "(no recent web results)" shows instead of an empty string).
        with mock.patch.object(buyer, "recent_developments", return_value=""):
            buyer.attach_recent_news(self.data, api_key="k", cache={})
        self.assertNotIn("recent_news", self.data["AAA"])


if __name__ == "__main__":
    unittest.main()
