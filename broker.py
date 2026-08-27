#!/usr/bin/env python3
"""
Broker-neutral execution seam — what the live path needs from *any* broker.

AlphaMolt's live path was built against one broker (Alpaca) and the broker's
shape leaked into its callers: `alpaca_mirror` reached through
``executor.client.get_clock()``, the heartbeat logged ``backend.client.is_paper``,
the price band lived on the Alpaca backend. Adding a second broker meant
forking all of it.

This module is the seam instead. It holds:

  - ``BrokerBackend`` — the Protocol a broker backend must satisfy. Deliberately
    small: it is exactly what the mirror + the heartbeat's ``ctx.buy/sell``
    actually call, nothing more.
  - ``Position`` / ``Fill`` / ``ExecResult`` — the normalised value types every
    backend returns, so callers never touch a broker's raw payload shape.
  - ``BrokerError`` — the base every backend's error type subclasses, so a
    caller can catch one exception across brokers.
  - The **shared policy** that is genuinely broker-independent: the master
    kill-switch (``live_execution_enabled``) and the slippage band
    (``band_limit_price`` / ``price_band_from_env``). All three used to be
    duplicated per-caller.
  - ``resolve_backend`` — slug + broker name -> a bound backend, so callers
    dispatch on a portfolio's broker instead of hard-importing one.

Pure by design: no DB import, no network, no broker SDK. The DB-facing generic
operations (reconcile / state sync) live in ``broker_sync.py``; the broker-facing
implementations live in ``alpaca_execution.py`` (and any sibling backend).

Adding a broker is: implement the Protocol, subclass ``BrokerError``, add one
line to ``_BACKEND_FACTORIES``. ``plan_mirror``, the mirror loop, the price
band, ``sync_to_db`` and the whole ``live-mirror`` CLI are inherited unchanged.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

# Master kill-switch for routing real orders. Historically Alpaca-specific;
# both names are accepted so an existing deployment keeps working unchanged
# while a broker-neutral name is available for new ones. Either being truthy
# enables live execution.
LIVE_EXEC_ENV = "LIVE_EXECUTION_ENABLED"
LEGACY_LIVE_EXEC_ENV = "ALPACA_LIVE_EXECUTION_ENABLED"

# Slippage band for live orders, as a fraction (0.03 = 3%). Same dual-name rule.
PRICE_BAND_ENV = "LIVE_PRICE_BAND_PCT"
LEGACY_PRICE_BAND_ENV = "ALPACA_PRICE_BAND_PCT"

DEFAULT_PRICE_BAND = 0.03

_TRUTHY = ("1", "true", "yes", "on")


class BrokerError(Exception):
    """Base for every broker backend's error type.

    Each backend raises its own subclass (``AlpacaError``, ...) so a caller can
    still distinguish them, but ``except BrokerError`` catches any broker.
    """


@dataclass
class Position:
    """A held position, normalised across brokers."""

    symbol: str
    qty: float
    avg_price: float


@dataclass
class Fill:
    """Normalised result of submitting an order (no fill-wait)."""

    order_id: str
    symbol: str
    side: str
    qty: float
    status: str


@dataclass
class ExecResult:
    """Outcome of submit-and-await-fill.

    ``status`` is one of: ``filled`` (fully), ``partial`` (some qty filled),
    ``unfilled`` (accepted/queued but nothing filled in the window — e.g.
    market closed, or the price gapped past the band), ``rejected``.
    ``filled_qty`` / ``avg_price`` are the real numbers to record in the DB;
    both are 0 when nothing filled. ``raw_status`` is the broker's own status
    string, kept for logs/debugging only.
    """

    status: str
    filled_qty: float
    avg_price: float
    order_id: str | None
    raw_status: str = ""


@runtime_checkable
class BrokerBackend(Protocol):
    """What the live path requires of a broker.

    Kept to what callers actually use, so a new backend is a small surface:
    account state (equity / cash / positions), a tradability check
    (``market_is_open``), best-effort live pricing for the band, and
    submit-and-await-fill. Anything richer stays private to a backend.
    """

    #: Short lowercase broker id, e.g. ``"alpaca"``. Used in logs + trade notes.
    broker_name: str

    @property
    def is_sandbox(self) -> bool:
        """True when pointed at a sandbox/simulated endpoint (no real money)."""
        ...

    def get_equity(self) -> float:
        """Total account value — the basis for mirror position sizing."""
        ...

    def get_cash(self) -> float:
        """Settled cash balance."""
        ...

    def get_positions(self) -> dict[str, Position]:
        """Current holdings keyed by symbol."""
        ...

    def market_is_open(self) -> bool:
        """True when the venue is accepting fills right now."""
        ...

    def latest_price(self, symbol: str) -> float | None:
        """Best-effort live price, or None. Must never raise."""
        ...

    def execute_and_wait(
        self,
        symbol: str,
        side: str,
        qty: float,
        *,
        allow_live: bool = False,
        ref_price: float | None = None,
        timeout: float = 30.0,
        poll: float = 2.0,
    ) -> ExecResult:
        """Submit an order and poll until it reaches a terminal state."""
        ...


# ----------------------------------------------------------------------
# Shared policy — broker-independent, so it lives here rather than being
# reimplemented (or drifting) per backend and per caller.
# ----------------------------------------------------------------------


def _env_truthy(*names: str) -> bool:
    return any(
        os.environ.get(n, "").strip().lower() in _TRUTHY for n in names
    )


def live_execution_enabled() -> bool:
    """The master kill-switch for placing REAL orders.

    Flipping a portfolio to ``mode='live'`` in the DB is deliberately NOT
    enough on its own — the operator must also enable execution in the
    environment where the run happens. Unset it to halt all automatic
    real-money trading.
    """
    return _env_truthy(LIVE_EXEC_ENV, LEGACY_LIVE_EXEC_ENV)


def price_band_from_env(default: float = DEFAULT_PRICE_BAND) -> float:
    """Slippage band as a fraction. Malformed values fall back to ``default``."""
    for name in (PRICE_BAND_ENV, LEGACY_PRICE_BAND_ENV):
        raw = os.environ.get(name)
        if raw is None or not raw.strip():
            continue
        try:
            return float(raw)
        except ValueError:
            return default
    return default


def band_limit_price(side: str, ref_price: float, band: float) -> float:
    """Limit price one ``band`` from ``ref_price``, in the protective direction.

    A buy caps above (never pay more than band% up), a sell floors below (never
    accept more than band% down) — a marketable limit order. Rounded to a
    tick brokers accept: 2dp at/above $1, 4dp below.
    """
    if side == "buy":
        px = ref_price * (1 + band)
    else:
        px = ref_price * (1 - band)
    return round(px, 2) if px >= 1 else round(px, 4)


# ----------------------------------------------------------------------
# Backend resolution
# ----------------------------------------------------------------------

DEFAULT_BROKER = "alpaca"

#: Broker id -> the module + classmethod that builds a slug-bound backend.
#: Imported lazily inside ``resolve_backend`` so this module stays dependency-
#: free (and so a missing broker SDK only breaks that broker).
_BACKEND_FACTORIES: dict[str, tuple[str, str]] = {
    "alpaca": ("alpaca_execution", "AlpacaExecutionBackend"),
}

SUPPORTED_BROKERS = tuple(_BACKEND_FACTORIES)


def broker_for_portfolio(portfolio: dict) -> str:
    """Which broker a portfolio trades through.

    Reads ``portfolios.broker`` (migration 082), defaulting to Alpaca — so a
    row predating the column, or a deployment that hasn't applied it, behaves
    exactly as before.
    """
    return (portfolio.get("broker") or DEFAULT_BROKER).strip().lower()


def shared_credentials_permitted(live_portfolios: list[dict]) -> bool:
    """May the bare single-account env vars be used for these live portfolios?

    The anti-commingle rule counts distinct broker ACCOUNTS, never portfolios.
    Since migration 083 several live portfolios ("sleeves") legitimately share
    one account and resolve the same credentials unambiguously — that is the
    supported configuration, not the dangerous one. The case the guard exists
    for is two portfolios wanting DIFFERENT accounts while only one set of bare
    credentials is configured, where a wrong answer trades one person's
    strategy in another person's account.

    It lives here, once, because it was open-coded at four call sites and two of
    them counted portfolios. Those two are every allowance command in
    ``live_cash`` — so crediting, debiting, transferring and every baseline
    report refused outright on any account with more than one sleeve, which is
    precisely the setup 083 was built for.
    """
    return len({account_key_for_portfolio(p) for p in live_portfolios}) == 1


def resolve_backend(
    slug: str,
    broker: str = DEFAULT_BROKER,
    *,
    allow_shared_fallback: bool = False,
) -> BrokerBackend:
    """Build the backend for one live portfolio's own broker account.

    ``allow_shared_fallback`` is the anti-commingle control, honoured by each
    backend: callers iterating more than one live portfolio pass False so a
    second portfolio can never land in the shared single-account credentials by
    accident.
    """
    key = (broker or DEFAULT_BROKER).strip().lower()
    entry = _BACKEND_FACTORIES.get(key)
    if not entry:
        raise BrokerError(
            f"unknown broker {broker!r} for portfolio {slug!r} — "
            f"supported: {', '.join(SUPPORTED_BROKERS)}"
        )
    module_name, class_name = entry
    module = __import__(module_name)
    cls = getattr(module, class_name)
    return cls.for_slug(slug, allow_shared_fallback=allow_shared_fallback)


def account_key_for_portfolio(portfolio: dict) -> str:
    """Which broker-credentials entry this portfolio trades through.

    Reads ``portfolios.broker_account_key`` (migration 083), falling back to the
    slug — which is what the key implicitly was before that column existed, so
    pre-083 rows resolve exactly as they did.

    Two live portfolios sharing a key are **sleeves** of one broker account:
    they share its cash and its positions, and each may only spend its own
    allowance (``portfolio_accounts.cash_usd``).
    """
    key = (portfolio.get("broker_account_key") or "").strip()
    if key:
        return key
    return portfolio.get("slug") or portfolio["id"][:8]


def resolve_backend_for_portfolio(
    portfolio: dict,
    *,
    allow_shared_fallback: bool = False,
) -> BrokerBackend:
    """``resolve_backend`` keyed off a portfolio row."""
    return resolve_backend(
        account_key_for_portfolio(portfolio),
        broker_for_portfolio(portfolio),
        allow_shared_fallback=allow_shared_fallback,
    )
