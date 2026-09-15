"""Unit tests for the price_sales_updater run-budget fixes.

Context: every scheduled run from 2026-09-04 was killed by the workflow's
30-minute timeout, so the last complete pass was 2026-09-03 and daily P/S
coverage decayed from 2,909 names to 1,424 against a 3,051-name Tier 1
universe. Two things here guard the fix — that a truncated run serves the
stalest names rather than an arbitrary slice, and that the pre-091 fallback
read stays bounded instead of scanning the whole 211 MB table.
"""

import logging
import unittest
from datetime import date, timedelta
from unittest import mock

import db as db_module
import price_sales_updater as psu
from price_sales_updater import (
    REFUSED,
    get_reported_ps,
    get_revenue_currency,
    get_revenue_ttm,
    order_by_staleness,
    resolve_ps,
    statement_revenue_ttm,
)


def _items(*tickers):
    return [{"ticker": t, "exchange": "NASDAQ", "company_name": t} for t in tickers]


class OrderByStalenessTests(unittest.TestCase):
    def test_never_valued_names_go_first(self):
        items = _items("AAA", "BBB", "CCC")
        ps_map = {
            "AAA": {"last_updated": "2026-09-08"},
            "CCC": {"last_updated": "2026-09-01"},
            # BBB has no valuation row at all
        }
        out = [i["ticker"] for i in order_by_staleness(items, ps_map)]
        self.assertEqual(out, ["BBB", "CCC", "AAA"])

    def test_oldest_date_first(self):
        items = _items("AAA", "BBB", "CCC")
        ps_map = {
            "AAA": {"last_updated": "2026-09-08"},
            "BBB": {"last_updated": "2026-08-20"},
            "CCC": {"last_updated": "2026-09-03"},
        }
        out = [i["ticker"] for i in order_by_staleness(items, ps_map)]
        self.assertEqual(out, ["BBB", "CCC", "AAA"])

    def test_a_truncated_run_serves_the_starved_tail(self):
        # The real failure mode: a run gets through ~1,400 of 3,051 names. The
        # names it reaches must be the ones that have gone longest without an
        # update, so successive partial runs converge instead of starving a tail.
        items = _items(*[f"T{i:03d}" for i in range(10)])
        today = date(2026, 9, 8)
        ps_map = {
            # T000-T004 refreshed today; T005-T009 last seen a week+ ago.
            f"T{i:03d}": {
                "last_updated": (today if i < 5 else today - timedelta(days=8 + i)).isoformat()
            }
            for i in range(10)
        }
        out = [i["ticker"] for i in order_by_staleness(items, ps_map)]
        self.assertEqual(set(out[:5]), {"T005", "T006", "T007", "T008", "T009"})

    def test_missing_last_updated_key_is_treated_as_never_valued(self):
        items = _items("AAA", "BBB")
        ps_map = {"AAA": {"last_updated": None}, "BBB": {"last_updated": "2026-09-08"}}
        out = [i["ticker"] for i in order_by_staleness(items, ps_map)]
        self.assertEqual(out, ["AAA", "BBB"])

    def test_every_item_survives_the_reordering(self):
        items = _items("AAA", "BBB", "CCC", "DDD")
        out = order_by_staleness(items, {"BBB": {"last_updated": "2026-09-08"}})
        self.assertEqual(len(out), 4)
        self.assertEqual({i["ticker"] for i in out}, {"AAA", "BBB", "CCC", "DDD"})
        self.assertIs(out[0].__class__, dict)


class _FakeQuery:
    """Records the PostgREST filters a read applies, and returns canned rows."""

    def __init__(self, recorder, rows):
        self.recorder = recorder
        self.rows = rows

    def select(self, cols):
        self.recorder["columns"] = cols
        return self

    def gte(self, col, val):
        self.recorder["gte"] = (col, val)
        return self

    def order(self, col, desc=False):
        return self

    def range(self, lo, hi):
        self.recorder["ranges"].append((lo, hi))
        self._lo, self._hi = lo, hi
        return self

    def execute(self):
        return type("R", (), {"data": self.rows if self._lo == 0 else []})()


class _FakeClient:
    def __init__(self, recorder, rows, rpc_works):
        self.recorder = recorder
        self.rows = rows
        self.rpc_works = rpc_works

    def rpc(self, name, *_a, **_kw):
        self.recorder["rpc"] = name
        if not self.rpc_works:
            raise RuntimeError(
                'Could not find the function public.latest_valuation_state'
            )
        return _FakeQuery(self.recorder, self.rows)

    def table(self, name):
        self.recorder["table"] = name
        return _FakeQuery(self.recorder, self.rows)


