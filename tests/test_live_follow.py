#!/usr/bin/env python3
"""Unit tests for the explicit live→paper follower pairing (migration 070).

Covers ``alpaca_mirror._sibling_paper_portfolio`` and
``agent_heartbeat._pair_live_followers`` with a stubbed db — no live calls.

Run directly:

    pytest tests/test_live_follow.py
"""

from __future__ import annotations

import unittest

from agent_heartbeat import _pair_live_followers
from alpaca_mirror import _sibling_paper_portfolio


class _FakeDB:
    """Just the two read methods the pairing code touches."""

    def __init__(self, portfolios):
        self.portfolios = portfolios

    def get_portfolio_by_id(self, portfolio_id):
        for p in self.portfolios:
            if p["id"] == portfolio_id:
                return p
        return None

    def get_human_portfolios(self):
        return list(self.portfolios)


def _paper(pid, owner, slug=None):
    return {"id": pid, "owner_user_id": owner, "mode": "paper",
            "slug": slug or pid}


def _live(pid, owner, follows=None, slug=None):
    return {"id": pid, "owner_user_id": owner, "mode": "live",
            "follows_portfolio_id": follows, "slug": slug or pid}


class TestSiblingPaperPortfolio(unittest.TestCase):
    def test_follows_link_wins_with_multiple_paper_books(self):
        p1 = _paper("p1", "u1")
        p2 = _paper("p2", "u1")
        live = _live("l1", "u1", follows="p2")
        db = _FakeDB([p1, p2, live])
        self.assertEqual(_sibling_paper_portfolio(db, live), p2)

    def test_broken_link_returns_none(self):
        p1 = _paper("p1", "u1")
        live = _live("l1", "u1", follows="gone")
        db = _FakeDB([p1, live])
        self.assertIsNone(_sibling_paper_portfolio(db, live))

    def test_link_to_live_row_returns_none(self):
        other_live = _live("l0", "u1")
        live = _live("l1", "u1", follows="l0")
        db = _FakeDB([other_live, live])
        self.assertIsNone(_sibling_paper_portfolio(db, live))

    def test_null_link_single_paper_fallback(self):
        p1 = _paper("p1", "u1")
        live = _live("l1", "u1")
        db = _FakeDB([p1, live])
        self.assertEqual(_sibling_paper_portfolio(db, live), p1)

    def test_null_link_multiple_papers_returns_none(self):
        p1 = _paper("p1", "u1")
        p2 = _paper("p2", "u1")
        live = _live("l1", "u1")
        db = _FakeDB([p1, p2, live])
        self.assertIsNone(_sibling_paper_portfolio(db, live))


class TestPairLiveFollowers(unittest.TestCase):
    def test_one_mirror_per_live_no_owner_fanout(self):
        # Owner with 3 paper books + a linked live follower: only the
        # followed book pairs — the other papers get no mirror.
        p1, p2, p3 = _paper("p1", "u1"), _paper("p2", "u1"), _paper("p3", "u1")
        live = _live("l1", "u1", follows="p2")
        pairs = _pair_live_followers([p1, p2, p3, live])
        self.assertEqual(pairs, {"p2": live})

    def test_unlinked_live_single_paper_fallback(self):
        p1 = _paper("p1", "u1")
        live = _live("l1", "u1")
        pairs = _pair_live_followers([p1, live])
        self.assertEqual(pairs, {"p1": live})

    def test_unlinked_live_multiple_papers_stays_unpaired(self):
        p1, p2 = _paper("p1", "u1"), _paper("p2", "u1")
        live = _live("l1", "u1")
        self.assertEqual(_pair_live_followers([p1, p2, live]), {})

    def test_two_owners_pair_independently(self):
        p1 = _paper("p1", "u1")
        p2 = _paper("p2", "u2")
        l1 = _live("l1", "u1", follows="p1")
        l2 = _live("l2", "u2")  # unlinked, but u2 has one paper book
        pairs = _pair_live_followers([p1, p2, l1, l2])
        self.assertEqual(pairs, {"p1": l1, "p2": l2})


if __name__ == "__main__":
    unittest.main()
