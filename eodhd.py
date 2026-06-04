"""
Thin, reusable EODHD REST client for the Level 0 fact store.

The existing pipeline (eodhd_updater.py / price_sales_updater.py) embeds its
own EODHD calls for the /fundamentals and /real-time endpoints. Level 0 needs
three further endpoints — the full exchange symbol list, end-of-day history,
and the bulk end-of-day snapshot — so they live here as one small wrapper
rather than being scattered. All calls share one rate-limited, retrying
`get()` so a fresh universe build doesn't hammer the API.

Endpoints used:
    GET /exchange-symbol-list/{EXCHANGE}   full ticker list + security type
    GET /eod/{SYMBOL}                       daily OHLCV history (per ticker)
    GET /eod-bulk-last-day/{EXCHANGE}       all tickers for one trading day
    GET /fundamentals/{SYMBOL}              full fundamentals blob

Environment:
    EODHD_API_KEY — required.
"""

import logging
import os
import time

import requests

logger = logging.getLogger("eodhd")

BASE_URL = "https://eodhd.com/api"
DEFAULT_TIMEOUT = 60          # bulk endpoints return large payloads
DELAY_BETWEEN_CALLS = 1.0     # seconds — matches eodhd_updater convention
MAX_RETRIES = 4
RETRY_BACKOFF = 2.0           # 2s, 4s, 8s, 16s


class EODHDError(RuntimeError):
    """Raised when EODHD returns an unrecoverable error."""


class EODHDClient:
    """Rate-limited, retrying wrapper over the EODHD REST API."""

    def __init__(self, api_key: str | None = None, delay: float = DELAY_BETWEEN_CALLS):
        self.api_key = api_key or os.environ.get("EODHD_API_KEY", "")
        if not self.api_key:
            raise RuntimeError("EODHD_API_KEY env var must be set")
        self.delay = delay
        self._session = requests.Session()

    # ------------------------------------------------------------------
    # Low-level
    # ------------------------------------------------------------------

    def get(self, path: str, params: dict | None = None) -> object:
        """GET {BASE_URL}/{path} as JSON, with rate-limit + retry/backoff.

        Retries on network errors and 5xx; raises EODHDError on 4xx (other
        than 404, which returns None so callers can treat "not found" as a
        soft miss).
        """
        params = dict(params or {})
        params.setdefault("api_token", self.api_key)
        params.setdefault("fmt", "json")
        url = f"{BASE_URL}/{path.lstrip('/')}"

        last_err: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                resp = self._session.get(url, params=params, timeout=DEFAULT_TIMEOUT)
                if resp.status_code == 404:
                    return None
                if resp.status_code == 429 or resp.status_code >= 500:
                    raise EODHDError(f"{resp.status_code} from {path}")
                if resp.status_code >= 400:
                    raise EODHDError(f"{resp.status_code} from {path}: {resp.text[:200]}")
                time.sleep(self.delay)
                return resp.json()
            except (requests.RequestException, EODHDError, ValueError) as e:
                last_err = e
                if attempt < MAX_RETRIES - 1:
                    wait = RETRY_BACKOFF ** (attempt + 1)
                    logger.warning("EODHD %s failed (%s); retry in %.0fs", path, e, wait)
                    time.sleep(wait)
        raise EODHDError(f"EODHD {path} failed after {MAX_RETRIES} attempts: {last_err}")

    # ------------------------------------------------------------------
    # Level 0 endpoints
    # ------------------------------------------------------------------

    def exchange_symbol_list(self, exchange: str = "US") -> list[dict]:
        """Full ticker list for an exchange.

        Each row: {Code, Name, Country, Exchange, Currency, Type, Isin}.
        `Type` distinguishes Common Stock / Preferred Stock / ETF / FUND /
        Unit / Note / etc. — the raw material for the Tier 0 security-type
        filter.
        """
        data = self.get(f"exchange-symbol-list/{exchange}")
        return data if isinstance(data, list) else []

    def eod(self, symbol: str, from_date: str | None = None,
            to_date: str | None = None, period: str = "d") -> list[dict]:
        """Daily OHLCV history for one symbol (e.g. 'AAPL.US').

        Each row: {date, open, high, low, close, adjusted_close, volume}.
        """
        params: dict = {"period": period}
        if from_date:
            params["from"] = from_date
        if to_date:
            params["to"] = to_date
        data = self.get(f"eod/{symbol}", params)
        return data if isinstance(data, list) else []

    def bulk_last_day(self, exchange: str = "US", date: str | None = None) -> list[dict]:
        """All tickers' OHLCV for a single trading day (one cheap call).

        With `date=YYYY-MM-DD` returns that day; without it returns the last
        completed trading day. Each row:
        {code, exchange_short_name, date, open, high, low, close,
         adjusted_close, volume}. Used to compute the trailing-30d ADDV for
        the whole universe in ~30 calls instead of thousands.
        """
        params = {}
        if date:
            params["date"] = date
        data = self.get(f"eod-bulk-last-day/{exchange}", params)
        return data if isinstance(data, list) else []

    def fundamentals(self, symbol: str) -> dict | None:
        """Full fundamentals blob for one symbol (e.g. 'AAPL.US')."""
        data = self.get(f"fundamentals/{symbol}")
        return data if isinstance(data, dict) else None
