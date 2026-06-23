#!/usr/bin/env python3
"""
Verdict Evaluation — the consolidated bull + bear pass.

Bull and bear are an ADVERSARIAL pair run on DIFFERENT models on purpose
(bull = Claude, bear = Gemini): a different brain arguing each side has
uncorrelated blind spots, so the screener's bull×bear multiplier multiplies two
genuinely independent reads. This script keeps that — two models, two calls —
but runs them over ONE shared rotation batch and stamps both verdicts with the
SAME timestamp. So `bull_at` and `bear_at` never drift apart (they used to be
two jobs on two clocks, up to ~4 days out of sync), and the screener always
reads one vintage.

It replaces the separate `bull-evaluation` + `bear-evaluation` crons. The
underlying engines (`bull_evaluation` / `bear_evaluation`) stay importable
modules — their `main()` still works for a manual single-side / backfill run.

Selection: the `top_n` stalest Tier-1 names by the OLDER of bull_at/bear_at
(`level0_eval.tier1_eval_candidates(db, "verdict", N)`), gated to verified-fact
names. Writes ONLY `ai_analysis`. One engine failing never drops the other's
results.

Schedule: daily ~04:00 UTC.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import date

from dotenv import load_dotenv

from db import SupabaseDB
import level0_eval
import bull_evaluation as bull
import bear_evaluation as bear

TOP_N = 300  # stalest Tier-1 names refreshed per run (shared rotation batch)


def setup_logging() -> logging.Logger:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    return logging.getLogger("verdict_evaluation")


def _run_bull(top_equities: list[dict], api_key: str,
              logger: logging.Logger) -> dict[str, str]:
    """Claude bull pass over the shared batch. Returns {ticker: verdict}."""
    blocks = [bull.build_equity_block(c) for c in top_equities]
    prompt = bull.build_bull_prompt(blocks)
    logger.info("Bull (Claude %s): prompt %d chars for %d equities",
                bull.CLAUDE_MODEL, len(prompt), len(blocks))
    text = bull.call_claude_bull(prompt, api_key, logger)
    if text is None:
        logger.error("Bull: Claude call failed")
        return {}
    verdicts = bull.parse_bull_results(text)
    logger.info("Bull: parsed %d verdicts", len(verdicts))
    return verdicts


def _run_bear(top_equities: list[dict], api_key: str,
              logger: logging.Logger) -> dict[str, str]:
    """Gemini bear pass over the shared batch. Returns {ticker: verdict}."""
    blocks = [bear.build_equity_block(c) for c in top_equities]
    prompt = bear.build_bear_prompt(blocks)
    logger.info("Bear (Gemini %s): prompt %d chars for %d equities",
                bear.GEMINI_MODEL, len(prompt), len(blocks))
    text = bear.call_gemini_bear(prompt, api_key, logger)
    if text is None:
        logger.error("Bear: Gemini call failed")
        return {}
    verdicts = bear.parse_bear_results(text)
    logger.info("Bear: parsed %d verdicts", len(verdicts))
    return verdicts


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description="Verdict Evaluation — consolidated bull + bear")
    parser.add_argument("--dry-run", action="store_true",
                        help="Evaluate but write nothing")
    parser.add_argument("--only", choices=["bull", "bear"],
                        help="Run only one side (still over the shared batch)")
    args = parser.parse_args()

    logger = setup_logging()
    logger.info("=== Verdict Evaluation started (dry_run=%s, only=%s) ===",
                args.dry_run, args.only or "both")
    start = time.time()

    claude_key = os.environ.get("ANTHROPIC_API_KEY")
    gemini_key = os.environ.get("GEMINI_API_KEY")
    want_bull = args.only in (None, "bull")
    want_bear = args.only in (None, "bear")
    if want_bull and not claude_key:
        logger.error("ANTHROPIC_API_KEY not set (needed for the bull side)")
        return 1
    if want_bear and not gemini_key:
        logger.error("GEMINI_API_KEY not set (needed for the bear side)")
        return 1

    db = SupabaseDB()

    # ONE shared rotation batch (stalest by the older of bull_at/bear_at).
    top_equities = level0_eval.tier1_eval_candidates(db, "verdict", TOP_N)
    logger.info("Selected %d Tier-1 tickers (rotation by min(bull_at, bear_at))",
                len(top_equities))
    if not top_equities:
        logger.warning("Nothing to evaluate.")
        return 0

    # Each engine runs independently — a failure on one side must not lose the
    # other's verdicts (the whole point of one resilient job over two crons).
    bull_verdicts: dict[str, str] = {}
    bear_verdicts: dict[str, str] = {}
    if want_bull:
        try:
            bull_verdicts = _run_bull(top_equities, claude_key, logger)
        except Exception:  # noqa: BLE001
            logger.exception("Bull side crashed — continuing with bear only")
    if want_bear:
        try:
            bear_verdicts = _run_bear(top_equities, gemini_key, logger)
        except Exception:  # noqa: BLE001
            logger.exception("Bear side crashed — continuing with bull only")

    bull_pass = sum(1 for v in bull_verdicts.values() if "✅" in v)
    bear_pass = sum(1 for v in bear_verdicts.values() if "✅" in v)
    logger.info("Bull: %d verdicts (%d ✅) · Bear: %d verdicts (%d ✅)",
                len(bull_verdicts), bull_pass, len(bear_verdicts), bear_pass)

    if not bull_verdicts and not bear_verdicts:
        logger.error("Both sides produced no verdicts. Nothing to write.")
        return 1

    if args.dry_run:
        logger.info("[DRY RUN] no writes. (%.1fs)", time.time() - start)
        return 0

    # Merge into one row per ticker, both verdicts stamped with the SAME clock so
    # bull_at == bear_at going forward.
    ts = date.today().isoformat()
    rows: list[dict] = []
    for company in top_equities:
        ticker = (company.get("ticker") or "").strip()
        if not ticker:
            continue
        row: dict = {"ticker": ticker, "analyzed_at": ts}
        if (bv := bull_verdicts.get(ticker)):
            row["bull_eval"] = bv
            row["bull_at"] = ts
        if (rv := bear_verdicts.get(ticker)):
            row["bear_eval"] = rv
            row["bear_at"] = ts
        # Only write a row that actually carries a verdict.
        if "bull_eval" in row or "bear_eval" in row:
            rows.append(row)

    if rows:
        db.upsert_ai_analysis_batch(rows)
    logger.info("Wrote %d rows", len(rows))

    elapsed = round(time.time() - start, 1)
    db.log_run("verdict_evaluation", {
        "updated": len(rows),
        "skipped": len(top_equities) - len(rows),
        "errors": 0,
        "duration_secs": elapsed,
        "details": {
            "batch_size": len(top_equities),
            "bull_verdicts": len(bull_verdicts),
            "bear_verdicts": len(bear_verdicts),
            "bull_pass": bull_pass,
            "bear_pass": bear_pass,
        },
    })
    logger.info("=== Verdict Evaluation complete: %d rows (%.1fs) ===",
                len(rows), elapsed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
