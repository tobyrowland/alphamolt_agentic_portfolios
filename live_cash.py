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


def _sleeve_equity(db: SupabaseDB, portfolio_id: str, allowance: float) -> float:
    """A sleeve's MARKET equity — allowance + holdings at current prices.

    The denominator for every baseline rescale, and it has to be measured the
    same way as the amount leaving. (Valuing the holdings at cost instead is
    what made a $10k withdrawal read as a 4-point gain — migration 085.)
    """
    try:
        from portfolio import PortfolioManager
        book = PortfolioManager(db).get_portfolio_book(portfolio_id)
        return round(float(book.get("total_value_usd") or 0), 2)
    except Exception as exc:  # noqa: BLE001 — fall back to cash-only
        logger.warning("could not value portfolio %s: %s", portfolio_id, exc)
        return round(float(allowance or 0), 2)


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

    # The baseline moves with the money, or the movement is booked as
    # performance: capital credited in reads as profit, debited out as a loss.
    acct = db.get_portfolio_account(pf["id"]) or {}
    starting = float(acct.get("starting_cash") or 0)
    if delta > 0:
        baseline = sleeves.baseline_after_deposit(starting, delta)
    else:
        baseline = sleeves.baseline_after_withdrawal(
            starting, -delta, _sleeve_equity(db, pf["id"], allowances[pf["id"]]),
        )
    db.upsert_portfolio_account(pf["id"], {
        "cash_usd": verdict.new_balance,
        "starting_cash": baseline,
    })
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


# ----------------------------------------------------------------------
# Baselines — what the return is measured against
# ----------------------------------------------------------------------


def _net_contributions(backend) -> float | None:
    """Net real money paid into the broker account, or None if unreadable.

    Deposits minus withdrawals, straight from the broker's own activity feed.
    This is the number a live sleeve's return should be measured against, and
    it exists nowhere in our schema — `portfolio_cash_ledger` records how cash
    already at the broker was attributed, never how it arrived.

    Broker-neutral by duck-typing: a backend that can't answer returns None and
    the caller reports the gap instead of writing a guess.
    """
    client = getattr(backend, "client", None)
    read = getattr(client, "get_cash_transfers", None)
    if read is None:
        return None
    rows = read()
    if not rows:
        return None
    net = 0.0
    for r in rows:
        raw = r.get("net_amount", r.get("amount"))
        try:
            amount = float(raw)
        except (TypeError, ValueError):
            continue
        # CSD arrives positive, CSW should reduce contributions whichever sign
        # the feed uses.
        if (r.get("activity_type") or "").upper() == "CSW":
            amount = -abs(amount)
        net += amount
    return round(net, 2)


def _account_backend(key: str, pfs: list[dict]):
    broker = (pfs[0].get("broker") or "alpaca") if pfs else "alpaca"
    return resolve_backend(key, broker, allow_shared_fallback=len(pfs) <= 1)


def print_baselines(db: SupabaseDB, account: str | None = None) -> int:
    """Report what each sleeve's return is measured against, and whether it adds up.

    A sleeve's "+X% since it started" is (value - starting_cash) / starting_cash,
    so the baseline has to be the capital put in. Historically several paths
    moved real value without moving it — every one of those left the percentage
    overstating (money in) or understating (money out) the truth.
    """
    groups = group_by_account(live_portfolios(db))
    if account:
        groups = {k: v for k, v in groups.items() if k == account}
    if not groups:
        logger.info("no live portfolios")
        return 0

    for key, pfs in sorted(groups.items()):
        print(f"\n  broker account: {key}")
        print(f"  {'sleeve':<26}{'baseline':>15}{'value':>15}{'return':>12}")
        total_baseline = 0.0
        total_value = 0.0
        for p in pfs:
            acct = db.get_portfolio_account(p["id"]) or {}
            baseline = float(acct.get("starting_cash") or 0)
            value = _sleeve_equity(db, p["id"], float(acct.get("cash_usd") or 0))
            total_baseline += baseline
            total_value += value
            pct = ((value - baseline) / baseline * 100) if baseline > 0 else None
            shown = f"{pct:>11.2f}%" if pct is not None else "          —"
            print(f"  {(p.get('slug') or p['id'][:8]):<26}"
                  f"${baseline:>14,.2f}${value:>14,.2f}{shown}")
            if baseline <= 0:
                print("      ^^ no baseline — this sleeve's return is meaningless "
                      "until you set one (--set-baseline)")
        print(f"  {'':<26}{'-' * 42}")
        print(f"  {'account':<26}${total_baseline:>14,.2f}${total_value:>14,.2f}")

        try:
            net = _net_contributions(_account_backend(key, pfs))
        except BrokerError as exc:
            logger.warning("account %s: %s", key, exc)
            net = None
        if net is None:
            print("\n  The broker didn't report any cash transfers, so we can't "
                  "check the baseline against what you actually paid in.")
            print("  (Paper accounts have no transfer history. Set it by hand "
                  "with --set-baseline if you know the figure.)")
            continue
        print(f"\n  paid in (broker):        ${net:>14,.2f}")
        gap = round(total_baseline - net, 2)
        if abs(gap) <= 1:
            print("  Baselines match what you paid in. Returns are honest.")
            continue
        if gap < 0:
            true_pct = ((total_value - net) / net * 100) if net > 0 else 0
            print(f"  Baselines are ${abs(gap):,.2f} SHORT of it, so the returns "
                  f"above are overstated.")
            print(f"  Measured against what you paid in, the account is "
                  f"{true_pct:+.2f}%.")
        else:
            print(f"  Baselines exceed what you paid in by ${gap:,.2f}, so the "
                  "returns above are understated.")
        print("  Run --fix-baselines to rewrite them pro-rata by current value.")
    return 0


