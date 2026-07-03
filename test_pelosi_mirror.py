#!/usr/bin/env python3
"""Unit tests for the Pelosi-mirror feature.

Three layers, all offline (no network, no DB, no broker):

1. ``congress_trades.parse_ptr_text`` against a realistic PTR text sample
   (including the NUL-padded field labels the House PDFs actually emit).
2. ``pelosi_mirror.plan_mirror`` — the pure buy/sell decision core.
3. ``pelosi_mirror.rebalance_pelosi_mirror`` end-to-end against fakes,
   including the mirror-log dedup that makes re-runs no-ops.

Run: python test_pelosi_mirror.py
"""

from __future__ import annotations

import unittest

from agent_strategies import RebalanceContext
from congress_trades import parse_ptr_text, _dedupe_hash
from pelosi_mirror import plan_mirror, rebalance_pelosi_mirror


# A faithful slice of a real Pelosi PTR (DocID 20026590), with the NUL padding
# the extractor produces for field labels ("D\x00...:" == "Description:").
SAMPLE_PTR = (
    "ID Owner Asset Transaction\nType\nDate Notification\nDate\nAmount\n"
    "SP Alphabet Inc. - Class A Common\nStock (GOOGL) [OP]\n"
    "P 01/14/202501/14/2025 $250,001 -\n$500,000\n"
    "F\x00\x00\x00\x00\x00 S\x00\x00\x00\x00\x00: New\n"
    "D\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00: Purchased 50 call options with a strike price of $150.\n"
    "SP Apple Inc. - Common Stock (AAPL)\n[ST]\n"
    "S (partial) 12/31/202412/31/2024 $5,000,001 -\n$25,000,000\n"
    "F\x00\x00\x00\x00\x00 S\x00\x00\x00\x00\x00: New\n"
    "D\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00: Sold 31,600 shares.\n"
    "SP NVIDIA Corporation - Common\nStock (NVDA) [ST]\n"
    "P 12/20/202412/20/2024$500,001 -\n$1,000,000\n"
    "F\x00\x00\x00\x00\x00 S\x00\x00\x00\x00\x00: New\n"
    "D\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00: Exercised 500 call options (50,000 shares).\n"
    "SP Apple Inc. - Common Stock (AAPL)\n[ST]\n"
    "S (partial) 10/22/202510/22/2025$100,001 -\n$250,000\n"
    "F\x00\x00\x00\x00\x00 S\x00\x00\x00\x00\x00: New\n"
    "D\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00: Contribution of 382 shares to Trinity University.\n"
    "SP Matthews International Mutual Fund\n[OT]\n"
    "S 06/20/202506/20/2025$15,001 - $50,000\n"
    "* For the complete list of asset type abbreviations\n"
)


class TestParser(unittest.TestCase):
    def setUp(self):
        self.txns = parse_ptr_text(SAMPLE_PTR)
        self.by_key = {(t.ticker, t.raw_txn_code): t for t in self.txns}

    def test_mutual_fund_without_ticker_skipped(self):
        # The Matthews line has no (TICKER) [XX] token → not a parsed txn.
        self.assertNotIn("Matthews", [t.ticker for t in self.txns])
        # Five rows have tickers; the fund row is dropped.
        self.assertEqual(len(self.txns), 4)

    def test_option_maps_to_underlying_buy(self):
        t = self.by_key[("GOOGL", "P")]
        self.assertEqual(t.txn_type, "buy")
        self.assertTrue(t.is_option)
        self.assertEqual(t.ticker, "GOOGL")

    def test_stock_purchase_and_exercise(self):
        t = self.by_key[("NVDA", "P")]
        self.assertEqual(t.txn_type, "buy")
        self.assertFalse(t.is_option)  # [ST] exercise → underlying shares
        self.assertEqual(t.txn_date, "2024-12-20")

    def test_partial_sale_is_sell(self):
        self.assertIn(("AAPL", "S (partial)"), self.by_key)
        # two AAPL rows share the code; ensure at least one is a non-gift sell
        sells = [x for x in self.txns if x.ticker == "AAPL"]
        self.assertTrue(all(x.txn_type == "sell" for x in sells))

    def test_charitable_contribution_flagged_gift(self):
        gifts = [t for t in self.txns if t.is_gift]
        self.assertEqual(len(gifts), 1)
        self.assertEqual(gifts[0].ticker, "AAPL")
        self.assertIn("Trinity", gifts[0].description)

    def test_amount_band_parsed(self):
        t = self.by_key[("AAPL", "S (partial)")]
        # whichever AAPL row keyed here, both have a valid band
        self.assertGreater(t.amount_max, t.amount_min)

    def test_dedupe_hash_stable_and_distinct(self):
        t = self.by_key[("GOOGL", "P")]
        h1 = _dedupe_hash("Nancy Pelosi", "20026590", t)
        h2 = _dedupe_hash("Nancy Pelosi", "20026590", t)
        self.assertEqual(h1, h2)
        other = self.by_key[("NVDA", "P")]
        self.assertNotEqual(h1, _dedupe_hash("Nancy Pelosi", "20026590", other))