class LatestValuationReadTests(unittest.TestCase):
    def _db(self, rows, rpc_works):
        recorder = {"ranges": []}
        inst = db_module.SupabaseDB.__new__(db_module.SupabaseDB)
        inst.client = _FakeClient(recorder, rows, rpc_works)
        return inst, recorder

    def test_prefers_the_rpc(self):
        rows = [{"ticker": "AAA", "date": "2026-09-08", "ps": 3.0,
                 "ps_ath": 5.0, "history_json": []}]
        inst, rec = self._db(rows, rpc_works=True)
        out = inst.get_all_valuation_latest()
        self.assertEqual(rec["rpc"], "latest_valuation_state")
        self.assertNotIn("table", rec)  # never touched the raw table
        self.assertEqual(set(out), {"AAA"})

    def test_falls_back_to_a_bounded_window_when_the_rpc_is_missing(self):
        # Pre-091 deploys must still work — and the fallback must NOT repeat the
        # unbounded full-table scan that caused the timeout.
        rows = [{"ticker": "AAA", "date": "2026-09-08", "ps": 3.0,
                 "ps_ath": 5.0, "history_json": []}]
        inst, rec = self._db(rows, rpc_works=False)
        out = inst.get_all_valuation_latest(lookback_days=30)
        self.assertEqual(rec["table"], "valuation")
        col, floor = rec["gte"]
        self.assertEqual(col, "date")
        self.assertEqual(
            floor, (date.today() - timedelta(days=30)).isoformat()
        )
        self.assertEqual(set(out), {"AAA"})

    def test_fallback_never_selects_star(self):
        # Migration 044 already learned that dragging history_json wholesale is
        # what makes valuation reads expensive; keep the column list narrow.
        inst, rec = self._db([], rpc_works=False)
        inst.get_all_valuation_latest()
        self.assertNotIn("*", rec["columns"])
        self.assertIn("history_json", rec["columns"])

    def test_empty_rpc_result_is_not_mistaken_for_an_unavailable_rpc(self):
        inst, rec = self._db([], rpc_works=True)
        out = inst.get_all_valuation_latest()
        self.assertEqual(out, {})
        self.assertNotIn("table", rec)  # did not fall back


