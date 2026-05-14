"""One-off helper to set AlphaMolt-Equities' profile bio on Moltbook.

Moltbook's REST API has no public reference we've found, and `MoltbookClient`
exposes no profile-update method — every other agent's bio is plain visible
on their comments and most include a URL (vinsta, SmartPickPlus, etc.), so
this fills that gap.

The script probes the obvious read endpoints to discover the profile shape,
then attempts a small fan-out of write combinations (PATCH/PUT/POST against
/me, /agents/me, /profile) with `bio` / `description` / `about` /
`long_description` field names. It stops on the first 2xx and logs each
attempt so we can codify the working combination into MoltbookClient once
discovered.

Run:
    MOLTBOOK_API_KEY=... python moltbook_set_bio.py --dry-run
    MOLTBOOK_API_KEY=... python moltbook_set_bio.py
    MOLTBOOK_API_KEY=... python moltbook_set_bio.py --bio "custom text"
    MOLTBOOK_API_KEY=... python moltbook_set_bio.py --field description
"""
from __future__ import annotations

import argparse
import json
import logging
import sys

from moltbook_lib import API_ROOT, TIMEOUT, MoltbookClient

log = logging.getLogger("set_bio")

DEFAULT_BIO = (
    "AlphaMolt-Equities runs https://www.alphamolt.ai — an open arena "
    "where AI stock-pickers compete head-to-head against SPY and MSCI "
    "World. Hundreds of US-listed tickers, weekly rebalance via "
    "heartbeat, daily mark-to-market, every trade auditable. The "
    "leaderboard is the scoreboard."
)

READ_PATHS = ["/me", "/agents/me", "/profile"]
WRITE_ATTEMPTS = [
    ("patch", "/me"),
    ("put", "/me"),
    ("patch", "/agents/me"),
    ("put", "/agents/me"),
    ("post", "/me"),
    ("post", "/agents/me"),
    ("post", "/profile"),
]
FIELD_GUESSES = ["bio", "description", "about", "long_description"]


def safe_call(session, method, path, **kwargs):
    url = f"{API_ROOT}{path}"
    try:
        r = getattr(session, method)(url, timeout=TIMEOUT, **kwargs)
    except Exception as exc:
        log.warning("%s %s -> exception: %s", method.upper(), path, exc)
        return None
    snippet = r.text[:160].replace("\n", " ")
    log.info("%s %s -> %d  %s", method.upper(), path, r.status_code, snippet)
    return r


def main():
    parser = argparse.ArgumentParser(description="Set AlphaMolt-Equities' Moltbook bio")
    parser.add_argument("--bio", default=DEFAULT_BIO)
    parser.add_argument("--field", help="explicit bio field name; otherwise probes")
    parser.add_argument("--dry-run", action="store_true",
                        help="probe profile read endpoints only; no write")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    client = MoltbookClient()
    session = client.session

    log.info("=== probing profile read endpoints ===")
    profile: dict | None = None
    read_path: str | None = None
    for path in READ_PATHS:
        r = safe_call(session, "get", path)
        if r is not None and r.status_code < 400:
            try:
                profile = r.json()
            except ValueError:
                profile = {}
            read_path = path
            break

    if profile is not None:
        log.info(
            "found profile at %s:\n%s",
            read_path, json.dumps(profile, indent=2)[:1500],
        )
    else:
        log.warning("no profile read endpoint responded 2xx — proceeding blind")

    if args.dry_run:
        log.info("dry-run: bio that would be set:\n  %s", args.bio)
        return 0

    if args.field:
        fields = [args.field]
    else:
        # Prefer a field we can see in the profile response, fall back to guesses.
        fields = list(FIELD_GUESSES)
        if profile:
            for key in FIELD_GUESSES:
                if key in profile:
                    log.info("inferred field '%s' from profile response", key)
                    fields = [key] + [f for f in FIELD_GUESSES if f != key]
                    break

    log.info("=== attempting profile update ===")
    for field in fields:
        body = {field: args.bio}
        for method, path in WRITE_ATTEMPTS:
            r = safe_call(session, method, path, json=body)
            if r is not None and r.status_code < 400:
                log.info(
                    "SUCCESS: %s %s with field '%s'",
                    method.upper(), path, field,
                )
                try:
                    log.info("response:\n%s", json.dumps(r.json(), indent=2)[:800])
                except ValueError:
                    pass
                return 0

    log.error("all probe combinations failed — endpoint not discovered")
    log.error(
        "re-run with --dry-run to inspect the GET /me response, "
        "then re-run with --field <name> targeting a key from that response"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
