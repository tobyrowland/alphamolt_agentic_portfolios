#!/usr/bin/env python3
"""
Broker-neutral reconciliation + state write-back.

Both operations here are pure *policy* over the ``BrokerBackend`` protocol —
nothing in them is specific to a broker, so they live once and every backend
inherits them:

  - ``reconcile`` — READ-ONLY diff between the broker account and an AlphaMolt
    portfolio (per-symbol quantity + cash). Never writes.
  - ``sync_to_db`` — the idempotent **state** mirror: overwrite
    ``portfolio_holdings`` + ``portfolio_accounts.cash_usd`` to match the
    broker's current positions and cash, so the website / MTM snapshot /
    leaderboard reflect the real account. Converges, never accumulates.

``sync_to_db`` refuses any portfolio that isn't ``mode='live'`` — it is
destructive to the DB book (for a live portfolio the broker is the source of
truth) and must never clobber a paper portfolio's simulated book.

They were methods on the Alpaca backend; the backends now delegate here so a
second broker gets both for free.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone

from broker import BrokerBackend, BrokerError, account_key_for_portfolio

logger = logging.getLogger(__name__)


def _endpoint_label(backend: BrokerBackend) -> str:
    """``alpaca/PAPER`` — broker plus whether real money can move."""
    return f"{backend.broker_name}/{'SANDBOX' if backend.is_sandbox else 'LIVE'}"


def _require_portfolio(db, portfolio_slug: str) -> dict:
    portfolio = db.get_portfolio_by_slug(portfolio_slug)
    if not portfolio:
        raise BrokerError(f"portfolio not found: {portfolio_slug!r}")
    return portfolio


def _account_sleeve_slugs(db, portfolio: dict) -> list[str]:
    """Slugs of every live portfolio sharing this one's broker account."""
    key = account_key_for_portfolio(portfolio)
    return sorted(
        p.get("slug") or p["id"][:8]
        for p in db.get_human_portfolios()
        if (p.get("mode") or "paper") == "live"
        and account_key_for_portfolio(p) == key
    )


def _refuse_if_shared(db, portfolio: dict, portfolio_slug: str) -> None:
    """Block the state overwrite when the broker account has several sleeves.

    ``sync_to_db`` works by treating the broker as the source of truth for the
    WHOLE book. That is correct when one live portfolio owns the account, and
    catastrophic when several share it (migration 083): the broker reports one
    pooled set of positions, so copying it into a single portfolio would hand
    that sleeve every share in the account — including the others' — and wipe
    their records. There is no way to recover the split afterwards, because the
    broker never knew it.

    For shared accounts the mirror books each fill against the sleeve that
    ordered it, and ``reconcile`` reports any divergence for a human to resolve.
    """
    siblings = _account_sleeve_slugs(db, portfolio)
    if len(siblings) > 1:
        raise BrokerError(
            f"refusing to sync: broker account "
            f"{account_key_for_portfolio(portfolio)!r} is shared by "
            f"{len(siblings)} live portfolios ({', '.join(siblings)}). "
            f"Overwriting {portfolio_slug!r} from the broker's pooled state "
            f"would give it the other sleeves' positions and destroy the "
            f"per-sleeve split, which cannot be reconstructed. Use "
            f"`--reconcile` to see the differences instead."
        )


def reconcile(backend: BrokerBackend, db, portfolio_slug: str) -> None:
    """Report the diff between the broker account and an AlphaMolt portfolio.

    Read-only. Compares per-symbol quantity and the cash balance so we can see
    exactly what a sync would have to do, without touching the DB.
    """
    portfolio = _require_portfolio(db, portfolio_slug)

    broker_cash = backend.get_cash()
    broker_pos = {s: p.qty for s, p in backend.get_positions().items()}

    # Compare the broker against EVERY sleeve on the account, not just the one
    # named — on a shared account a single sleeve is expected to differ from the
    # pooled total, so comparing it alone would report alarming false drift.
    sleeve_pfs = [
        p for p in db.get_human_portfolios()
        if (p.get("mode") or "paper") == "live"
        and account_key_for_portfolio(p) == account_key_for_portfolio(portfolio)
    ] or [portfolio]
    shared = len(sleeve_pfs) > 1

    db_cash = 0.0
    db_pos: dict[str, float] = {}
    per_sleeve: list[tuple[str, float]] = []
    for pf in sleeve_pfs:
        acct = db.get_portfolio_account(pf["id"]) or {}
        allowance = float(acct.get("cash_usd") or 0)
        db_cash += allowance
        per_sleeve.append((pf.get("slug") or pf["id"][:8], allowance))
        for h in db.get_portfolio_holdings(pf["id"]):
            db_pos[h["ticker"]] = db_pos.get(h["ticker"], 0.0) + float(
                h["quantity"]
            )

    label = "sleeves" if shared else "portfolio"
    print(f"\nReconcile  {label}="
          f"{', '.join(s for s, _ in sorted(per_sleeve))}  "
          f"account={account_key_for_portfolio(portfolio)}  "
          f"broker={_endpoint_label(backend)}\n")

    if shared:
        for slug, allowance in sorted(per_sleeve):
            print(f"  allowance  {slug:<24} ${allowance:>14,.2f}")
        print(f"  {'unallocated':<35} ${broker_cash - db_cash:>14,.2f}")
    print(f"  cash   alphamolt=${db_cash:,.2f}   broker=${broker_cash:,.2f}   "
          f"delta=${broker_cash - db_cash:,.2f}"
          f"{'  (unallocated — expected)' if shared else ''}")

    symbols = sorted(set(broker_pos) | set(db_pos))
    if not symbols:
        print("  positions: none on either side")
    else:
        print(f"\n  {'symbol':<10}{'alphamolt':>12}{'broker':>12}{'delta':>12}")
        for s in symbols:
            a = broker_pos.get(s, 0.0)
            d = db_pos.get(s, 0.0)
            flag = "  <-- DRIFT" if abs(a - d) > 1e-4 else ""
            print(f"  {s:<10}{d:>12.2f}{a:>12.2f}{a - d:>12.2f}{flag}")
    print()


