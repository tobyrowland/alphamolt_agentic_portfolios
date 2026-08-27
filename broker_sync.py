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
from datetime import date, datetime, timedelta, timezone

from broker import BrokerBackend, BrokerError, account_key_for_portfolio

logger = logging.getLogger(__name__)

#: How far back ``repair`` reads the broker's fill tape.
FILL_LOOKBACK_DAYS = 30


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


def repair(
    backend: BrokerBackend,
    db,
    portfolio_slug: str,
    *,
    dry_run: bool = False,
) -> int:
    """Book the broker fills one sleeve's records are missing, at real prices.

    The gap this closes. ``sync_to_db`` is the reconciler for a **sole-occupant**
    account: the broker is the source of truth for the whole book, so overwriting
    from it fixes anything the per-fill recording missed. On a **shared** account
    that is forbidden (``_refuse_if_shared``) — and nothing replaced it. So a
    single fill that landed at the broker but failed to reach the DB left the
    combined records disagreeing with the account, and ``alpaca_mirror.
    check_account_alignment`` then halted ALL trading on the account, correctly
    and indefinitely, with no tool to clear it.

    What it does. Diffs the account's sleeves against the broker, and for each
    symbol that differs books the missing trade **against the sleeve named
    here** — the attribution is the human's call, because the broker's pooled
    view cannot know whose order it was. Quantities come from the drift; prices
    come from the broker's own fill tape, never from a close or a quote (see
    ``sleeves.plan_repair``). An unrecorded buy was paid for out of pooled cash,
    so the sleeve's allowance is topped up from the unallocated pot first, which
    is a real transfer of capital into the sleeve and moves its baseline
    accordingly.

    Refuses rather than guessing: an unpriceable difference is reported and left
    alone. Returns a process exit code (0 = records now agree).
    """
    import live_cash
    import sleeves
    from portfolio import PortfolioManager

    portfolio = _require_portfolio(db, portfolio_slug)
    if (portfolio.get("mode") or "paper") != "live":
        raise BrokerError(
            f"{portfolio_slug!r} is mode={portfolio.get('mode')!r} — repair "
            f"only applies to live portfolios"
        )

    fills_reader = getattr(backend, "recent_fills", None)
    if not callable(fills_reader):
        raise BrokerError(
            f"{backend.broker_name} cannot read its fill tape, so a repair "
            f"would have to invent prices — refusing"
        )

    # How far back to read the broker's tape. Generous: a divergence can sit
    # unnoticed over a weekend or an outage (this one did), and the rows are
    # filtered by symbol and order id afterwards anyway.
    fills_after = (
        datetime.now(timezone.utc) - timedelta(days=FILL_LOOKBACK_DAYS)
    ).isoformat()

    key = account_key_for_portfolio(portfolio)
    sleeve_pfs = [
        p for p in db.get_human_portfolios()
        if (p.get("mode") or "paper") == "live"
        and account_key_for_portfolio(p) == key
    ] or [portfolio]

    pm = PortfolioManager(db)
    recorded = sleeves.recorded_positions({
        p["id"]: pm.get_portfolio_book(p["id"]) for p in sleeve_pfs
    })
    actual = {s: p.qty for s, p in backend.get_positions().items()}
    drift = sleeves.position_drift(recorded, actual)

    print(f"\nRepair  sleeve={portfolio_slug}  account={key}  "
          f"broker={_endpoint_label(backend)}\n")

    if not drift:
        print("  records already agree with the broker — nothing to repair\n")
        return 0

    for d in drift:
        print(f"  drift  {d.describe()}")

    allowances = {
        p["id"]: float((db.get_portfolio_account(p["id"]) or {}).get("cash_usd") or 0)
        for p in sleeve_pfs
    }
    unallocated = sleeves.unallocated_cash(backend.get_cash(), allowances)

    # An unreadable tape must NOT arrive here as "no fills". The refusal text
    # for an empty tape says the fill does not exist and sends the operator off
    # to repair by hand; saying that because our own request 422'd is a wrong
    # diagnosis with a real cost. So the read is allowed to fail loudly.
    try:
        fills = fills_reader(after=fills_after)
    except Exception as exc:  # noqa: BLE001 — surfaced as a refusal, not a crash
        raise BrokerError(
            f"could not read {backend.broker_name}'s fill tape ({exc}) — "
            f"refusing to repair, because without it every price would be a "
            f"guess. This is a fault to fix, not a missing fill."
        ) from exc

    plan = sleeves.plan_repair(
        drift,
        fills,
        _recorded_order_ids(db, sleeve_pfs),
        allowances[portfolio["id"]],
        unallocated,
    )

    print()
    for leg in plan.legs:
        print(f"  book   {leg.describe()}")
    if plan.topup:
        print(f"  credit ${plan.topup:,.2f} from unallocated "
              f"(${unallocated:,.2f} available) to cover the unrecorded buys")
    for refusal in plan.refusals:
        print(f"  REFUSE {refusal}")
    if not plan.legs:
        print("\n  nothing bookable — resolve the refusals above by hand\n")
        return 1

    if dry_run:
        print("\n  DRY-RUN — nothing written\n")
        return 0

    if plan.topup:
        # Hand over the backend this function has ALREADY read positions, cash
        # and the fill tape through. Letting the top-up resolve its own is what
        # failed on 2026-08-27: the same account was reachable here and
        # "ambiguous" there, so a plan that was correct in every figure booked
        # nothing.
        rc = live_cash.apply_delta(
            db, portfolio_slug, plan.topup,
            reason="repair-topup",
            note=f"cover unrecorded broker fills on {key}",
            backend=backend,
        )
        if rc:
            print("\n  allowance top-up failed — nothing booked\n")
            return rc

    agent_id = _repair_agent_id(db)
    booked = 0
    for leg in plan.legs:
        note = f"repair {portfolio_slug} [{leg.order_id or '?'}]"
        try:
            if leg.side == "buy":
                result = pm.buy_portfolio_atomic(
                    portfolio["id"], agent_id, leg.ticker, leg.qty,
                    note=note, price_override=leg.price,
                )
            else:
                result = pm.sell_portfolio_atomic(
                    portfolio["id"], agent_id, leg.ticker, leg.qty,
                    note=note, price_override=leg.price,
                )
        except Exception as exc:  # noqa: BLE001 — report, keep repairing the rest
            result = {"status": f"raised: {exc}"}
        if (result or {}).get("status") == "ok":
            booked += 1
            print(f"  booked {leg.describe()}")
        else:
            print(f"  FAILED {leg.describe()} -> {(result or {}).get('status')}")

    remaining = len(plan.legs) - booked + len(plan.refusals)
    print(f"\n  booked {booked}/{len(plan.legs)}"
          f"{f', {remaining} still unresolved' if remaining else ''}\n")
    return 0 if remaining == 0 else 1


def _recorded_order_ids(db, sleeve_pfs: list[dict]) -> set[str]:
    """Broker order ids already present in the trade tape.

    Mirror fills are noted as ``live mirror <slug> [<order_id>]``, so a fill we
    DID book can be told apart from one we didn't. Without this a repair could
    re-book an order that is already in the records — doubling a real position.
    """
    ids: set[str] = set()
    for pf in sleeve_pfs:
        for note in db.get_portfolio_trade_notes(pf["id"]) or []:
            note = note.rstrip()
            if "[" in note and note.endswith("]"):
                ids.add(note[note.rindex("[") + 1:-1].strip())
    return {i for i in ids if i and i != "?"}


def _repair_agent_id(db) -> str | None:
    """Attribute repaired fills to the same house agent the mirror uses."""
    for handle in ("live-mirror", "manual"):
        agent = db.get_agent_by_handle(handle)
        if agent:
            return agent["id"]
    return None
