#!/usr/bin/env python3
"""Unit tests for the Level 0 universe & fact store.

Covers the pure logic that decides the universe — security-type
classification, the affordability gate, the price-row mapper — and the
FactStore distribution contract, all with stubbed dependencies (no live DB,
no EODHD calls). Run directly:

    pytest tests/test_level0.py
"""

from __future__ import annotations

import unittest

import universe_sync as us
import prices_daily_updater as pdu
import earnings_updater as eu
from level0 import FactStore


class TestClassifySecurity(unittest.TestCase):
    def _row(self, **kw):
        base = {"Code": "AAA", "Name": "Some Co", "Type": "Common Stock"}
        base.update(kw)
        return base

    def test_common_stock_kept(self):
        self.assertEqual(us.classify_security(self._row())[0], "Common Stock")

    def test_etf_dropped(self):
        self.assertIsNone(us.classify_security(self._row(Type="ETF")))

    def test_preferred_type_dropped(self):
        self.assertIsNone(us.classify_security(self._row(Type="Preferred Stock")))

    def test_fund_and_note_dropped(self):
        self.assertIsNone(us.classify_security(self._row(Type="FUND")))
        self.assertIsNone(us.classify_security(self._row(Type="Note")))

    def test_warrant_by_name_dropped(self):
        self.assertIsNone(
            us.classify_security(self._row(Name="Acme Inc Warrant")))

    def test_unit_by_name_dropped(self):
        self.assertIsNone(
            us.classify_security(self._row(Name="Acme Acquisition Unit")))

    def test_spac_by_name_dropped(self):
        self.assertIsNone(
            us.classify_security(self._row(Name="Pioneer Acquisition Corp")))

    def test_adr_tagged(self):
        self.assertEqual(
            us.classify_security(self._row(Name="Taiwan Semi ADR"))[0], "ADR")

    def test_reit_tagged(self):
        self.assertEqual(
            us.classify_security(self._row(Name="Prologis REIT Inc"))[0], "REIT")

    def test_dual_class_share_class_parsed(self):
        kind, share_class = us.classify_security(
            self._row(Code="BRK-A", Name="Berkshire Hathaway"))
        self.assertEqual(kind, "Common Stock")
        self.assertEqual(share_class, "A")

    def test_real_ticker_ending_in_w_not_dropped(self):
        # SNOW ends in W but is not a warrant — must survive.
        self.assertEqual(
            us.classify_security(self._row(Code="SNOW", Name="Snowflake Inc"))[0],
            "Common Stock")


class TestUsExchangeGate(unittest.TestCase):
    """Tier 1 is US-exchange-listed only — OTC / pink-sheet quotations drop."""

    def test_real_exchanges_kept(self):
        for ex in ("NYSE", "NASDAQ", "NYSE MKT", "NYSE ARCA", "BATS", "AMEX"):
            self.assertTrue(us.is_us_exchange_listed(ex), ex)

    def test_otc_tiers_dropped(self):
        for ex in ("OTCQX", "OTCQB", "PINK", "OTCMKTS", "OTCGREY", "OTC", "GREY", "NMFQS"):
            self.assertFalse(us.is_us_exchange_listed(ex), ex)

    def test_empty_exchange_fails_open(self):
        # Missing data must never false-delist a real listing.
        self.assertTrue(us.is_us_exchange_listed(None))
        self.assertTrue(us.is_us_exchange_listed(""))

    def test_case_insensitive(self):
        self.assertFalse(us.is_us_exchange_listed("otcqb"))
        self.assertTrue(us.is_us_exchange_listed("nasdaq"))


class TestAffordabilityGate(unittest.TestCase):
    def test_passes_when_liquid_and_priced(self):
        self.assertTrue(us.passes_gate(addv_30d=10_000_000, last_close=42.0, days=30))

    def test_fails_below_dollar_volume(self):
        self.assertFalse(us.passes_gate(addv_30d=1_000_000, last_close=42.0, days=30))

    def test_fails_penny_stock(self):
        self.assertFalse(us.passes_gate(addv_30d=10_000_000, last_close=0.5, days=30))

    def test_fails_insufficient_history(self):
        self.assertFalse(us.passes_gate(addv_30d=10_000_000, last_close=42.0, days=5))

    def test_fails_on_missing_stats(self):
        self.assertFalse(us.passes_gate(addv_30d=None, last_close=None, days=0))

    def test_boundary_exactly_at_thresholds(self):
        self.assertTrue(us.passes_gate(
            addv_30d=us.GATE_MIN_DOLLAR_VOLUME,
            last_close=us.GATE_MIN_PRICE,
            days=us.GATE_MIN_DAYS))

    def test_fails_when_eod_feed_has_gone_dark(self):
        # Liquid on the trailing window, but no bar has printed in weeks — an
        # acquired/halted name the symbol list still carries. Not tradable.
        self.assertFalse(us.passes_gate(
            addv_30d=10_000_000, last_close=42.0, days=30,
            days_since_last_bar=us.GATE_MAX_DARK_DAYS + 1))

    def test_passes_at_the_dark_boundary(self):
        self.assertTrue(us.passes_gate(
            addv_30d=10_000_000, last_close=42.0, days=30,
            days_since_last_bar=us.GATE_MAX_DARK_DAYS))