def sync_to_db(
    backend: BrokerBackend,
    db,
    portfolio_slug: str,
    *,
    dry_run: bool = False,
    reset_baseline: bool = False,
) -> None:
    """Mirror the live broker account into the normal portfolio tables.

    With ``reset_baseline`` (the "go-live" reseed) it also sets
    ``starting_cash`` to the broker's current account **equity** and
    ``inception_date`` to today — so the portfolio's P/L baseline is the real
    capital you funded, not the $1M paper default. Run once when a portfolio
    first goes live; the buying-power and leaderboard-baseline mismatches both
    come from a stale $1M baseline.

    The broker endpoint is independent of ``mode``: you can run a ``mode='live'``
    portfolio against a broker's *sandbox*, which mirrors a real account shape
    with zero real money.

    Not handled here (state-only mirror): the per-trade journal
    (``agent_trades``) and MTM snapshot (``agent_portfolio_history``). The
    snapshot is produced on the next ``portfolio_valuation.py`` run from the
    mirrored holdings; journaling individual fills (broker activities, deduped
    by order id) is a follow-up — see TODO below.
    """
    portfolio = _require_portfolio(db, portfolio_slug)
    mode = portfolio.get("mode")
    if mode != "live":
        raise BrokerError(
            f"refusing to sync: portfolio {portfolio_slug!r} is "
            f"mode={mode!r}, not 'live'. Set portfolios.mode='live' first "
            "— sync mirrors real broker state into the normal tables and "
            "must never overwrite a paper book."
        )
    _refuse_if_shared(db, portfolio, portfolio_slug)
    pid = portfolio["id"]

    broker_cash = backend.get_cash()
    broker_equity = backend.get_equity()
    broker_pos = backend.get_positions()

    db_holdings = {h["ticker"]: h for h in db.get_portfolio_holdings(pid)}
    now = datetime.now(timezone.utc).isoformat()

    tag = "DRY-RUN " if dry_run else ""
    head = "go-live reseed" if reset_baseline else "sync"
    print(f"\n{tag}{head}  portfolio={portfolio_slug}  mode=live  "
          f"broker={_endpoint_label(backend)}\n")

    # Upsert every broker position. Validate the symbol against `securities`
    # (Level 0 Tier 0) — that's the real FK target of
    # portfolio_holdings.ticker, so a Level-0-only name (e.g. a foreign ADR
    # like TSM that the legacy `companies` TradingView screen excludes) is a
    # perfectly valid holding and must be written, not dropped. The paper
    # book already holds such names; the live mirror must too, or a real
    # fill silently never reaches the DB/website. Skip only symbols absent
    # from `securities` entirely (the FK would otherwise reject the write).
    for symbol, pos in sorted(broker_pos.items()):
        if not db.get_security(symbol):
            logger.warning(
                "skip %s: not in securities universe (FK target missing)",
                symbol,
            )
            continue
        existing = db_holdings.get(symbol)
        first_bought = (
            existing.get("first_bought_at") if existing else now
        ) or now
        row = {
            "portfolio_id": pid,
            "ticker": symbol,
            "quantity": pos.qty,
            "avg_cost_usd": pos.avg_price,
            "first_bought_at": first_bought,
            "updated_at": now,
        }
        print(f"  upsert  {symbol:<8} qty={pos.qty:<10.4f} "
              f"avg=${pos.avg_price:,.2f}")
        if not dry_run:
            db.upsert_portfolio_holding(row)

    # Delete DB holdings the broker no longer reports (fully exited positions).
    for ticker in sorted(db_holdings):
        if ticker not in broker_pos:
            print(f"  delete  {ticker:<8} (no longer held at broker)")
            if not dry_run:
                db.delete_portfolio_holding(pid, ticker)

    account_update: dict = {"cash_usd": broker_cash}
    if reset_baseline:
        account_update["starting_cash"] = broker_equity
        account_update["inception_date"] = date.today().isoformat()
        print(f"  baseline starting_cash=${broker_equity:,.2f}  "
              f"inception={account_update['inception_date']}")
    print(f"  cash    ${broker_cash:,.2f}")
    if not dry_run:
        db.upsert_portfolio_account(pid, account_update)

    # TODO(trade journal): mirror individual fills into agent_trades by
    # reading broker activities (FILL events) and deduping on order id, so
    # the public trade tape reflects real trades. State mirror above is
    # enough for holdings / MTM / leaderboard.
    print(f"\n{tag}done.\n")
