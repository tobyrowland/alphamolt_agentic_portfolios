#!/usr/bin/env python3
"""The snapshot writer must actually use the time-weighted maths (migration 090).

`tests/test_returns.py` proves the arithmetic. It cannot prove that the daily
job feeds it the right inputs, and those are exactly what is easy to get wrong:
chaining off TODAY's half-written row instead of yesterday's, or counting a
baseline correction as if capital had moved. Either produces a plausible
number that is silently wrong, which is the failure mode this whole change
exists to remove.

No DB: a duck-typed stub standing in for the handful of reads `snapshot_all`
makes.
"""
from __future__ import annotations

import unittest

from portfolio import PortfolioManager
from db import SupabaseDB


BOOK = {
    "cash_usd": 419.15,
    "holdings_value_usd": 39071.88,
    "total_value_usd": 39491.03,
    "pnl_usd": -109.58,
    "pnl_pct": -0.2767,
    "holdings": [{"ticker": "ZBRA"}],
}


class _StubDB:
    """Only what snapshot_all touches."""

    NON_FLOW_LEDGER_REASONS = SupabaseDB.NON_FLOW_LEDGER_REASONS

    def __init__(self, *, flows=None, priors=None, flows_raise=False, priors_raise=False):
        self._flows = flows or {}
        self._priors = priors or {}
        self._flows_raise = flows_raise
        self._priors_raise = priors_raise
        self.written: list[dict] = []
        self.flow_dates: list[str] = []
        self.prior_dates: list[str] = []

    def get_all_agent_accounts(self):
        return []

    def get_all_portfolio_accounts(self):
        return [{"portfolio_id": "p1"}]

    def get_portfolio_flows_for_date(self, snapshot_date):
        self.flow_dates.append(snapshot_date)
        if self._flows_raise:
            raise RuntimeError("ledger unavailable")
        return dict(self._flows)

    def get_prior_snapshots(self, before_date):
        self.prior_dates.append(before_date)
        if self._priors_raise:
            raise RuntimeError("history unavailable")
        return dict(self._priors)

    def upsert_portfolio_snapshot(self, row):
        self.written.append(row)


def _snapshot(db, as_of="2026-08-27"):
    """Run the REAL snapshot_all, with only the valuation itself stubbed.

    `get_portfolio_book` is a PortfolioManager method (it prices holdings), so
    it is replaced on the instance rather than on the db stub. Everything under
    test — the flow read, the prior-snapshot read, the index step and the row
    that gets written — is the production code path.
    """
    from datetime import date

    y, m, d = (int(x) for x in as_of.split("-"))
    pm = PortfolioManager(db)
    pm.get_portfolio_book = lambda portfolio_id: dict(BOOK)  # type: ignore[method-assign]
    pm.snapshot_all(as_of=date(y, m, d))
    return db.written[0]


class SnapshotWritesTheIndexTests(unittest.TestCase):
    def test_the_columns_are_written(self):
        row = _snapshot(_StubDB(
            flows={"p1": 12149.0},
            priors={"p1": {"total_value_usd": 27600.0, "twr_index": 1.0021}},
        ))
        self.assertIn("flow_usd", row)
        self.assertIn("twr_index", row)

    def test_the_days_flow_is_removed_from_the_days_return(self):
        """27 Aug: value jumps 27,600 -> 39,491 on a 12,149 credit. The day is
        -0.94%, not +43%. Getting this wrong is the entire bug."""
        row = _snapshot(_StubDB(
            flows={"p1": 12149.0},
            priors={"p1": {"total_value_usd": 27600.0, "twr_index": 1.0}},
        ))
        self.assertAlmostEqual((row["twr_index"] - 1.0) * 100, -0.935, places=2)

    def test_it_chains_off_yesterday_not_today(self):
        """The intraday job rewrites today's row many times. Chaining off a
        value this same run is about to replace would compound a partial day
        against itself, so the read must be strictly before today."""
        db = _StubDB(priors={"p1": {"total_value_usd": 39000.0, "twr_index": 1.0}})
        _snapshot(db, as_of="2026-08-27")
        self.assertEqual(db.prior_dates, ["2026-08-27"])   # `lt` this date
        self.assertEqual(db.flow_dates, ["2026-08-27"])

    def test_a_first_ever_snapshot_starts_at_one(self):
        """No prior row: the funding that created the portfolio is not a
        return, however far the first mark sits from the money paid in."""
        row = _snapshot(_StubDB(flows={"p1": 9999.97}, priors={}))
        self.assertEqual(row["twr_index"], 1.0)

    def test_a_flow_free_portfolio_is_a_plain_value_ratio(self):
        """The property that makes this safe to ship: with no flows the index
        is exactly the old arithmetic, so no paper book's number moves."""
        row = _snapshot(_StubDB(
            priors={"p1": {"total_value_usd": 39000.0, "twr_index": 2.0}},
        ))
        self.assertAlmostEqual(row["twr_index"], 2.0 * (39491.03 / 39000.0), places=8)


class FailSoftTests(unittest.TestCase):
    """Losing a day's history is worse than losing a day's index — the backfill
    can rebuild an index, but nothing can rebuild an unwritten snapshot."""

    def test_a_broken_ledger_read_still_writes_the_snapshot(self):
        db = _StubDB(flows_raise=True,
                     priors={"p1": {"total_value_usd": 39000.0, "twr_index": 1.0}})
        row = _snapshot(db)
        self.assertEqual(row["total_value_usd"], 39491.03)
        self.assertEqual(row["flow_usd"], 0)

    def test_a_broken_history_read_still_writes_the_snapshot(self):
        db = _StubDB(priors_raise=True)
        row = _snapshot(db)
        self.assertEqual(row["total_value_usd"], 39491.03)


class LedgerReasonTests(unittest.TestCase):
    def test_a_baseline_reset_is_not_a_flow(self):
        """`live_cash.py --fix-baselines` corrects a number; no money moves.
        Counting it would delete a return the portfolio genuinely earned."""
        self.assertIn("baseline-reset", SupabaseDB.NON_FLOW_LEDGER_REASONS)

    def test_real_movements_are_flows(self):
        for reason in ("credit", "debit", "fund-in-kind-in", "fund-in-kind-out",
                       "repair-topup"):
            with self.subTest(reason=reason):
                self.assertNotIn(reason, SupabaseDB.NON_FLOW_LEDGER_REASONS)


if __name__ == "__main__":
    unittest.main()
