"""Unit tests for fx.py and the currency localisation in eodhd_updater.

Context: a US-listed ADR's EODHD statements are in its filing currency while
the price and market cap are USD. On 2026-09-14 `screen_facts_mv` carried a
P/S of 0.51 for TSM (TWD statements; true ~9), 0.14 for ASX, 0.01 for JKS,
and the quarterly `revenue` series read LG Display at 5.7 trillion a quarter
(won). The Value lens ranked those names as the cheapest in any screen that
included them and "Revenue (TTM) ≥ $500M" passed every sub-scale foreign name.
No network anywhere below — the rate fetch is injected.
"""

import unittest
from unittest import mock

import fx
from eodhd_updater import (
    ABSOLUTE_FIELDS,
    fx_for,
    localize_absolutes,
    localize_series,
)


class NormaliseCurrencyTests(unittest.TestCase):
    def test_major_codes_pass_through_upper_cased(self):
        self.assertEqual(fx.normalise_currency("twd"), ("TWD", 1.0))
        self.assertEqual(fx.normalise_currency(" USD "), ("USD", 1.0))

    def test_minor_units_fold_into_their_major(self):
        # A statement "in GBX" is in pence: the GBP rate applies to 1/100th.
        self.assertEqual(fx.normalise_currency("GBX"), ("GBP", 100.0))
        self.assertEqual(fx.normalise_currency("ILA"), ("ILS", 100.0))
        self.assertEqual(fx.normalise_currency("ZAc"), ("ZAR", 100.0))

    def test_blank_or_missing_is_unknown(self):
        self.assertEqual(fx.normalise_currency(None), (None, 1.0))
        self.assertEqual(fx.normalise_currency(""), (None, 1.0))
        self.assertEqual(fx.normalise_currency(12), (None, 1.0))


class RevenueCurrencyTests(unittest.TestCase):
    def test_read_from_the_income_statement(self):
        f = {"Financials": {"Income_Statement": {"currency_symbol": "twd"}}}
        self.assertEqual(fx.revenue_currency(f), "TWD")

    def test_listing_currency_is_never_used(self):
        # General.CurrencyCode is USD for exactly the ADRs this exists for.
        f = {"General": {"CurrencyCode": "USD"}, "Financials": {"Income_Statement": {}}}
        self.assertIsNone(fx.revenue_currency(f))

    def test_malformed_payloads_are_undeclared(self):
        self.assertIsNone(fx.revenue_currency(None))
        self.assertIsNone(fx.revenue_currency({}))
        self.assertIsNone(fx.revenue_currency({"Financials": None}))
        self.assertIsNone(fx.revenue_currency({"Financials": {"Income_Statement": "x"}}))


class ConversionTests(unittest.TestCase):
    def test_to_usd(self):
        self.assertAlmostEqual(fx.to_usd(1000.0, 0.0312), 31.2)
        self.assertIsNone(fx.to_usd(None, 0.0312))
        self.assertIsNone(fx.to_usd(1000.0, None))
        self.assertIsNone(fx.to_usd(1000.0, 0.0))

    def test_convert_series_keeps_positions(self):
        # TSM's quarters in TWD → USD; a missing quarter stays None in place.
        s = [1_270_381e6, None, 1_055_976e6]
        out = fx.convert_series(s, 0.0312)
        self.assertEqual(len(out), 3)
        self.assertAlmostEqual(out[0], round(1_270_381e6 * 0.0312, 2))
        self.assertIsNone(out[1])
        self.assertAlmostEqual(out[2], round(1_055_976e6 * 0.0312, 2))

    def test_convert_series_without_a_rate_nulls_every_amount(self):
        # The series stays (the quarters existed); the amounts do not, so the
        # missing-datum rule excludes the name rather than reading won as $.
        self.assertEqual(fx.convert_series([5.7e12, 5.5e12], None), [None, None])
        self.assertIsNone(fx.convert_series(None, 0.5))


class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


class FetchUsdRateTests(unittest.TestCase):
    """EODHD quotes majors as XXXUSD and the rest as USDXXX; both are tried."""

    def test_direct_pair(self):
        def get(url, params=None, timeout=None):
            self.assertIn("EURUSD.FOREX", url)
            return _Resp(200, {"code": "EURUSD.FOREX", "close": 1.08})
        self.assertAlmostEqual(fx.fetch_usd_rate("EUR", "k", get=get), 1.08)

    def test_inverse_pair_is_inverted(self):
        calls = []

        def get(url, params=None, timeout=None):
            calls.append(url)
            if "TWDUSD" in url:
                return _Resp(404, {})
            return _Resp(200, {"code": "USDTWD.FOREX", "close": 32.05})
        rate = fx.fetch_usd_rate("TWD", "k", get=get)
        self.assertAlmostEqual(rate, 1 / 32.05)
        self.assertEqual(len(calls), 2)

    def test_no_pair_at_all_is_none(self):
        get = lambda url, params=None, timeout=None: _Resp(404, {})  # noqa: E731
        self.assertIsNone(fx.fetch_usd_rate("XYZ", "k", get=get))

    def test_na_close_is_none(self):
        # EODHD returns "NA" for a pair with no quote — not a rate of zero.
        get = lambda url, params=None, timeout=None: _Resp(200, {"close": "NA"})  # noqa: E731
        self.assertIsNone(fx.fetch_usd_rate("XYZ", "k", get=get))

    def test_eod_list_shape_uses_the_last_row(self):
        get = lambda url, params=None, timeout=None: _Resp(  # noqa: E731
            200, [{"close": 1.0}, {"close": 1.1}])
        self.assertAlmostEqual(fx.fetch_usd_rate("GBP", "k", get=get), 1.1)

    def test_usd_is_one_without_a_call(self):
        get = mock.Mock(side_effect=AssertionError("must not fetch"))
        self.assertEqual(fx.fetch_usd_rate("USD", "k", get=get), 1.0)