class TestPriceRowMapper(unittest.TestCase):
    def test_maps_and_computes_dollar_volume(self):
        row = pdu._row("NVDA", {
            "date": "2026-06-01", "open": 100, "high": 110, "low": 99,
            "close": 105, "adjusted_close": 105, "volume": 1000,
        })
        self.assertEqual(row["ticker"], "NVDA")
        self.assertEqual(row["dollar_volume"], 105 * 1000)
        self.assertEqual(row["adj_close"], 105)

    def test_drops_row_without_date_or_close(self):
        self.assertIsNone(pdu._row("X", {"close": 5}))
        self.assertIsNone(pdu._row("X", {"date": "2026-06-01"}))

    def test_null_volume_yields_null_dollar_volume(self):
        row = pdu._row("X", {"date": "2026-06-01", "close": 5, "volume": None})
        self.assertIsNone(row["dollar_volume"])


class TestEarningsEventMapper(unittest.TestCase):
    TIER1 = {"NVDA", "AAPL", "BRK-B"}

    def test_maps_report_date_to_earnings_event(self):
        row = eu._event_row(
            {"code": "NVDA.US", "report_date": "2026-08-27",
             "date": "2026-07-31", "before_after_market": "AfterMarket"},
            self.TIER1)
        self.assertEqual(row, {"ticker": "NVDA", "type": "earnings",
                               "date": "2026-08-27", "source": "eodhd"})

    def test_falls_back_to_period_end_when_no_report_date(self):
        row = eu._event_row({"code": "AAPL.US", "date": "2026-09-30"}, self.TIER1)
        self.assertEqual(row["date"], "2026-09-30")

    def test_drops_non_us_code(self):
        self.assertIsNone(
            eu._event_row({"code": "NVDA.LSE", "report_date": "2026-08-27"}, self.TIER1))

    def test_drops_name_outside_tier1(self):
        self.assertIsNone(
            eu._event_row({"code": "ZZZZ.US", "report_date": "2026-08-27"}, self.TIER1))

    def test_drops_row_without_any_date(self):
        self.assertIsNone(eu._event_row({"code": "NVDA.US"}, self.TIER1))

    def test_lowercase_code_is_normalized(self):
        row = eu._event_row({"code": "aapl.us", "report_date": "2026-08-27"}, self.TIER1)
        self.assertEqual(row["ticker"], "AAPL")


class TestRecentReporters(unittest.TestCase):
    ROWS = [
        {"ticker": "NVDA", "type": "earnings", "date": "2026-07-27"},  # in window
        {"ticker": "AAPL", "type": "earnings", "date": "2026-07-29"},  # today
        {"ticker": "MSFT", "type": "earnings", "date": "2026-09-01"},  # future
        {"ticker": "OLD", "type": "earnings", "date": "2026-01-01"},   # too old
    ]

    def test_selects_only_names_in_window(self):
        got = eu.recent_reporters(self.ROWS, "2026-07-26", "2026-07-29")
        self.assertEqual(got, ["AAPL", "NVDA"])

    def test_dedupes_and_sorts(self):
        rows = [
            {"ticker": "NVDA", "type": "earnings", "date": "2026-07-27"},
            {"ticker": "NVDA", "type": "earnings", "date": "2026-07-28"},
            {"ticker": "AAPL", "type": "earnings", "date": "2026-07-27"},
        ]
        self.assertEqual(eu.recent_reporters(rows, "2026-07-26", "2026-07-29"),
                         ["AAPL", "NVDA"])

    def test_empty_window_yields_nothing(self):
        self.assertEqual(eu.recent_reporters(self.ROWS, "2026-08-01", "2026-08-02"), [])


class _StubDB:
    """Minimal stub exposing only what FactStore.get_distribution needs."""

    def __init__(self, rows):
        self._rows = rows

    def get_metric_stats(self, metric=None, sector=None):
        return [r for r in self._rows
                if (metric is None or r["metric"] == metric)
                and (sector is None or r["sector"] == sector)]


class TestFactStoreDistribution(unittest.TestCase):
    def setUp(self):
        rows = [
            {"metric": "ps_now", "sector": "", "min_val": 0.5, "p25": 2,
             "p50": 5, "p75": 9, "max_val": 40, "sample_count": 1200,
             "computed_on": "2026-06-03"},
            {"metric": "ps_now", "sector": "Technology", "min_val": 1,
             "p25": 4, "p50": 8, "p75": 14, "max_val": 50, "sample_count": 300,
             "computed_on": "2026-06-03"},
        ]
        self.fs = FactStore(db=_StubDB(rows))

    def test_universe_scope_default(self):
        d = self.fs.get_distribution("ps_now")
        self.assertEqual(d["scope"], "universe")
        self.assertEqual(d["p50"], 5)
        self.assertEqual(d["n"], 1200)
        self.assertEqual(d["as_of"], "2026-06-03")

    def test_sector_scope(self):
        d = self.fs.get_distribution("ps_now", sector="Technology")
        self.assertEqual(d["scope"], "sector:Technology")
        self.assertEqual(d["p50"], 8)

    def test_missing_metric_returns_none(self):
        self.assertIsNone(self.fs.get_distribution("rule_of_40"))

    def test_all_distributions_keyed_by_metric(self):
        out = self.fs.get_all_distributions(sector="")
        self.assertIn("ps_now", out["metrics"])
        self.assertEqual(out["metrics"]["ps_now"]["p50"], 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