class ResolvePsTests(unittest.TestCase):
    """A P/S is only a P/S when numerator and denominator share a currency.

    EODHD reports market cap in USD for a US listing but leaves the income
    statement in the filing currency, so mcap/revenue silently divided dollars
    by pesos for US-listed ADRs. The observed errors tracked each home FX rate
    exactly: FMX (MXN) 0.05 vs a true ~1.0, TME (CNY) 0.40 vs ~2.8, TGS (ARS)
    rounded to 0.00. The first fix fell back to EODHD's reported multiple for
    those names; the 2026-09-14 run proved that multiple carries the SAME
    error (TSM "reported (TWD revenue)" → 0.51), so the resolver now converts
    the revenue at the day's rate and never trusts the reported figure for a
    foreign statement.
    """

    def test_plain_usd_name_uses_the_derived_ratio(self):
        ps, reason = resolve_ps(1_000.0, 100.0, None, "USD")
        self.assertAlmostEqual(ps, 10.0)
        self.assertEqual(reason, "derived")

    def test_undeclared_currency_still_uses_the_derived_ratio(self):
        # Most US names declare nothing; behaviour must be unchanged for them.
        ps, reason = resolve_ps(1_000.0, 100.0, None, None)
        self.assertAlmostEqual(ps, 10.0)
        self.assertEqual(reason, "derived")

    def test_foreign_currency_revenue_is_converted_at_the_rate(self):
        # TSM, 2026-09-14: market cap ~$1.2T over TTM revenue ~TWD 4.45T at
        # ~0.0312 USD/TWD is a P/S of ~8.6 — not the 0.51 the run wrote.
        ps, reason = resolve_ps(1.2e12, 4.45e12, 0.51, "TWD", 0.0312)
        self.assertAlmostEqual(ps, 1.2e12 / (4.45e12 * 0.0312))
        self.assertAlmostEqual(ps, 8.64, places=1)
        self.assertIn("TWD", reason)
        self.assertTrue(reason.startswith("derived"))

    def test_foreign_currency_never_falls_back_to_the_reported_multiple(self):
        # FMX: EODHD's own PriceSalesTTM (0.05) is built from the same USD
        # market cap and MXN revenue, so it is exactly as wrong as the division.
        ps, reason = resolve_ps(1_000.0, 20_000.0, 0.05, "MXN", None)
        self.assertIsNone(ps)
        self.assertTrue(reason.startswith(REFUSED), reason)
        self.assertIn("MXN", reason)

    def test_foreign_currency_without_a_rate_is_a_tombstoning_refusal(self):
        # Refusing is the point, and it must be the kind of refusal that
        # replaces the previous (wrong) row rather than leaving it standing.
        ps, reason = resolve_ps(1_000.0, 20_000.0, None, "ARS")
        self.assertIsNone(ps)
        self.assertTrue(reason.startswith(REFUSED), reason)
        self.assertIn("ARS", reason)

    def test_zero_or_negative_rate_is_treated_as_unknown(self):
        self.assertIsNone(resolve_ps(1_000.0, 20_000.0, None, "ARS", 0.0)[0])
        self.assertIsNone(resolve_ps(1_000.0, 20_000.0, None, "ARS", -1.0)[0])

    def test_undeclared_currency_caught_by_disagreement_with_eodhd(self):
        # The currency-agnostic backstop: derived 0.05 vs reported 1.0 is 20x.
        # Neither side can be trusted at that point, so the name is refused
        # (and tombstoned), not ranked on whichever looks nicer.
        ps, reason = resolve_ps(1_000.0, 20_000.0, 1.0, None)
        self.assertIsNone(ps)
        self.assertTrue(reason.startswith(REFUSED), reason)
        self.assertIn("20x", reason)

    def test_small_disagreement_keeps_the_derived_ratio(self):
        # Different TTM cut-offs disagree by a few percent; that is not a fault.
        ps, reason = resolve_ps(1_000.0, 100.0, 10.4, None)
        self.assertAlmostEqual(ps, 10.0)
        self.assertEqual(reason, "derived")

    def test_disagreement_just_under_the_threshold_is_tolerated(self):
        ps, _ = resolve_ps(1_000.0, 100.0, 10.0 / 2.9, None)
        self.assertAlmostEqual(ps, 10.0)

    def test_reported_used_when_market_cap_is_missing(self):
        ps, reason = resolve_ps(None, 100.0, 4.2, "USD")
        self.assertAlmostEqual(ps, 4.2)
        self.assertIn("no market cap", reason)

    def test_reported_not_used_for_a_foreign_name_missing_market_cap(self):
        self.assertIsNone(resolve_ps(None, 100.0, 4.2, "JPY", 0.0067)[0])

    def test_no_usable_input_refuses(self):
        self.assertIsNone(resolve_ps(None, 100.0, None, None)[0])
        self.assertIsNone(resolve_ps(0.0, 100.0, None, None)[0])
        self.assertIsNone(resolve_ps(1_000.0, 0.0, None, None)[0])

    def test_plain_skips_are_not_tombstoning_refusals(self):
        # No revenue (a pre-revenue biotech) is a skip: nothing wrong stands
        # in the table, so nothing needs replacing.
        _, reason = resolve_ps(1_000.0, 0.0, None, None)
        self.assertFalse(reason.startswith(REFUSED), reason)

    def test_reported_ps_of_zero_is_not_treated_as_a_value(self):
        # get_reported_ps already filters these out, but the resolver must not
        # resurrect a zero if one reaches it.
        ps, _ = resolve_ps(1_000.0, 100.0, 0.0, None)
        self.assertAlmostEqual(ps, 10.0)


def _twd_fundamentals(mcap: float = 1.2e12, reported_ps: float = 0.51,
                      highlights_ttm: float = 4.45e12) -> dict:
    """An EODHD payload shaped like TSM.US: USD market cap, TWD statements
    whose four latest quarters sum to TWD 4.45T."""
    quarterly = {
        "2026-06-30": {"totalRevenue": 1.27e12},
        "2026-03-31": {"totalRevenue": 1.13e12},
        "2025-12-31": {"totalRevenue": 1.06e12},
        "2025-09-30": {"totalRevenue": 0.99e12},
        "2025-06-30": {"totalRevenue": 0.93e12},
    }
    return {
        "General": {"Name": "Taiwan Semiconductor", "CurrencyCode": "USD"},
        "Highlights": {"MarketCapitalization": mcap, "RevenueTTM": highlights_ttm},
        "Valuation": {"PriceSalesTTM": reported_ps},
        "Financials": {"Income_Statement": {"currency_symbol": "TWD",
                                            "quarterly": quarterly}},
    }