def fix_baselines(
    db: SupabaseDB, account: str | None = None, *, dry_run: bool = False,
) -> int:
    """Rebuild sleeve baselines from what the broker says was paid in.

    Splits the account's net contributions across its sleeves in proportion to
    what each is worth today. That is a choice, not a derivation: the true
    per-sleeve contribution history doesn't exist anywhere (deposits land in
    one pooled account). Pro-rata makes the ACCOUNT-level return exactly right
    and every sleeve's return the same as the account's at the moment of the
    reset, which is the honest starting point when the split is unknowable.
    """
    groups = group_by_account(live_portfolios(db))
    if account:
        groups = {k: v for k, v in groups.items() if k == account}
    if not groups:
        logger.info("no live portfolios")
        return 0

    rc = 0
    for key, pfs in sorted(groups.items()):
        try:
            net = _net_contributions(_account_backend(key, pfs))
        except BrokerError as exc:
            logger.error("account %s: %s", key, exc)
            rc = 1
            continue
        if net is None or net <= 0:
            logger.error(
                "account %s: the broker reported no cash transfers, so there is "
                "nothing to rebuild from. Use --set-baseline SLUG AMOUNT.", key,
            )
            rc = 1
            continue

        values = {}
        for p in pfs:
            acct = db.get_portfolio_account(p["id"]) or {}
            values[p["id"]] = _sleeve_equity(
                db, p["id"], float(acct.get("cash_usd") or 0),
            )
        total_value = sum(values.values())
        if total_value <= 0:
            logger.error("account %s: sleeves are worth nothing — refusing", key)
            rc = 1
            continue

        tag = "DRY-RUN " if dry_run else ""
        for p in pfs:
            share = values[p["id"]] / total_value
            baseline = round(net * share, 2)
            logger.info(
                "%s%s: baseline -> $%,.2f (%.1f%% of $%,.2f paid in)",
                tag, p.get("slug"), baseline, share * 100, net,
            )
            if dry_run:
                continue
            db.upsert_portfolio_account(p["id"], {"starting_cash": baseline})
            _log_ledger(db, p["id"], 0.0, baseline, "baseline-reset",
                        f"rebuilt from ${net:,.2f} paid in at the broker")
    return rc


def set_baseline(
    db: SupabaseDB, slug: str, amount: float, *, dry_run: bool = False,
) -> int:
    """Set one sleeve's baseline by hand — the money you consider paid into it."""
    pf = db.get_portfolio_by_slug(slug)
    if not pf:
        logger.error("no portfolio with slug %r", slug)
        return 1
    if (pf.get("mode") or "paper") != "live":
        logger.error("%s is not a live portfolio", slug)
        return 1
    if amount < 0:
        logger.error("baseline cannot be negative")
        return 1
    tag = "DRY-RUN " if dry_run else ""
    logger.info("%s%s: baseline -> $%,.2f", tag, slug, amount)
    if dry_run:
        return 0
    db.upsert_portfolio_account(pf["id"], {"starting_cash": round(amount, 2)})
    _log_ledger(db, pf["id"], 0.0, round(amount, 2), "baseline-reset", "set by hand")
    return 0


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
    ap.add_argument("--baselines", action="store_true",
                    help="show what each sleeve's return is measured against, "
                         "checked against what the broker says you paid in")
    ap.add_argument("--fix-baselines", action="store_true",
                    help="rebuild baselines pro-rata from the broker's "
                         "deposits/withdrawals")
    ap.add_argument("--set-baseline", nargs=2, metavar=("SLUG", "AMOUNT"),
                    help="set one sleeve's baseline by hand")
    ap.add_argument("--note", help="free text stored on the ledger row")
    ap.add_argument("--dry-run", action="store_true",
                    help="validate and print, write nothing")
    args = ap.parse_args(argv)

    if not any([args.status, args.credit, args.debit, args.transfer,
                args.baselines, args.fix_baselines, args.set_baseline]):
        ap.error("nothing to do — pass --status, --baselines, --credit, "
                 "--debit, --transfer, --fix-baselines or --set-baseline")

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
        if args.set_baseline:
            slug, amount = args.set_baseline
            return set_baseline(db, slug, abs(float(amount)),
                                dry_run=args.dry_run)
        if args.fix_baselines:
            return fix_baselines(db, args.account, dry_run=args.dry_run)
        if args.baselines:
            return print_baselines(db, args.account)
        return print_status(db, args.account)
    except ValueError:
        logger.error("amount must be a number")
        return 1
    except BrokerError as exc:
        logger.error("%s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
