#!/usr/bin/env python3
"""Unit tests for the Sector Rebalancer feature.

Two layers, all offline (no network, no DB, no broker):

1. ``sector_rebalancer.plan_sector_trims`` — the pure trim decision core
   (over-cap → partial trim to the cap, weakest names first; under-cap → no-op;
   unclassified names never trimmed; dust guard).
2. ``sector_rebalancer.rebalance_sector_rebalancer`` end-to-end against fakes.

The buy-side half of the cap (the snake draft refusing to breach it) is tested
in ``test_swarm.py``'s ``TestSectorCap``.

Run: pytest tests/test_sector_rebalancer.py
"""

from __future__ import annotations

import unittest

from agent_strategies import RebalanceContext
from sector_rebalancer import plan_sector_trims, rebalance_sector_rebalancer


def _h(ticker, qty, price, pnl=0.0):
    """A book holding row in the shape get_portfolio_book emits."""
    return {
        "ticker": ticker,
        "quantity": qty,
        "avg_cost_usd": price,
        "price_usd": price,
        "market_value_usd": round(qty * price, 2),
        "unrealized_pnl_usd": pnl,
    }


class TestPlanSectorTrims(unittest.TestCase):
    def test_trims_over_cap_weakest_rank_first(self):
        # Tech = 400 of a 1000 book; cap 30% = 300, so $100 must go. AAA is the
        # strong name (rank 1), BBB the weak one (rank 5) → BBB is trimmed.
        holdings = [_h("AAA", 25, 10, pnl=50), _h("BBB", 15, 10, pnl=-10)]
        sector_of = {"AAA": "Tech", "BBB": "Tech"}
        sells = plan_sector_trims(
            holdings, sector_of, total_value=1000, max_sector_pct=30,
            ranks={"AAA": 1, "BBB": 5},
        )
        self.assertEqual([(s["ticker"], s["qty"]) for s in sells], [("BBB", 10)])

    def test_under_cap_is_noop(self):
        holdings = [_h("AAA", 10, 10), _h("BBB", 10, 10)]  # Tech = 200 < 300
        sells = plan_sector_trims(
            holdings, {"AAA": "Tech", "BBB": "Tech"},
            total_value=1000, max_sector_pct=30,
        )
        self.assertEqual(sells, [])

    def test_unclassified_never_trimmed(self):
        # AAA has no sector → it can't breach a cap and is never sold, even at
        # 90% of the book.
        holdings = [_h("AAA", 90, 10)]
        sells = plan_sector_trims(
            holdings, sector_of={}, total_value=1000, max_sector_pct=30,
        )
        self.assertEqual(sells, [])

    def test_orders_by_pnl_when_no_ranks(self):
        # No screen ranks → weakest = biggest loser first. AAA (-20) before
        # BBB (+5).
        holdings = [_h("AAA", 25, 10, pnl=-20), _h("BBB", 15, 10, pnl=5)]
        sells = plan_sector_trims(
            holdings, {"AAA": "Tech", "BBB": "Tech"},
            total_value=1000, max_sector_pct=30,
        )
        self.assertEqual(sells[0]["ticker"], "AAA")

    def test_dust_guard_skips_tiny_trim(self):
        # Tech = 305, cap 300 → only $5 over. A 1-share ($10) partial trim is
        # below the $50 dust floor and isn't a full exit → skipped.
        holdings = [_h("AAA", 20, 10), _h("BBB", 10, 10.5)]  # 200 + 105 = 305
        sells = plan_sector_trims(
            holdings, {"AAA": "Tech", "BBB": "Tech"},
            total_value=1000, max_sector_pct=30, min_trade_usd=50,
        )
        self.assertEqual(sells, [])

    def test_dust_guard_allows_full_exit(self):
        # A small position whose FULL value is below the dust floor may still be
        # closed entirely to satisfy the cap. Tech = 300, cap 27% = 270 → $30
        # over, which is exactly BBB's whole $30 position.
        holdings = [_h("AAA", 27, 10), _h("BBB", 3, 10)]  # 270 + 30 = 300, over 30
        sells = plan_sector_trims(
            holdings, {"AAA": "Tech", "BBB": "Tech"},
            total_value=1000, max_sector_pct=27, min_trade_usd=50,
            ranks={"AAA": 1, "BBB": 5},
        )
        # BBB ($30 < $50 floor) is fully closed because qty == held.
        self.assertEqual([(s["ticker"], s["qty"]) for s in sells], [("BBB", 3)])

    def test_caps_qty_at_held_quantity(self):
        # A near-zero cap forces (almost) the whole position out, but never more
        # than is held. Tech = 50, cap 0.5% = 5 → over 45 → 5 shares (the lot).
        holdings = [_h("AAA", 5, 10)]
        sells = plan_sector_trims(
            holdings, {"AAA": "Tech"}, total_value=1000, max_sector_pct=0.5,
            min_trade_usd=0,
        )
        self.assertEqual(sells[0]["qty"], 5)  # never more than the 5 held

    def test_cap_at_100_is_noop(self):
        holdings = [_h("AAA", 90, 10)]
        self.assertEqual(
            plan_sector_trims(holdings, {"AAA": "Tech"}, 1000, 100), []
        )

    def test_independent_sectors(self):
        # Two sectors over cap are each trimmed independently.
        holdings = [
            _h("AAA", 40, 10),  # Tech 400
            _h("BBB", 40, 10),  # Health 400
        ]
        sells = plan_sector_trims(
            holdings, {"AAA": "Tech", "BBB": "Health"},
            total_value=1000, max_sector_pct=30,
        )
        self.assertEqual({s["ticker"] for s in sells}, {"AAA", "BBB"})