class RevenueTtmSourceTests(unittest.TestCase):
    """Which revenue a conversion is applied to matters as much as the rate."""

    def test_usd_name_keeps_the_highlights_figure(self):
        f = _twd_fundamentals(highlights_ttm=4.6e12)
        self.assertEqual(get_revenue_ttm(f), 4.6e12)

    def test_foreign_filer_sums_the_statement_that_declares_the_currency(self):
        # If EODHD ever pre-converts Highlights.RevenueTTM for an issuer, a
        # second conversion would be a ~30x error on a TWD name. The quarterly
        # income statement is the block that says "TWD", so its sum is TWD.
        f = _twd_fundamentals(highlights_ttm=139e9)  # a USD-looking figure
        self.assertAlmostEqual(get_revenue_ttm(f, from_statement=True), 4.45e12)
        self.assertAlmostEqual(statement_revenue_ttm(f), 4.45e12)

    def test_fewer_than_four_quarters_falls_back_to_highlights(self):
        f = _twd_fundamentals()
        q = f["Financials"]["Income_Statement"]["quarterly"]
        for k in list(q)[2:]:
            del q[k]
        self.assertIsNone(statement_revenue_ttm(f))
        self.assertEqual(get_revenue_ttm(f, from_statement=True), 4.45e12)


class ComputePsForTickerCurrencyTests(unittest.TestCase):
    """The per-ticker path: conversion when a rate exists, a tombstone when
    it does not, and a rebuild when the prior row carries no curve."""

    def setUp(self):
        self.logger = logging.getLogger("test_price_sales_updater")
        self.today = date.today()

    def _run(self, fundamentals, existing, rate):
        with mock.patch.object(psu, "fetch_fundamentals", return_value=fundamentals), \
             mock.patch.object(psu.fx, "usd_per_unit", return_value=rate), \
             mock.patch.object(psu, "_build_weekly_history",
                               side_effect=lambda t, e, ps, lf, lg: [[lf, ps]]):
            return psu.compute_ps_for_ticker(
                "TSM", "NYSE", existing, self.today, self.today, self.logger)

    def test_foreign_statement_is_converted_not_reported(self):
        out = self._run(_twd_fundamentals(), None, 0.0312)
        self.assertEqual(out["mode"], "backfill")
        self.assertAlmostEqual(out["ps_now"], 8.64, places=1)

    def test_no_rate_writes_a_tombstone_not_nothing(self):
        # A refusal that wrote nothing left TSM's 0.51 as the latest row the
        # screener read. The tombstone is a dated row with every P/S NULL.
        existing = {"history_json": [["2026-09-05", 0.5], ["2026-09-12", 0.51]],
                    "ath": 0.55, "last_updated": "2026-09-14"}
        out = self._run(_twd_fundamentals(), existing, None)
        self.assertEqual(out["mode"], "tombstone")
        for key in ("ps_now", "high_52w", "low_52w", "median_12m", "ath",
                    "pct_of_ath", "history_json"):
            self.assertIsNone(out[key], key)
        self.assertIn("TWD", out["reason"])

    def test_row_after_a_tombstone_rebuilds_the_curve(self):
        # The day after a tombstone the prior row has no history. The
        # append-only path would find nothing to append to and skip the name
        # every non-Friday; it must rebuild from prices like a first backfill.
        existing = {"history_json": None, "ath": None, "last_updated": "2026-09-15"}
        out = self._run(_twd_fundamentals(), existing, 0.0312)
        self.assertEqual(out["mode"], "update")
        self.assertAlmostEqual(out["ps_now"], 8.64, places=1)
        self.assertEqual(len(out["history_json"]), 1)
        self.assertAlmostEqual(out["ath"], out["ps_now"])

    def test_tombstone_row_maps_to_null_valuation_columns(self):
        row = psu.tombstone_row("TSM", "Taiwan Semiconductor", "refused: x")
        self.assertIsNone(row["ps_now"])
        self.assertIsNone(row["history_json"])
        self.assertEqual(row["mode"], "tombstone")


class ExtractorTests(unittest.TestCase):
    def test_revenue_currency_read_from_the_income_statement(self):
        f = {"Financials": {"Income_Statement": {"currency_symbol": "mxn"}}}
        self.assertEqual(get_revenue_currency(f), "MXN")

    def test_revenue_currency_ignores_the_listing_currency(self):
        # General.CurrencyCode is USD for exactly the ADRs this check exists
        # for, so falling back to it would blind the check.
        f = {"General": {"CurrencyCode": "USD"},
             "Financials": {"Income_Statement": {}}}
        self.assertIsNone(get_revenue_currency(f))

    def test_revenue_currency_absent_blocks(self):
        self.assertIsNone(get_revenue_currency({}))
        self.assertIsNone(get_revenue_currency({"Financials": None}))

    def test_reported_ps_extraction(self):
        self.assertAlmostEqual(
            get_reported_ps({"Valuation": {"PriceSalesTTM": "2.5"}}), 2.5
        )
        self.assertIsNone(get_reported_ps({"Valuation": {"PriceSalesTTM": 0}}))
        self.assertIsNone(get_reported_ps({"Valuation": {"PriceSalesTTM": None}}))
        self.assertIsNone(get_reported_ps({}))


if __name__ == "__main__":
    unittest.main()
