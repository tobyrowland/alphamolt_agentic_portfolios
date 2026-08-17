#!/usr/bin/env python3
"""
Credit cash allowances to live portfolios sharing one broker account.

The broker holds one pot of cash. Each live portfolio ("sleeve") holds an
**allowance** — ``portfolio_accounts.cash_usd`` — which is the most it may spend,
and the buy RPC already refuses to exceed it. Cash that hasn't been credited to
any sleeve is **unallocated**: it sits at the broker owned by nobody.

Everything that arrives at the account without an owner — dividends, interest,
fees, and fresh deposits you wire in — simply grows (or shrinks) the unallocated
pile. Nothing is attributed automatically, by design: splitting dividends per
sleeve is a lot of machinery for amounts that are immaterial on a growth-equity
book, and auto-detecting a deposit is exactly the kind of guess that
misattributes real money silently. You decide, here, explicitly.

Sale proceeds are the exception and need no action: a sleeve that sells gets the
money back in its own allowance automatically, because the sell is recorded
against that portfolio.

CLI::

    python live_cash.py --status                      # every account, every sleeve
    python live_cash.py --status --account toby-live   # one account
    python live_cash.py --credit scrappy-live 2500     # unallocated -> sleeve
    python live_cash.py --debit  scrappy-live 500      # sleeve -> unallocated
    python live_cash.py --transfer scrappy-live other-live 1000
    python live_cash.py --credit scrappy-live 2500 --dry-run

Reads the broker only to learn the real cash balance; it never places an order.
"""

from __future__ import annotations

import argparse
import logging
import sys

import sleeves
from broker import BrokerError, account_key_for_portfolio, resolve_backend
from db import SupabaseDB

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger("live_cash")


# ----------------------------------------------------------------------
# Reads
# ----------------------------------------------------------------------


def live_portfolios(db: SupabaseDB) -> list[dict]:
    return [
        p for p in db.get_human_portfolios()
        if (p.get("mode") or "paper") == "live"
    ]


def group_by_account(portfolios: list[dict]) -> dict[str, list[dict]]:
    """Live portfolios keyed by the broker account they share."""
    out: dict[str, list[dict]] = {}
    for p in portfolios:
        out.setdefault(account_key_for_portfolio(p), []).append(p)
    return {k: sorted(v, key=lambda p: p.get("slug") or p["id"]) for k, v in out.items()}


def allowances_for(db: SupabaseDB, portfolios: list[dict]) -> dict[str, float]:
    """portfolio_id -> current allowance."""
    out: dict[str, float] = {}
    for p in portfolios:
        acct = db.get_portfolio_account(p["id"]) or {}
        out[p["id"]] = float(acct.get("cash_usd") or 0)
    return out


def _broker_cash(account_key: str, portfolios: list[dict]) -> float:
    broker = (portfolios[0].get("broker") or "alpaca") if portfolios else "alpaca"
    backend = resolve_backend(
        account_key, broker, allow_shared_fallback=len(portfolios) <= 1,
    )
    return backend.get_cash()


# ----------------------------------------------------------------------
# Status
# ----------------------------------------------------------------------


def print_status(db: SupabaseDB, account: str | None = None) -> int:
    groups = group_by_account(live_portfolios(db))
    if account:
        groups = {k: v for k, v in groups.items() if k == account}
        if not groups:
            logger.error("no live portfolio uses broker account %r", account)
            return 1
    if not groups:
        logger.info("no live portfolios")
        return 0

    rc = 0
    for key, pfs in sorted(groups.items()):
        try:
            cash = _broker_cash(key, pfs)
        except BrokerError as exc:
            logger.error("account %s: %s", key, exc)
            rc = 1
            continue

        allowances = allowances_for(db, pfs)
        spare = sleeves.unallocated_cash(cash, allowances)

        print(f"\n  broker account: {key}"
              f"{'   (SLEEVES: ' + str(len(pfs)) + ')' if len(pfs) > 1 else ''}")
        print(f"  broker cash:    ${cash:>14,.2f}\n")
        print(f"  {'sleeve':<28}{'allowance':>16}{'holdings':>16}{'total':>16}")
        for p in pfs:
            book = None
            try:
                from portfolio import PortfolioManager
                book = PortfolioManager(db).get_portfolio_book(p["id"])
            except Exception as exc:  # noqa: BLE001 — status must never crash
                logger.warning("could not value %s: %s", p.get("slug"), exc)
            held = float((book or {}).get("holdings_value_usd") or 0)
            allowance = allowances[p["id"]]
            print(f"  {(p.get('slug') or p['id'][:8]):<28}"
                  f"${allowance:>15,.2f}${held:>15,.2f}${allowance + held:>15,.2f}")
        print(f"\n  {'unallocated':<28}${spare:>15,.2f}")
        if spare < -sleeves.CASH_TOLERANCE:
            print("  ^^ NEGATIVE: sleeves are promised more than the account "
                  "holds. Debit one before it places an order that bounces.")
            rc = 1
        print()
    return rc


# ----------------------------------------------------------------------
# Writes
# ----------------------------------------------------------------------