# --- rebalance_sector_rebalancer (end to end with fakes) -------------------


class FakePM:
    def __init__(self, holdings, cash):
        self._holdings = holdings
        self._cash = cash
        self.sells: list = []

    def get_portfolio_book(self, pid):
        hv = sum(h["market_value_usd"] for h in self._holdings)
        return {
            "cash_usd": self._cash,
            "total_value_usd": round(self._cash + hv, 2),
            "holdings": list(self._holdings),
        }

    def sell_portfolio_atomic(self, pid, aid, ticker, qty, note="", **kw):
        self.sells.append((ticker, qty))
        return {"status": "ok"}


class FakeDB:
    def __init__(self, sectors):
        self._sectors = sectors

    def get_sectors(self, tickers):
        up = {(t or "").upper() for t in tickers}
        return {k: v for k, v in self._sectors.items() if k in up}


def _ctx(pm, db, *, dry_run=False, params=None):
    return RebalanceContext(
        db=db, pm=pm,
        agent={"id": "sector-agent", "handle": "sector-rebalancer"},
        dry_run=dry_run, params=params or {"max_sector_pct": 30},
        portfolio_id="port-1",
    )


class TestRebalance(unittest.TestCase):
    def test_trims_over_cap_sector(self):
        # Tech = 400 of a 1000 book (600 holdings + 400 cash? no: 400 equity +
        # 600 cash = 1000). Cap 30% = 300 → trim $100 of the weakest.
        holdings = [_h("AAA", 25, 10, pnl=50), _h("BBB", 15, 10, pnl=-10)]
        pm = FakePM(holdings, cash=600)
        db = FakeDB({"AAA": "Tech", "BBB": "Tech"})
        res = rebalance_sector_rebalancer(_ctx(pm, db))
        self.assertEqual(res.sells, 1)
        self.assertEqual(pm.sells, [("BBB", 10)])

    def test_noop_when_within_cap(self):
        holdings = [_h("AAA", 10, 10), _h("BBB", 10, 10)]  # Tech 200 of 1000
        pm = FakePM(holdings, cash=800)
        db = FakeDB({"AAA": "Tech", "BBB": "Tech"})
        res = rebalance_sector_rebalancer(_ctx(pm, db))
        self.assertEqual(res.sells, 0)
        self.assertEqual(pm.sells, [])

    def test_dry_run_executes_nothing(self):
        holdings = [_h("AAA", 25, 10), _h("BBB", 15, 10)]
        pm = FakePM(holdings, cash=600)
        db = FakeDB({"AAA": "Tech", "BBB": "Tech"})
        res = rebalance_sector_rebalancer(_ctx(pm, db, dry_run=True))
        self.assertEqual(pm.sells, [])
        self.assertIn("dry_run_plan", res.notes)

    def test_noop_without_portfolio(self):
        pm = FakePM([], cash=0)
        db = FakeDB({})
        ctx = RebalanceContext(
            db=db, pm=pm, agent={"id": "x", "handle": "sector-rebalancer"},
            dry_run=False, params={"max_sector_pct": 30}, portfolio_id=None,
        )
        res = rebalance_sector_rebalancer(ctx)
        self.assertEqual(res.sells, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