# --- plan_mirror (pure) -----------------------------------------------------


def _trade(tid, ticker, txn_type, txn_date="2026-06-01"):
    return {"id": tid, "ticker": ticker, "txn_type": txn_type, "txn_date": txn_date}


def _book(cash, holdings):
    hv = sum(h["quantity"] * h["price"] for h in holdings)
    return {
        "cash_usd": cash,
        "total_value_usd": cash + hv,
        "holdings": [{"ticker": h["ticker"], "quantity": h["quantity"]} for h in holdings],
    }


class TestPlanMirror(unittest.TestCase):
    KW = dict(target_position_pct=5.0, cash_reserve_pct=0.02,
              min_trade_usd=500.0, max_positions=30)

    def test_buy_opens_to_target(self):
        # $100k book, 5% target = $5k; price $100 → 50 shares.
        plan = plan_mirror([_trade("1", "NVDA", "buy")], _book(100_000, []),
                           {"NVDA": 100.0}, **self.KW)
        self.assertEqual(len(plan.buys), 1)
        self.assertEqual(plan.buys[0]["ticker"], "NVDA")
        self.assertEqual(plan.buys[0]["qty"], 50)

    def test_sell_exits_held_name(self):
        book = _book(10_000, [{"ticker": "AAPL", "quantity": 20, "price": 200.0}])
        plan = plan_mirror([_trade("1", "AAPL", "sell")], book,
                           {"AAPL": 200.0}, **self.KW)
        self.assertEqual(len(plan.sells), 1)
        self.assertEqual(plan.sells[0]["qty"], 20)

    def test_sell_of_unheld_is_skipped(self):
        plan = plan_mirror([_trade("1", "AAPL", "sell")], _book(10_000, []),
                           {"AAPL": 200.0}, **self.KW)
        self.assertFalse(plan.sells)
        self.assertEqual(len(plan.skips), 1)

    def test_unpriced_name_skipped(self):
        plan = plan_mirror([_trade("1", "XYZ", "buy")], _book(100_000, []),
                           {}, **self.KW)  # no price → not in universe
        self.assertFalse(plan.buys)
        self.assertIn("universe", plan.skips[0]["reason"])

    def test_already_at_target_not_topped_up(self):
        # Holding already worth 5% of NAV → no buy.
        book = _book(95_000, [{"ticker": "NVDA", "quantity": 50, "price": 100.0}])
        plan = plan_mirror([_trade("1", "NVDA", "buy")], book,
                           {"NVDA": 100.0}, **self.KW)
        self.assertFalse(plan.buys)

    def test_default_skips_any_held_name(self):
        # Default (when_held='skip'): even a tiny existing position blocks the
        # buy — never double up.
        book = _book(99_900, [{"ticker": "NVDA", "quantity": 1, "price": 100.0}])
        plan = plan_mirror([_trade("1", "NVDA", "buy")], book,
                           {"NVDA": 100.0}, **self.KW)
        self.assertFalse(plan.buys)
        self.assertIn("doubling up", plan.skips[0]["reason"])

    def test_top_up_mode_adds_toward_target(self):
        # when_held='top_up': underweight existing holding is topped to target.
        # NAV ~$100k, 5% target = $5k; hold 1 share ($100) → buy ~49 more.
        book = _book(99_900, [{"ticker": "NVDA", "quantity": 1, "price": 100.0}])
        kw = {**self.KW, "when_held": "top_up"}
        plan = plan_mirror([_trade("1", "NVDA", "buy")], book,
                           {"NVDA": 100.0}, **kw)
        self.assertEqual(len(plan.buys), 1)
        self.assertEqual(plan.buys[0]["qty"], 49)

    def test_latest_action_wins_per_ticker(self):
        # Buy then a later sell of the same name → net sell (we hold it).
        book = _book(10_000, [{"ticker": "NVDA", "quantity": 10, "price": 100.0}])
        trades = [_trade("1", "NVDA", "buy", "2026-05-01"),
                  _trade("2", "NVDA", "sell", "2026-06-01")]
        plan = plan_mirror(trades, book, {"NVDA": 100.0}, **self.KW)
        self.assertEqual(len(plan.sells), 1)
        self.assertFalse(plan.buys)
        # both trade ids are attributed so both get logged as handled
        self.assertEqual(set(plan.sells[0]["trade_ids"]), {"1", "2"})


