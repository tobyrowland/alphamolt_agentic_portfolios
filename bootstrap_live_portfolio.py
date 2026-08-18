#!/usr/bin/env python3
"""
Create the private live (Alpaca) follower portfolio for a user.

A live portfolio (migration 037) is a thin private follower of the user's
arena (paper) portfolio: no mandate, no member agents. It mirrors the paper
book's composition onto a real Alpaca account (see alpaca_mirror.py). This
one-off script creates the row + an empty account; you then point it at the
real account with `alpaca_execution.py --go-live <slug>`, which seeds the
cash/holdings/baseline from Alpaca.

Several live portfolios per owner are allowed since migration 083 — each is a
**sleeve** of a broker account, declared by ``broker_account_key``. The rules
this script enforces:

  - one follower per paper book (the heartbeat's live↔paper pairing is keyed
    by paper id and refuses duplicates);
  - when the owner already has live portfolios, the new one must share their
    broker account: ``--account-key`` names it, defaulting to the sole
    existing account's key. Leaving the key NULL in that situation would make
    the new row fall back to its own slug — a "different account" — which
    (under the bare ALPACA_* credentials) stops the mirror for every live
    portfolio.

The created row records which paper book it mirrors via follows_portfolio_id
(migration 070).

    python bootstrap_live_portfolio.py --paper-slug my-arena-portfolio
    python bootstrap_live_portfolio.py --paper-slug second-strategy \
        --account-key my-arena-portfolio-live
    python bootstrap_live_portfolio.py --paper-slug mine --slug mine-live \
        --display-name "My Live Book"

Next:
    python alpaca_execution.py --go-live <live-slug>   # reseed from Alpaca
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date

from db import SupabaseDB

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger("bootstrap_live_portfolio")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Create a private live follower portfolio")
    ap.add_argument("--paper-slug", required=True,
                    help="slug of the user's existing arena (paper) portfolio")
    ap.add_argument("--slug", help="slug for the live portfolio (default: <paper>-live)")
    ap.add_argument("--display-name",
                    help="display name (default: '<paper name> (Live)')")
    ap.add_argument("--account-key",
                    help="broker_account_key — which broker account this sleeve "
                         "belongs to (default: the owner's sole existing "
                         "account's key; required if they span several)")
    args = ap.parse_args(argv)

    db = SupabaseDB()

    paper = db.get_portfolio_by_slug(args.paper_slug)
    if not paper:
        logger.error("no portfolio with slug %r", args.paper_slug)
        return 1
    owner = paper.get("owner_user_id")
    if not owner:
        logger.error("%r is not a human-owned portfolio (no owner_user_id)",
                     args.paper_slug)
        return 1
    if (paper.get("mode") or "paper") == "live":
        logger.error("%r is itself a live portfolio; pass the PAPER slug",
                     args.paper_slug)
        return 1

    # One follower per paper book — the heartbeat's pairing is keyed by
    # paper id (agent_heartbeat._pair_live_followers) and errors on duplicates.
    follower = (
        db.client.table("portfolios")
        .select("slug")
        .eq("follows_portfolio_id", paper["id"])
        .eq("mode", "live")
        .execute()
    )
    if follower.data:
        logger.error("%r already has a live follower: %s",
                     args.paper_slug, follower.data[0]["slug"])
        return 1

    # Sleeves (migration 083): the owner may run several live portfolios, but
    # every one on the same broker account must carry the SAME account key.
    existing = (
        db.client.table("portfolios")
        .select("slug, broker_account_key")
        .eq("owner_user_id", owner)
        .eq("mode", "live")
        .execute()
    ).data or []
    existing_keys = sorted({
        (p.get("broker_account_key") or "").strip() or p["slug"]
        for p in existing
    })
    account_key = args.account_key
    if existing and not account_key:
        if len(existing_keys) == 1:
            account_key = existing_keys[0]
            logger.info("joining existing broker account %r as a sleeve",
                        account_key)
        else:
            logger.error(
                "owner's live portfolios span several broker accounts (%s) — "
                "pass --account-key to say which one this sleeve joins",
                ", ".join(existing_keys),
            )
            return 1

    slug = args.slug or f"{paper['slug']}-live"
    display_name = args.display_name or f"{paper['display_name']} (Live)"

    row = {
        "slug": slug,
        "display_name": display_name,
        "owner_user_id": owner,
        "owner_agent_id": None,
        "is_public": False,   # CHECK: a live portfolio must be private
        "mode": "live",
        "description": None,  # followers have no mandate
        "follows_portfolio_id": paper["id"],  # the paper book this mirrors
        # NULL only for a first, sole-occupant live portfolio (slug fallback).
        "broker_account_key": account_key,
    }
    db._sanitize(row)
    db.client.table("portfolios").insert(row).execute()

    created = db.get_portfolio_by_slug(slug)
    if not created:
        logger.error("insert succeeded but could not read back %r", slug)
        return 1
    pid = created["id"]

    # Empty account — --go-live reseeds cash/starting_cash/inception from Alpaca.
    db.upsert_portfolio_account(pid, {
        "cash_usd": 0,
        "starting_cash": 0,
        "inception_date": date.today().isoformat(),
    })

    logger.info("created live follower portfolio: %s (id=%s)", slug, pid)
    logger.info("next: set ALPACA_* env, then  "
                "python alpaca_execution.py --go-live %s", slug)
    return 0


if __name__ == "__main__":
    sys.exit(main())