def apply_delta(
    db: SupabaseDB,
    slug: str,
    delta: float,
    *,
    reason: str,
    note: str | None = None,
    dry_run: bool = False,
) -> int:
    """Move ``delta`` into (+) or out of (-) one sleeve's allowance."""
    pf = db.get_portfolio_by_slug(slug)
    if not pf:
        logger.error("no portfolio with slug %r", slug)
        return 1
    if (pf.get("mode") or "paper") != "live":
        logger.error(
            "%s is mode=%r — allowances only apply to live portfolios "
            "(a paper book's cash is simulated)", slug, pf.get("mode"),
        )
        return 1

    key = account_key_for_portfolio(pf)
    siblings = [
        p for p in live_portfolios(db) if account_key_for_portfolio(p) == key
    ]
    try:
        cash = _broker_cash(key, siblings)
    except BrokerError as exc:
        logger.error("%s", exc)
        return 1

    allowances = allowances_for(db, siblings)
    verdict = sleeves.plan_credit(cash, allowances, pf["id"], delta)

    if not verdict.ok:
        logger.error("refused: %s", verdict.reason)
        return 1

    tag = "DRY-RUN " if dry_run else ""
    logger.info(
        "%s%s %s: $%+,.2f -> allowance $%,.2f (unallocated $%,.2f)",
        tag, reason, slug, delta, verdict.new_balance, verdict.new_unallocated,
    )
    if dry_run:
        return 0

    db.upsert_portfolio_account(pf["id"], {"cash_usd": verdict.new_balance})
    _log_ledger(db, pf["id"], delta, verdict.new_balance, reason, note)
    return 0


def transfer(
    db: SupabaseDB,
    from_slug: str,
    to_slug: str,
    amount: float,
    *,
    dry_run: bool = False,
) -> int:
    """Move cash between two sleeves — debit one, credit the other.

    Only cash moves; no broker order is placed, because the account's total is
    unchanged. The debit runs first so the credit can never over-commit the
    account even if the two legs are inspected separately.
    """
    if amount <= 0:
        logger.error("transfer amount must be > 0")
        return 1
    note = f"transfer {from_slug} -> {to_slug}"
    rc = apply_delta(
        db, from_slug, -amount, reason="transfer-out", note=note, dry_run=dry_run,
    )
    if rc:
        return rc
    rc = apply_delta(
        db, to_slug, amount, reason="transfer-in", note=note, dry_run=dry_run,
    )
    if rc and not dry_run:
        logger.error(
            "transfer half-applied: $%,.2f was debited from %s but crediting "
            "%s failed. Re-credit %s manually.",
            amount, from_slug, to_slug, from_slug,
        )
    return rc


def _log_ledger(
    db: SupabaseDB,
    portfolio_id: str,
    delta: float,
    balance_after: float,
    reason: str,
    note: str | None,
) -> None:
    """Record the movement so any allowance balance can be explained later."""
    try:
        db.client.table("portfolio_cash_ledger").insert({
            "portfolio_id": portfolio_id,
            "delta_usd": round(delta, 2),
            "balance_after": round(balance_after, 2),
            "reason": reason,
            "note": note,
        }).execute()
    except Exception as exc:  # noqa: BLE001 — the balance change already landed
        logger.warning(
            "allowance updated but ledger write failed (%s) — "
            "is migration 083 applied?", exc,
        )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Credit cash allowances to live portfolios",
    )
    ap.add_argument("--status", action="store_true",
                    help="show broker cash, each sleeve's allowance, unallocated")
    ap.add_argument("--account", metavar="KEY",
                    help="with --status: limit to one broker account")
    ap.add_argument("--credit", nargs=2, metavar=("SLUG", "AMOUNT"),
                    help="move unallocated broker cash into a sleeve")
    ap.add_argument("--debit", nargs=2, metavar=("SLUG", "AMOUNT"),
                    help="return a sleeve's allowance to unallocated")
    ap.add_argument("--transfer", nargs=3, metavar=("FROM", "TO", "AMOUNT"),
                    help="move an allowance between two sleeves")
    ap.add_argument("--note", help="free text stored on the ledger row")
    ap.add_argument("--dry-run", action="store_true",
                    help="validate and print, write nothing")
    args = ap.parse_args(argv)

    if not any([args.status, args.credit, args.debit, args.transfer]):
        ap.error("nothing to do — pass --status, --credit, --debit or --transfer")

    db = SupabaseDB()

    try:
        if args.credit:
            slug, amount = args.credit
            return apply_delta(db, slug, abs(float(amount)), reason="credit",
                               note=args.note, dry_run=args.dry_run)
        if args.debit:
            slug, amount = args.debit
            return apply_delta(db, slug, -abs(float(amount)), reason="debit",
                               note=args.note, dry_run=args.dry_run)
        if args.transfer:
            src, dst, amount = args.transfer
            return transfer(db, src, dst, abs(float(amount)),
                            dry_run=args.dry_run)
        return print_status(db, args.account)
    except ValueError:
        logger.error("amount must be a number")
        return 1
    except BrokerError as exc:
        logger.error("%s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
