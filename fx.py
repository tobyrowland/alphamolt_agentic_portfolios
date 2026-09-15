"""
fx.py — currency conversion for the Level 0 fact store.

Why this exists
---------------
EODHD reports `Highlights.MarketCapitalization` in USD for a US listing but
leaves the income statement in the issuer's FILING currency. For a US-listed
ADR the two disagree, and every figure that divides one by the other, or
reads the revenue as dollars, is off by the home FX rate: on 2026-09-14 TSM
carried a P/S of 0.51 (true ~9), ASX 0.14, JKS 0.01, and LG Display's
"revenue" read as $5.7 trillion a quarter because it is in won.

The first defence (2026-09-08, `price_sales_updater.resolve_ps`) refused to
divide the two and fell back to EODHD's own `Valuation.PriceSalesTTM` on the
assumption that it was currency-consistent by construction. It is not: for
every declared-currency ADR in the 2026-09-14 run the "reported" multiple
came out identical to the broken derived one (TSM 0.51, FMX 0.05, JKS 0.01),
so the guard was writing the same wrong number under a different label. And
where it refused outright (KRW / JPY / ARS names with no reported multiple),
nothing was written at all, which left each name's LAST BAD ROW as the
latest one the screener reads — 17 Tier-1 names sat on a stranded 0.00 for a
week.

So the only correct fix is the conversion itself. This module owns it:

- `usd_per_unit(code)` — how many USD one unit of `code` buys, fetched from
  EODHD's forex feed and cached per process (a run touches ~15 currencies,
  not ~3,000 names). Minor-unit codes (GBX pence, ILA agorot, ZAC cents) are
  normalised to their major unit first.
- `to_usd(amount, rate)` — the one conversion expression.
- `convert_series(values, rate)` — a whole quarterly series at once.

The network read is isolated in `fetch_usd_rate` so every decision above it
is pure and unit-tested (`tests/test_fx.py`). An unknown rate is `None`, and
callers REFUSE rather than guess: a name absent from the Value lens is a
missed candidate, a name ranked on a wrong multiple pulls its whole sector's
peer median with it.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Callable

import requests

logger = logging.getLogger("fx")

EODHD_BASE_URL = "https://eodhd.com/api"
DEFAULT_TIMEOUT = 20

# Codes EODHD (and the exchanges it mirrors) use for a currency's MINOR unit.
# A statement "in GBX" is in pence: 100 of them to the pound.
MINOR_UNITS: dict[str, tuple[str, float]] = {
    "GBX": ("GBP", 100.0),  # pence sterling
    "GBP_PENCE": ("GBP", 100.0),
    "ILA": ("ILS", 100.0),  # agorot
    "ZAC": ("ZAR", 100.0),  # South African cents
}


def normalise_currency(code: str | None) -> tuple[str | None, float]:
    """`(major_code, units_per_major)` for a raw currency code.

    "GBX" → ("GBP", 100): an amount in GBX must be divided by 100 before the
    GBP rate applies. Unknown / blank codes come back as (None, 1).
    """
    if not isinstance(code, str) or not code.strip():
        return None, 1.0
    c = code.strip().upper()
    if c in MINOR_UNITS:
        major, per = MINOR_UNITS[c]
        return major, per
    return c, 1.0


def revenue_currency(fundamentals: dict | None) -> str | None:
    """Currency an EODHD income statement is reported in, or None if undeclared.

    Deliberately does NOT fall back to General.CurrencyCode: that is the
    LISTING currency, which reads USD for precisely the US-listed ADRs whose
    revenue is not in dollars, so using it would blind every check to the one
    case it exists for.
    """
    if not isinstance(fundamentals, dict):
        return None
    statement = (fundamentals.get("Financials") or {}).get("Income_Statement") or {}
    if not isinstance(statement, dict):
        return None
    for key in ("currency_symbol", "currency"):
        val = statement.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip().upper()
    return None


def to_usd(amount: float | None, rate: float | None) -> float | None:
    """`amount` (in some currency) × `rate` (USD per one unit of it).

    None in → None out; a non-positive rate is treated as unknown.
    """
    if amount is None or rate is None or rate <= 0:
        return None
    return amount * rate


def convert_series(values: list | None, rate: float | None) -> list | None:
    """Convert a whole newest-first series; positions never shift.

    Unknown rate → every value becomes None (the series is still THERE, so a
    reader knows the quarters existed, but the standard missing-datum rule
    then excludes the name from any filter that needs the amounts).
    """
    if values is None:
        return None
    out: list[float | None] = []
    for v in values:
        u = to_usd(v, rate)
        out.append(None if u is None else round(u, 2))
    return out


# ---------------------------------------------------------------------------
# Rate lookup — the only network-facing part
# ---------------------------------------------------------------------------


def _close_from(payload: object) -> float | None:
    """Pull a positive `close` out of an EODHD real-time or EOD response."""
    row = payload
    if isinstance(payload, list):
        row = payload[-1] if payload else None
    if not isinstance(row, dict):
        return None
    for key in ("close", "adjusted_close", "previousClose"):
        try:
            v = float(row.get(key))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if v > 0:
            return v
    return None


def fetch_usd_rate(major: str, api_key: str, *, timeout: int = DEFAULT_TIMEOUT,
                   get: Callable[..., requests.Response] | None = None) -> float | None:
    """USD per one unit of `major` from EODHD's forex feed, or None.

    EODHD quotes most pairs against the dollar in one direction only
    (EURUSD, GBPUSD … but USDJPY, USDTWD, USDKRW), so both are tried and the
    inverse pair is inverted. Any failure (HTTP, shape, zero) is None: the
    caller refuses rather than converts at a guessed rate.
    """
    if major == "USD":
        return 1.0
    get = get or requests.get
    params = {"api_token": api_key, "fmt": "json"}
    for symbol, invert in ((f"{major}USD.FOREX", False), (f"USD{major}.FOREX", True)):
        try:
            resp = get(f"{EODHD_BASE_URL}/real-time/{symbol}", params=params, timeout=timeout)
            if resp.status_code != 200:
                continue
            close = _close_from(resp.json())
        except (requests.RequestException, ValueError):
            continue
        if close is None:
            continue
        return (1.0 / close) if invert else close
    return None


class FxRates:
    """Per-process cache of USD rates, one fetch per currency per run.

    `fetch` is injectable so tests never touch the network.
    """

    def __init__(self, api_key: str | None = None,
                 fetch: Callable[[str, str], float | None] | None = None):
        self.api_key = api_key if api_key is not None else os.environ.get("EODHD_API_KEY", "")
        self._fetch = fetch or (lambda major, key: fetch_usd_rate(major, key))
        self._cache: dict[str, float | None] = {"USD": 1.0}
        self._lock = threading.Lock()

    def usd_per_unit(self, code: str | None) -> float | None:
        """USD per one unit of the RAW code (minor units already folded in).

        GBX → the GBP rate / 100. None when the code is unknown or the feed
        gave nothing; the miss is cached too, so a bad currency costs one call.
        """
        major, per = normalise_currency(code)
        if major is None:
            return None
        with self._lock:
            if major not in self._cache:
                rate = None
                try:
                    rate = self._fetch(major, self.api_key)
                except Exception as exc:  # noqa: BLE001 — a rate miss must never kill a run
                    logger.warning("FX %s: fetch failed (%s)", major, exc)
                if rate is None or rate <= 0:
                    logger.warning("FX %s: no USD rate — names reporting in it will be refused",
                                   major)
                    rate = None
                else:
                    logger.info("FX %s: %.6g USD per unit", major, rate)
                self._cache[major] = rate
            rate = self._cache[major]
        return None if rate is None else rate / per


_default: FxRates | None = None
_default_lock = threading.Lock()


def default_rates() -> FxRates:
    """The process-wide cache every updater shares (keyed on EODHD_API_KEY)."""
    global _default
    with _default_lock:
        if _default is None:
            _default = FxRates()
        return _default


def usd_per_unit(code: str | None) -> float | None:
    """Convenience over `default_rates()` — USD per one unit of `code`."""
    if code is None:
        return None
    major, _ = normalise_currency(code)
    if major == "USD":
        return 1.0
    return default_rates().usd_per_unit(code)