class FxRatesCacheTests(unittest.TestCase):
    def test_one_fetch_per_currency(self):
        fetch = mock.Mock(return_value=0.0312)
        rates = fx.FxRates(api_key="k", fetch=fetch)
        self.assertAlmostEqual(rates.usd_per_unit("TWD"), 0.0312)
        self.assertAlmostEqual(rates.usd_per_unit("twd"), 0.0312)
        self.assertEqual(fetch.call_count, 1)

    def test_minor_unit_divides_the_major_rate(self):
        rates = fx.FxRates(api_key="k", fetch=mock.Mock(return_value=1.30))
        self.assertAlmostEqual(rates.usd_per_unit("GBX"), 0.013)

    def test_a_miss_is_cached_and_reported_as_none(self):
        fetch = mock.Mock(return_value=None)
        rates = fx.FxRates(api_key="k", fetch=fetch)
        self.assertIsNone(rates.usd_per_unit("ARS"))
        self.assertIsNone(rates.usd_per_unit("ARS"))
        self.assertEqual(fetch.call_count, 1)

    def test_a_fetch_exception_never_propagates(self):
        rates = fx.FxRates(api_key="k", fetch=mock.Mock(side_effect=RuntimeError("boom")))
        self.assertIsNone(rates.usd_per_unit("KRW"))

    def test_usd_and_unknown_codes_need_no_fetch(self):
        fetch = mock.Mock(side_effect=AssertionError("must not fetch"))
        rates = fx.FxRates(api_key="k", fetch=fetch)
        self.assertEqual(rates.usd_per_unit("USD"), 1.0)
        self.assertIsNone(rates.usd_per_unit(None))


class LocalizeTests(unittest.TestCase):
    """The write-side helpers eodhd_updater applies to every fetched name."""

    def test_usd_or_undeclared_statement_is_untouched(self):
        s = {"period_ends": ["q1"], "revenue": [100.0], "gross_margin": [50.0]}
        self.assertIs(localize_series(s, None, 1.0), s)
        self.assertEqual(fx_for({"Financials": {"Income_Statement": {"currency_symbol": "USD"}}}),
                         (None, 1.0))
        self.assertEqual(fx_for({}), (None, 1.0))

    def test_foreign_series_is_converted_and_labelled(self):
        s = {"period_ends": ["q1", "q2"], "revenue": [1.27e12, 1.13e12],
             "rev_growth_yoy": [36.0, 40.0], "gross_margin": [64.0, 60.0]}
        out = localize_series(s, "TWD", 0.0312)
        self.assertAlmostEqual(out["revenue"][0], round(1.27e12 * 0.0312, 2))
        self.assertEqual(out["revenue_currency"], "TWD")
        self.assertAlmostEqual(out["fx_usd_per_unit"], 0.0312)
        # Ratios of the same-currency series are currency-free: untouched.
        self.assertEqual(out["rev_growth_yoy"], [36.0, 40.0])
        self.assertEqual(out["gross_margin"], [64.0, 60.0])
        self.assertEqual(s["revenue"][0], 1.27e12)  # input not mutated

    def test_foreign_series_without_a_rate_is_nulled(self):
        s = {"period_ends": ["q1"], "revenue": [5.7e12]}
        out = localize_series(s, "KRW", None)
        self.assertEqual(out["revenue"], [None])
        self.assertEqual(out["revenue_currency"], "KRW")
        self.assertIsNone(out["fx_usd_per_unit"])

    def test_absolutes_follow_the_same_rule(self):
        r = {"cash": 2.0e12, "debt": 1.0e12, "net_debt_ebitda": 0.5, "gross_margin": 60.0}
        localize_absolutes(r, "TWD", 0.0312)
        self.assertAlmostEqual(r["cash"], round(2.0e12 * 0.0312, 2))
        self.assertAlmostEqual(r["debt"], round(1.0e12 * 0.0312, 2))
        self.assertEqual(r["net_debt_ebitda"], 0.5)  # a ratio: untouched
        self.assertEqual(r["gross_margin"], 60.0)
        r2 = {"cash": 2.0e12}
        localize_absolutes(r2, "KRW", None)
        self.assertIsNone(r2["cash"])
        self.assertIn("cash", ABSOLUTE_FIELDS)


