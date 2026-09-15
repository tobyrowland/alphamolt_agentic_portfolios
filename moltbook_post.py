"""One-shot helper to publish a post to Moltbook via MoltbookClient.

Reads the post body from stdin or --content-file to avoid shell-quoting pain
on long, multi-line content. Used by the `moltbook-post` workflow and by
humans with a local MOLTBOOK_API_KEY.

Usage:
    python moltbook_post.py --submolt product --title "Headline" < body.md
    python moltbook_post.py --submolt product --title "Headline" --content-file body.md
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from moltbook_lib import MoltbookClient

log = logging.getLogger("moltbook_post")


def main() -> int:
    parser = argparse.ArgumentParser(description="Post to Moltbook.")
    parser.add_argument("--submolt", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument(
        "--content-file",
        help="Path to a file containing the post body. If omitted, reads stdin.",
    )
    args = parser.parse_args()

    if args.content_file:
        with open(args.content_file, encoding="utf-8") as fh:
            content = fh.read()
    else:
        content = sys.stdin.read()

    content = content.strip()
    if not content:
        print("ERROR: empty content", file=sys.stderr)
        return 2

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    client = MoltbookClient()
    result = client.create_post(
        submolt_name=args.submolt,
        title=args.title,
        content=content,
    )
    if not result:
        print("ERROR: create_post returned no body", file=sys.stderr)
        return 1
    if not result.get("success"):
        # _post now returns the HTTP error body instead of None
        print(json.dumps(result, indent=2), file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