# --- rebalance_pelosi_mirror (end to end with fakes) ------------------------


class FakePM:
    def __init__(self, prices, holdings, cash):
        self._prices = prices
        self._holdings = holdings
        self._cash = cash
        self.buys: list = []
        self.sells: list = []

    def get_price(self, ticker):
        from portfolio import PortfolioError
        if ticker not in self._prices:
            raise PortfolioError(f"no price for {ticker}")
        return self._prices[ticker]

    def get_portfolio_book(self, pid):
        hv = sum(h["quantity"] * self._prices.get(h["ticker"], 0) for h in self._holdings)
        return {"cash_usd": self._cash, "total_value_usd": self._cash + hv,
                "holdings": list(self._holdings)}

    def buy_portfolio_atomic(self, pid, aid, ticker, qty, note="", thesis=None, **kw):
        self.buys.append((ticker, qty))
        return {"status": "ok"}

    def sell_portfolio_atomic(self, pid, aid, ticker, qty, note="", **kw):
        self.sells.append((ticker, qty))
        return {"status": "ok"}


class FakeDB:
    def __init__(self, trades):
        self._trades = trades
        self.logged: list = []

    def get_unmirrored_congress_trades(self, pid, aid, politician, *, since):
        # Return only trades not yet logged (simulating the real dedup).
        done = {r["congress_trade_id"] for r in self.logged}
        return [t for t in self._trades if t["id"] not in done]

    def record_congress_mirror(self, pid, aid, rows):
        self.logged.extend(rows)
        return len(rows)


def _ctx(pm, db, *, dry_run=False, params=None):
    return RebalanceContext(
        db=db, pm=pm, agent={"id": "pelosi-agent", "handle": "agent-pelosi"},
        dry_run=dry_run, params=params or {}, portfolio_id="port-1",
    )


class TestRebalance(unittest.TestCase):
    def _trades(self):
        return [
            _trade("t1", "NVDA", "buy"),
            _trade("t2", "AAPL", "sell"),
            _trade("t3", "XYZNOPRICE", "buy"),
        ]

    def test_mirrors_buys_and_sells_then_logs_all(self):
        pm = FakePM({"NVDA": 100.0, "AAPL": 200.0},
                    [{"ticker": "AAPL", "quantity": 20}], cash=100_000)
        db = FakeDB(self._trades())
        res = rebalance_pelosi_mirror(_ctx(pm, db))
        self.assertEqual(res.buys, 1)
        self.assertEqual(res.sells, 1)
        self.assertEqual(pm.buys[0][0], "NVDA")
        self.assertEqual(pm.sells[0][0], "AAPL")
        # every disclosure touched is logged (incl. the unpriced skip).
        logged_ids = {r["congress_trade_id"] for r in db.logged}
        self.assertEqual(logged_ids, {"t1", "t2", "t3"})

    def test_rerun_is_noop(self):
        pm = FakePM({"NVDA": 100.0, "AAPL": 200.0},
                    [{"ticker": "AAPL", "quantity": 20}], cash=100_000)
        db = FakeDB(self._trades())
        rebalance_pelosi_mirror(_ctx(pm, db))
        pm.buys.clear()
        pm.sells.clear()
        res2 = rebalance_pelosi_mirror(_ctx(pm, db))
        self.assertEqual(res2.buys, 0)
        self.assertEqual(res2.sells, 0)
        self.assertEqual(res2.notes.get("new_disclosures"), 0)

    def test_dry_run_writes_nothing(self):
        pm = FakePM({"NVDA": 100.0}, [], cash=100_000)
        db = FakeDB([_trade("t1", "NVDA", "buy")])
        res = rebalance_pelosi_mirror(_ctx(pm, db, dry_run=True))
        self.assertEqual(pm.buys, [])
        self.assertEqual(db.logged, [])
        self.assertIn("dry_run_plan", res.notes)

    def test_target_pct_param_respected(self):
        # 10% of $100k = $10k at $100 → 100 shares.
        pm = FakePM({"NVDA": 100.0}, [], cash=100_000)
        db = FakeDB([_trade("t1", "NVDA", "buy")])
        rebalance_pelosi_mirror(_ctx(pm, db, params={"target_position_pct": 10.0}))
        self.assertEqual(pm.buys[0][1], 100)


if __name__ == "__main__":
    unittest.main(verbosity=2)
