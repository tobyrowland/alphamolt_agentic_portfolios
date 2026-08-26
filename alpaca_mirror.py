#!/usr/bin/env python3
"""
Mirror a paper portfolio's composition onto a live broker account.

Broker-neutral: everything it needs comes through the ``broker.BrokerBackend``
protocol, and the account is resolved from the live portfolio's
``portfolios.broker``. The module name is historical (Alpaca was the only
broker when it was written).

The model (chosen for AlphaMolt): the **paper** portfolio is the brain — the
swarm/mandate/agents run there as normal, at the $1M paper scale. The **live**
portfolio is a private *follower*: it holds the same names in the same
proportions, but sized to its **own real capital**, executed with real money.
The live portfolio has no agents/mandate of its own.

"Mirror purchases" is implemented as **target-weight replication**, not
trade-by-trade replay:

    target_shares[t] = (paper_weight[t] * live_portfolio_equity) / price[t]

then we diff against the live portfolio's OWN recorded positions and place
orders only for the deltas (sells first to free buying power, then buys). This
is self-correcting — partial fills, fractional shares, price drift, or a missed
run never accumulate, because each pass simply re-converges onto the paper
book's current shape.

**Sleeves (migration 083).** Several live portfolios may share ONE broker
account. The broker pools their cash and positions; each sleeve owns a share of
them that only AlphaMolt records. So both the equity used for sizing and the
positions diffed against are the *portfolio's own* — never the broker's
aggregate — which is what keeps two sleeves from mistaking each other's
holdings for drift and selling them. Each sleeve spends only its own allowance
(``portfolio_accounts.cash_usd``); before trading, the combined records are
checked against the broker and a shared account refuses to trade on a
mismatch.

A name is only rebalanced when its weight drifts more than ``threshold`` (1% of
equity by default), to avoid churning tiny fee-bearing orders every run.

Entry points:
  - `mirror_paper_to_broker(...)` — called by agent_heartbeat right after the
    paper portfolio rebalances.
  - CLI: `python alpaca_mirror.py --slug <live-slug> [--dry-run]
    [--threshold 0.01]` — resolves the paper sibling by owner, mirrors, syncs.

Real orders only fire when the master kill-switch is truthy
(``broker.live_execution_enabled`` — LIVE_EXECUTION_ENABLED, or the legacy
ALPACA_LIVE_EXECUTION_ENABLED) or against a broker sandbox; otherwise use
--dry-run to preview.
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass

import broker_sync
import sleeves
from broker import (
    LIVE_EXEC_ENV,
    BrokerBackend,
    BrokerError,
    account_key_for_portfolio,
    band_limit_price,
    live_execution_enabled,
    price_band_from_env,
    resolve_backend_for_portfolio,
)
from db import SupabaseDB
from portfolio import PortfolioError, PortfolioManager

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger("alpaca_mirror")

DEFAULT_THRESHOLD = 0.01   # rebalance a name only if |Δweight| > 1% of equity
MIN_ORDER_USD = 1.0        # skip dust orders below $1 notional


@dataclass
class MirrorOrder:
    ticker: str
    side: str          # 'buy' | 'sell'
    qty: float
    target_w: float
    cur_w: float
    ref_price: float   # intended price — basis for the execution price band


def plan_mirror(
    paper_book: dict,
    equity: float,
    own_positions: dict[str, float],
    price_fn,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    min_order_usd: float = MIN_ORDER_USD,
) -> list[MirrorOrder]:
    """Pure planner: paper composition + this portfolio's own state -> orders.

    ``paper_book`` is a ``PortfolioManager.get_portfolio_book`` result — the
    shape to copy. ``equity`` and ``own_positions`` describe the LIVE portfolio
    doing the copying: its own total value and its own recorded quantities, NOT
    the broker account's aggregate. Passing the broker's aggregate here is what
    made two sleeves of one account liquidate each other (see migration 083):
    a symbol held by another sleeve would appear with target weight 0 and get
    sold in full.
    ``price_fn(ticker) -> float`` supplies the price for share math (raises to
    signal an unusable price; that ticker is skipped). Returns orders with
    sells first (free buying power) then buys, each sorted by ticker.
    """
    total = float(paper_book.get("total_value_usd") or 0)
    if total <= 0 or equity <= 0:
        return []

    # Target weight per name from the paper book's market values.
    target_w: dict[str, float] = {}
    for h in paper_book.get("holdings", []):
        mv = float(h.get("market_value_usd") or 0)
        if mv > 0:
            target_w[h["ticker"]] = mv / total

    sells: list[MirrorOrder] = []
    buys: list[MirrorOrder] = []
    for ticker in sorted(set(target_w) | set(own_positions)):
        try:
            price = price_fn(ticker)
        except PortfolioError:
            logger.warning("mirror: no price for %s — skipping", ticker)
            continue
        if not price or price <= 0:
            continue

        tw = target_w.get(ticker, 0.0)
        cur_qty = float(own_positions.get(ticker, 0.0))
        cur_w = (cur_qty * price) / equity if equity else 0.0
        if abs(tw - cur_qty * price / equity) <= threshold:
            continue

        target_qty = (tw * equity) / price
        delta = round(target_qty - cur_qty, 4)
        if abs(delta) * price < min_order_usd:
            continue
        order = MirrorOrder(
            ticker=ticker,
            side="buy" if delta > 0 else "sell",
            qty=abs(delta),
            target_w=tw,
            cur_w=cur_w,
            ref_price=price,
        )
        (buys if delta > 0 else sells).append(order)

    return sells + buys


def account_sleeves(db: SupabaseDB, live_pf: dict) -> list[dict]:
    """Every live portfolio sharing this one's broker account, including itself.

    More than one means the account is running **sleeves** (migration 083): the
    broker's cash and positions are pooled, and each sleeve owns a share of them
    that only AlphaMolt knows about.
    """
    key = account_key_for_portfolio(live_pf)
    return [
        p for p in db.get_human_portfolios()
        if (p.get("mode") or "paper") == "live"
        and account_key_for_portfolio(p) == key
    ]


def check_account_alignment(
    db: SupabaseDB,
    pm: PortfolioManager,
    executor: BrokerBackend,
    sleeves_: list[dict],
) -> list[sleeves.PositionDrift]:
    """Do the sleeves' combined records match what the broker actually holds?

    This is the safety gate for the whole sleeve model. Each sleeve computes its
    orders from its OWN recorded holdings, so those records being right is what
    makes the orders right. If they've diverged from the broker — an untracked
    manual trade, a corporate action, a fill we recorded that never happened —
    then every order derived from them is wrong too, and the fix is a human
    looking at it, not a robot trading through it.
    """
    recorded = sleeves.recorded_positions({
        p["id"]: pm.get_portfolio_book(p["id"]) for p in sleeves_
    })
    actual = {s: p.qty for s, p in executor.get_positions().items()}
    return sleeves.position_drift(recorded, actual)


def _journal_run(db: SupabaseDB, live_pf: dict, result: dict, *, dry_run: bool) -> None:
    """Record what a mirror run actually did, attributed to its sleeve.

    A mirror legitimately does NOTHING on plenty of runs — the market was shut,
    nothing had drifted, our records disagreed with the broker — and that reason
    used to live only in the Actions log. The owner's hub therefore couldn't
    tell a quiet run from a broken one, which is exactly the ambiguity that
    makes a real-money page feel untrustworthy. One journal row per run fixes
    it, and `run_logs` is already the project's "a job ran" table so it needs no
    migration (the website reads it through an explicit script_name allowlist,
    so it can't surface publicly).

    Best-effort: a journal failure must never fail a run that placed orders.
    """
    try:
        db.log_run("live_mirror", {
            "updated": int(result.get("placed") or 0),
            "details": {
                "portfolio_id": live_pf.get("id"),
                "slug": live_pf.get("slug"),
                "status": result.get("status"),
                "orders": int(result.get("orders") or 0),
                "placed": int(result.get("placed") or 0),
                "dry_run": bool(dry_run),
                "shared_account": bool(result.get("shared_account") or False),
            },
        })
    except Exception as exc:  # noqa: BLE001 — journaling is never fatal
        logger.warning(
            "mirror %s: run journal failed: %s", live_pf.get("slug"), exc,
        )


def mirror_paper_to_broker(
    db: SupabaseDB,
    pm: PortfolioManager,
    executor: BrokerBackend,
    live_pf: dict,
    paper_pf: dict,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    dry_run: bool = False,
) -> dict:
    """Rebalance one live portfolio to match its paper book, and journal it.

    Thin wrapper over :func:`_mirror_paper_to_broker` that records the outcome
    (including "did nothing, because…") for the owner's live account panel.
    """
    result = _mirror_paper_to_broker(
        db, pm, executor, live_pf, paper_pf,
        threshold=threshold, dry_run=dry_run,
    )
    _journal_run(db, live_pf, result, dry_run=dry_run)
    return result


def _mirror_paper_to_broker(
    db: SupabaseDB,
    pm: PortfolioManager,
    executor: BrokerBackend,
    live_pf: dict,
    paper_pf: dict,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    dry_run: bool = False,
) -> dict:
    """Rebalance one live portfolio to match the paper portfolio it follows.

    Skips when the market is closed (the mirror needs fills; a queued order
    would desync the book until the next run).

    **Sizing and diffing are per-portfolio, never per-account.** Target weights
    come from the paper book, but they are applied to this live portfolio's OWN
    equity (its recorded holdings plus its cash allowance) and diffed against its
    OWN recorded holdings. That is what lets several live portfolios share one
    broker account: sleeve A's book never mentions the symbols only sleeve B
    holds, so A can't mistake them for drift and liquidate them. Reading the
    broker's aggregate here instead — as this did before migration 083 — makes
    two sleeves destroy each other's positions on every run.

    Each fill is booked to this portfolio: its holdings go up, its allowance
    comes down, and sale proceeds return to its own allowance.

    Broker-neutral: everything it needs comes through the ``BrokerBackend``
    protocol, so this loop is shared by every broker.
    """
    live_slug = live_pf.get("slug") or live_pf["id"][:8]
    if live_pf.get("mode") != "live":
        raise ValueError(f"{live_slug} is not mode='live'")

    if not dry_run and not executor.market_is_open():
        logger.info("mirror %s: market closed — skipping this run", live_slug)
        return {"status": "market_closed", "orders": 0}

    siblings = account_sleeves(db, live_pf)
    shared = len(siblings) > 1

    # Safety gate: our records must agree with the broker before we trade off
    # them. Strict when the account is shared (a wrong split is unrecoverable
    # and would have one sleeve trading another's shares); a warning when this
    # portfolio is the account's only occupant, where sync_to_db still owns
    # reconciliation and pre-083 behaviour is preserved.
    drift = check_account_alignment(db, pm, executor, siblings)
    if drift:
        detail = "; ".join(d.describe() for d in drift[:8])
        if shared:
            logger.error(
                "mirror %s: REFUSING to trade — records disagree with the "
                "broker on %d symbol(s) across %d sleeves: %s. Repair before "
                "the next run: `alpaca_execution.py --repair %s` books the "
                "missing fills at their real broker prices (--sync cannot: it "
                "would overwrite this sleeve from the account's pooled view "
                "and destroy the split).",
                live_slug, len(drift), len(siblings), detail, live_slug,
            )
            return {
                "status": "drift_refused",
                "orders": 0,
                "drift": [d.describe() for d in drift],
                "shared_account": shared,
            }
        logger.warning(
            "mirror %s: records disagree with the broker on %d symbol(s): %s "
            "— sole occupant of the account, so continuing and letting sync "
            "reconcile.", live_slug, len(drift), detail,
        )

    paper_book = pm.get_portfolio_book(paper_pf["id"])
    live_book = pm.get_portfolio_book(live_pf["id"])
    equity = float(live_book.get("total_value_usd") or 0)
    own_positions = sleeves.sleeve_own_positions(live_book)

    orders = plan_mirror(
        paper_book, equity, own_positions, pm.get_price, threshold=threshold
    )
    tag = "DRY-RUN " if dry_run else ""
    logger.info(
        "%smirror %s <- %s: own equity=$%.2f (cash=$%.2f), %d order(s)%s",
        tag, live_slug, paper_pf.get("slug"), equity,
        float(live_book.get("cash_usd") or 0), len(orders),
        f", sharing account with {len(siblings) - 1} other sleeve(s)"
        if shared else "",
    )

    agent_id = _mirror_agent_id(db)
    band = price_band_from_env()
    # The sleeve's own allowance, tracked as fills land. Sells credit it, buys
    # debit it, and no buy is placed for more than it can pay for — the RPC that
    # books the fill enforces the same ceiling, and it enforces it AFTER the
    # broker has already taken the shares.
    allowance = float(live_book.get("cash_usd") or 0)
    placed = 0
    skipped_unaffordable = 0
    for o in orders:
        qty = o.qty
        if o.side == "buy" and not dry_run:
            limit_price = band_limit_price("buy", o.ref_price, band)
            qty = sleeves.affordable_buy_qty(o.qty, limit_price, allowance)
            if qty <= 0:
                logger.warning(
                    "  SKIP buy %-8s %.4f sh — allowance $%.2f cannot cover "
                    "$%.2f at the $%.2f limit",
                    o.ticker, o.qty, allowance, o.qty * limit_price, limit_price,
                )
                skipped_unaffordable += 1
                continue
            if qty < o.qty:
                logger.info(
                    "  TRIM buy %-8s %.4f -> %.4f sh to fit the $%.2f allowance",
                    o.ticker, o.qty, qty, allowance,
                )
        logger.info(
            "  %s %-8s %.4f sh   (target_w=%.1f%% cur_w=%.1f%%)",
            o.side, o.ticker, qty, o.target_w * 100, o.cur_w * 100,
        )
        if dry_run:
            continue
        try:
            res = executor.execute_and_wait(
                o.ticker, o.side, qty,
                allow_live=True, ref_price=o.ref_price,
            )
            if res.filled_qty > 0 and _record_fill(
                pm, live_pf["id"], agent_id, o, res, live_slug,
            ):
                placed += 1
                cash_delta = res.filled_qty * res.avg_price
                allowance += -cash_delta if o.side == "buy" else cash_delta
        except Exception as exc:  # noqa: BLE001 — one bad order shouldn't abort the rebalance
            logger.error("  order %s %s failed: %s", o.side, o.ticker, exc)

    if not dry_run and placed and not shared:
        # Sole occupant: the broker is the source of truth for the whole book,
        # so the pre-083 state mirror still applies and cleans up anything the
        # per-fill recording above missed (queued fills, fees, dividends).
        # A shared account must NOT be synced this way — the overwrite would
        # hand one sleeve every position in the account.
        broker_sync.sync_to_db(executor, db, live_slug)

    return {
        "status": "ok",
        "orders": len(orders),
        "placed": placed,
        "unaffordable": skipped_unaffordable,
        "shared_account": shared,
    }


def _mirror_agent_id(db: SupabaseDB) -> str | None:
    """The house agent mirror fills are attributed to (migration 083).

    A mirror order is nobody's decision — the paper book's agents made those —
    so it gets its own handle rather than borrowing ``manual`` (owner-initiated)
    and blurring the trade tape.
    """
    agent = db.get_agent_by_handle("live-mirror")
    if agent:
        return agent["id"]
    logger.warning(
        "no 'live-mirror' house agent found (migration 083 not applied?) — "
        "falling back to 'manual' for fill attribution"
    )
    fallback = db.get_agent_by_handle("manual")
    return fallback["id"] if fallback else None


def _record_fill(
    pm: PortfolioManager,
    portfolio_id: str,
    agent_id: str | None,
    order: MirrorOrder,
    res,
    live_slug: str,
) -> bool:
    """Book an actual fill against the portfolio that ordered it.

    Records the **filled** quantity at the **fill** price, so the sleeve's
    holdings and allowance move by exactly what happened at the broker — a buy
    debits its allowance, a sell credits it back. Returns True when the DB was
    updated.

    The atomic RPCs **return** a rejection rather than raising it (an
    over-allowance buy comes back as ``{"status": "insufficient_cash", ...}``),
    so a try/except alone does not know whether the fill was booked. Both
    outcomes are checked, because the failure they hide is the worst one this
    module has: real shares bought at the broker that no sleeve's records own,
    reported by the run as a success. That is what halted trading on
    2026-08-26 — the last buy of a 40-order rebalance filled ~$77 beyond the
    sleeve's allowance, the RPC refused it, and the run still logged
    ``placed: 40``.
    """
    if not agent_id:
        logger.error(
            "  %s %s filled %.4f @ $%.4f but no agent to attribute it to — "
            "NOT recorded; reconcile manually",
            order.side, order.ticker, res.filled_qty, res.avg_price,
        )
        return False
    note = f"live mirror {live_slug} [{getattr(res, 'order_id', '') or '?'}]"
    try:
        if order.side == "buy":
            result = pm.buy_portfolio_atomic(
                portfolio_id, agent_id, order.ticker, res.filled_qty,
                note=note, price_override=res.avg_price,
            )
        else:
            result = pm.sell_portfolio_atomic(
                portfolio_id, agent_id, order.ticker, res.filled_qty,
                note=note, price_override=res.avg_price,
            )
        status = (result or {}).get("status")
        if status != "ok":
            logger.error(
                "  %s %s filled %.4f @ $%.4f at the broker but the DB "
                "REJECTED it (%s) — records now disagree with the broker and "
                "the next run will refuse to trade until repaired "
                "(alpaca_execution.py --repair %s)",
                order.side, order.ticker, res.filled_qty, res.avg_price,
                status or result, live_slug,
            )
            return False
        return True
    except Exception as exc:  # noqa: BLE001 — the money already moved at the broker
        logger.error(
            "  %s %s filled %.4f @ $%.4f at the broker but recording it "
            "FAILED (%s) — records now disagree with the broker and the next "
            "run will refuse to trade until reconciled",
            order.side, order.ticker, res.filled_qty, res.avg_price, exc,
        )
        return False


#: Back-compat alias — the mirror was Alpaca-only when it was written.
mirror_paper_to_alpaca = mirror_paper_to_broker


def _sibling_paper_portfolio(db: SupabaseDB, live_pf: dict) -> dict | None:
    """The paper portfolio the live follower mirrors.

    Resolved by the explicit follows_portfolio_id link (migration 070). A live
    row with no link (pre-070 / hand-made) falls back to the owner's paper
    portfolio only when there is exactly ONE — with several paper books the
    pairing is ambiguous and we skip rather than guess.
    """
    follows = live_pf.get("follows_portfolio_id")
    if follows:
        paper = db.get_portfolio_by_id(follows)
        if paper and (paper.get("mode") or "paper") != "live":
            return paper
        logger.warning(
            "live %s follows_portfolio_id %s is broken (missing or not paper) — skipping",
            live_pf.get("slug") or live_pf.get("id"), follows,
        )
        return None

    owner = live_pf.get("owner_user_id")
    if not owner:
        return None
    papers = [
        p for p in db.get_human_portfolios()
        if p.get("owner_user_id") == owner and (p.get("mode") or "paper") != "live"
    ]
    if len(papers) == 1:
        return papers[0]
    logger.warning(
        "live %s has no follows_portfolio_id and owner has %d paper books — skipping",
        live_pf.get("slug") or live_pf.get("id"), len(papers),
    )
    return None


def _mirror_all_live(
    db: SupabaseDB,
    pm: PortfolioManager,
    *,
    threshold: float,
    dry_run: bool,
) -> int:
    """Mirror every mode='live' portfolio to its paper sibling.

    The scheduled / automatic path (market-hours cron). Honors the master
    kill-switch (``broker.live_execution_enabled``): with it unset, a real run
    is a no-op (unset the secret to halt all automatic live trading). A
    --dry-run always previews regardless. Per-portfolio errors are logged and
    skipped so one bad book can't abort the rest.
    """
    if not dry_run and not live_execution_enabled():
        logger.warning(
            "%s not set — automatic live mirror is a no-op. "
            "Set it to enable scheduled real-money mirroring.", LIVE_EXEC_ENV,
        )
        return 0

    live = [
        p for p in db.get_human_portfolios()
        if (p.get("mode") or "paper") == "live"
    ]
    if not live:
        logger.info("no live portfolios to mirror")
        return 0

    # The bare ALPACA_* env vars name ONE account, so falling back to them is
    # only safe while every live portfolio resolves to that same account. The
    # test is therefore "one distinct broker_account_key", NOT "one live
    # portfolio": several sleeves of a single account are unambiguous and keep
    # using the plain credentials, while two portfolios pointing at genuinely
    # different accounts are refused so one owner's targets can never land in
    # another's account.
    single = len({account_key_for_portfolio(p) for p in live}) == 1
    rc = 0
    for live_pf in live:
        slug = live_pf.get("slug") or live_pf["id"][:8]
        paper_pf = _sibling_paper_portfolio(db, live_pf)
        if not paper_pf:
            logger.warning("no paper sibling for %s — skipping", slug)
            continue
        try:
            executor = resolve_backend_for_portfolio(
                live_pf, allow_shared_fallback=single,
            )
        except BrokerError as exc:
            logger.warning("skipping %s: %s", slug, exc)
            rc = 1
            continue
        try:
            summary = mirror_paper_to_broker(
                db, pm, executor, live_pf, paper_pf,
                threshold=threshold, dry_run=dry_run,
            )
            logger.info("mirror %s: %s", slug, summary)
        except Exception as exc:  # noqa: BLE001
            logger.error("mirror %s failed: %s", slug, exc)
            rc = 1
    return rc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Mirror a paper portfolio to its live broker account")
    ap.add_argument("--slug", help="the LIVE portfolio slug")
    ap.add_argument(
        "--mirror-all-live",
        action="store_true",
        help="mirror every mode='live' portfolio to its paper sibling "
             "(scheduled automatic path; honors ALPACA_LIVE_EXECUTION_ENABLED)",
    )
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    db = SupabaseDB()
    pm = PortfolioManager(db)

    if args.mirror_all_live:
        return _mirror_all_live(
            db, pm, threshold=args.threshold, dry_run=args.dry_run,
        )

    if not args.slug:
        logger.error("--slug is required (or use --mirror-all-live)")
        return 1
    live_pf = db.get_portfolio_by_slug(args.slug)
    if not live_pf:
        logger.error("no portfolio with slug %r", args.slug)
        return 1
    if live_pf.get("mode") != "live":
        logger.error("%s is not a live portfolio (mode=%r)", args.slug,
                     live_pf.get("mode"))
        return 1
    paper_pf = _sibling_paper_portfolio(db, live_pf)
    if not paper_pf:
        logger.error("no sibling paper portfolio found for %s", args.slug)
        return 1

    try:
        executor = resolve_backend_for_portfolio(
            live_pf, allow_shared_fallback=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("broker init failed: %s", exc)
        return 1

    summary = mirror_paper_to_broker(
        db, pm, executor, live_pf, paper_pf,
        threshold=args.threshold, dry_run=args.dry_run,
    )
    logger.info("mirror summary: %s", summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