def _tsm_payload() -> dict:
    """An EODHD fundamentals payload shaped like TSM.US: TWD statements."""
    q = {
        "2026-06-30": {"totalRevenue": 1.27e12, "grossProfit": 0.8e12,
                       "operatingIncome": 0.6e12, "netIncome": 0.5e12},
        "2026-03-31": {"totalRevenue": 1.13e12, "grossProfit": 0.7e12,
                       "operatingIncome": 0.55e12, "netIncome": 0.45e12},
        "2025-12-31": {"totalRevenue": 1.06e12, "grossProfit": 0.65e12,
                       "operatingIncome": 0.5e12, "netIncome": 0.4e12},
        "2025-09-30": {"totalRevenue": 0.99e12, "grossProfit": 0.6e12,
                       "operatingIncome": 0.45e12, "netIncome": 0.38e12},
        "2025-06-30": {"totalRevenue": 0.93e12, "grossProfit": 0.55e12,
                       "operatingIncome": 0.42e12, "netIncome": 0.35e12},
    }
    y = {"2025-12-31": {"totalRevenue": 3.8e12, "netIncome": 1.5e12}}
    return {
        "General": {"Name": "Taiwan Semiconductor", "CurrencyCode": "USD"},
        "Highlights": {"MarketCapitalization": 1.2e12},
        "Financials": {
            "Income_Statement": {"currency_symbol": "TWD", "yearly": y, "quarterly": q},
            "Balance_Sheet": {"quarterly": {}},
            "Cash_Flow": {"quarterly": {}},
        },
        "Earnings": {"History": {}},
    }


class FetchEodhdDataTests(unittest.TestCase):
    """End to end through the metrics builder, with the fetch and the rate
    injected: the stored series reads in USD and says so."""

    def _run(self, rate):
        import eodhd_updater
        with mock.patch.object(eodhd_updater, "fetch_fundamentals_with_fallbacks",
                               return_value=_tsm_payload()), \
             mock.patch.object(eodhd_updater.fx, "usd_per_unit", return_value=rate):
            return eodhd_updater.fetch_eodhd_data(
                "TSM", "k", __import__("logging").getLogger("t"))

    def test_series_and_blobs_read_in_usd(self):
        r = self._run(0.0312)
        qm = r["quarterly_metrics"]
        self.assertEqual(qm["revenue_currency"], "TWD")
        self.assertAlmostEqual(qm["revenue"][0], round(1.27e12 * 0.0312, 2))
        # The four latest quarters sum to ~TWD 4.45T → ~$139B, so a
        # "Revenue (TTM) ≥ $500M" filter reads TSM at its real size.
        ttm = sum(qm["revenue"][:4]) / 1e6
        self.assertAlmostEqual(ttm, 4.45e12 * 0.0312 / 1e6, delta=1)
        # Growth is a ratio of the same-currency series: unchanged by FX.
        self.assertAlmostEqual(qm["rev_growth_yoy"][0], (1.27 / 0.93 - 1) * 100, places=1)
        # The "$"-rendered text blobs are converted at the source too.
        self.assertIn("$39.6B", r["quarterly_revenue"])  # 1.27e12 × 0.0312
        self.assertIn("2025: $118.6B", r["annual_revenue_5y"])

    def test_no_rate_nulls_the_machine_read_amounts_only(self):
        r = self._run(None)
        qm = r["quarterly_metrics"]
        self.assertEqual(qm["revenue"], [None] * 5)
        self.assertEqual(qm["revenue_currency"], "TWD")
        self.assertIsNone(qm["fx_usd_per_unit"])
        # Ratios survive: the inflection lens still has its inputs.
        self.assertIsNotNone(qm["gross_margin"][0])
        self.assertIsNotNone(r["gross_margin"])
        # Text blobs stay native (a chart in TWD beats no chart) — documented.
        self.assertIn("2025-06-30", r["quarterly_revenue"])

    def test_usd_name_is_untouched(self):
        import eodhd_updater
        payload = _tsm_payload()
        payload["Financials"]["Income_Statement"]["currency_symbol"] = "USD"
        with mock.patch.object(eodhd_updater, "fetch_fundamentals_with_fallbacks",
                               return_value=payload), \
             mock.patch.object(eodhd_updater.fx, "usd_per_unit",
                               side_effect=AssertionError("no fetch for USD")):
            r = eodhd_updater.fetch_eodhd_data(
                "TXN", "k", __import__("logging").getLogger("t"))
        self.assertNotIn("revenue_currency", r["quarterly_metrics"])
        self.assertEqual(r["quarterly_metrics"]["revenue"][0], 1.27e12)


if __name__ == "__main__":
    unittest.main()
