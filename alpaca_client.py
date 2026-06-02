#!/usr/bin/env python3
"""
Alpaca Trading API client — thin REST wrapper.

Scope (spike): a single Alpaca account traded with its own API keys. This is
the *Trading API*, not the Broker API — we are an API client of one account,
not a brokerage onboarding many users. The paper endpoint
(``paper-api.alpaca.markets``) is Alpaca's sandbox and is byte-for-byte
identical in shape to live; going live later is an endpoint + key swap, no
code change.

Auth is two headers (key id + secret). Reads:

    ALPACA_API_KEY_ID         Alpaca API key id
    ALPACA_API_SECRET_KEY     Alpaca API secret
    ALPACA_BASE_URL           Optional. Defaults to the paper endpoint
                              (https://paper-api.alpaca.markets). Set to
                              https://api.alpaca.markets ONLY when going live.

Nothing here touches real money while ALPACA_BASE_URL points at paper.

Docs: https://docs.alpaca.markets/reference/
"""

from __future__ import annotations

import logging
import os
from typing import Any

import requests
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

PAPER_BASE_URL = "https://paper-api.alpaca.markets"
LIVE_BASE_URL = "https://api.alpaca.markets"

DEFAULT_TIMEOUT = 15  # seconds


class AlpacaError(Exception):
    """Raised when an Alpaca API call fails."""


class AlpacaClient:
    """Minimal REST client over the Alpaca Trading API (v2)."""

    def __init__(
        self,
        key_id: str | None = None,
        secret_key: str | None = None,
        base_url: str | None = None,
    ):
        self.key_id = key_id or os.environ.get("ALPACA_API_KEY_ID", "")
        self.secret_key = secret_key or os.environ.get("ALPACA_API_SECRET_KEY", "")
        self.base_url = (
            base_url
            or os.environ.get("ALPACA_BASE_URL")
            or PAPER_BASE_URL
        ).rstrip("/")

        if not self.key_id or not self.secret_key:
            raise AlpacaError(
                "Missing ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY env vars"
            )

        self._session = requests.Session()
        self._session.headers.update(
            {
                "APCA-API-KEY-ID": self.key_id,
                "APCA-API-SECRET-KEY": self.secret_key,
                "Accept": "application/json",
            }
        )

    @property
    def is_paper(self) -> bool:
        """True when pointed at the sandbox (no real money can move)."""
        return self.base_url == PAPER_BASE_URL or "paper-api" in self.base_url

    # ------------------------------------------------------------------
    # Low-level request helper
    # ------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json_body: dict | None = None,
        timeout: int = DEFAULT_TIMEOUT,
    ) -> Any:
        url = f"{self.base_url}{path}"
        try:
            resp = self._session.request(
                method,
                url,
                params=params,
                json=json_body,
                timeout=timeout,
            )
        except requests.exceptions.RequestException as exc:
            raise AlpacaError(f"{method} {path} failed: {exc}") from exc

        if resp.status_code >= 400:
            # Alpaca returns {"code": ..., "message": ...} on errors.
            detail = resp.text
            try:
                detail = resp.json().get("message", detail)
            except ValueError:
                pass
            raise AlpacaError(
                f"{method} {path} -> {resp.status_code}: {detail}"
            )

        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    # ------------------------------------------------------------------
    # Account / market
    # ------------------------------------------------------------------

    def get_account(self) -> dict:
        """Account snapshot — cash, equity, buying power, status."""
        return self._request("GET", "/v2/account")

    def get_clock(self) -> dict:
        """Market clock — is_open, next_open, next_close."""
        return self._request("GET", "/v2/clock")

    def get_asset(self, symbol: str) -> dict:
        """Asset metadata — tradable, fractionable, exchange, status."""
        return self._request("GET", f"/v2/assets/{symbol}")

    # ------------------------------------------------------------------
    # Positions
    # ------------------------------------------------------------------

    def list_positions(self) -> list[dict]:
        return self._request("GET", "/v2/positions") or []

    def get_position(self, symbol: str) -> dict | None:
        try:
            return self._request("GET", f"/v2/positions/{symbol}")
        except AlpacaError as exc:
            # 404 = no open position for that symbol.
            if "404" in str(exc):
                return None
            raise

    # ------------------------------------------------------------------
    # Orders
    # ------------------------------------------------------------------

    def submit_order(
        self,
        symbol: str,
        side: str,
        *,
        qty: float | None = None,
        notional: float | None = None,
        order_type: str = "market",
        time_in_force: str = "day",
        limit_price: float | None = None,
        client_order_id: str | None = None,
    ) -> dict:
        """Submit an order. Pass exactly one of ``qty`` or ``notional``.

        ``client_order_id`` is an idempotency handle — Alpaca rejects a
        duplicate id, which lets a caller safely retry without
        double-submitting.
        """
        if (qty is None) == (notional is None):
            raise AlpacaError("submit_order needs exactly one of qty / notional")
        if side not in ("buy", "sell"):
            raise AlpacaError(f"invalid side: {side!r}")

        body: dict[str, Any] = {
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
        }
        if qty is not None:
            body["qty"] = str(qty)
        if notional is not None:
            body["notional"] = str(notional)
        if limit_price is not None:
            body["limit_price"] = str(limit_price)
        if client_order_id is not None:
            body["client_order_id"] = client_order_id

        return self._request("POST", "/v2/orders", json_body=body)

    def get_order(self, order_id: str) -> dict:
        return self._request("GET", f"/v2/orders/{order_id}")

    def list_orders(
        self,
        status: str = "all",
        limit: int = 100,
    ) -> list[dict]:
        return (
            self._request(
                "GET",
                "/v2/orders",
                params={"status": status, "limit": limit},
            )
            or []
        )

    def cancel_order(self, order_id: str) -> None:
        self._request("DELETE", f"/v2/orders/{order_id}")
