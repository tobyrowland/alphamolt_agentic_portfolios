"""
eval_chunking — run a batched LLM verdict pass in chunks, then re-ask for misses.

Pure: no DB, no LLM, no clock. The bull / bear engines and the consolidated
`verdict_evaluation.py` all share it (`tests/test_eval_chunking.py`).

Why it exists. The verdict pass used to send the whole 300-name rotation batch
to each model in ONE prompt (~300k chars). Claude answered ~291 of 300 but took
~5 minutes — right at the curl timeout, so on three of fourteen days it timed
out on every retry and wrote nothing. Gemini Flash answered the same prompt
with ~6k chars and ~40 verdicts, every single day. Because the rotation batch
is keyed on the OLDER of `bull_at` / `bear_at`, the ~260 names bear failed to
cover came straight back the next day: bear coverage never caught up, and
Claude re-scored the same names daily for nothing (351 Tier-1 names had no
bear verdict at all, 1,266 had one older than 30 days).

The fix is mechanical: ask in chunks small enough that the model reliably
answers every line, keep only the tickers that were actually asked for (a model
may pad with names it remembers), and run one more pass over whatever is still
missing. A chunk whose call fails contributes nothing and is simply retried on
the next pass.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Iterator
from typing import TypeVar

T = TypeVar("T")

# `evaluate_chunk(chunk) -> {ticker: verdict}` — the per-side call: build the
# prompt for these equities, call the model, parse. Returns {} on failure.
ChunkEvaluator = Callable[[list[dict]], dict[str, dict]]

DEFAULT_PASSES = 2
COVERAGE_WARN_FRACTION = 0.9


def chunked(items: Iterable[T], size: int) -> Iterator[list[T]]:
    """Yield consecutive lists of at most `size` items (order preserved)."""
    if size < 1:
        raise ValueError(f"chunk size must be >= 1, got {size}")
    buf: list[T] = []
    for it in items:
        buf.append(it)
        if len(buf) == size:
            yield buf
            buf = []
    if buf:
        yield buf


def equity_ticker(company: dict) -> str:
    return (company.get("ticker") or "").strip().upper()


def run_chunked(
    equities: list[dict],
    evaluate_chunk: ChunkEvaluator,
    *,
    chunk_size: int,
    passes: int = DEFAULT_PASSES,
    side: str = "verdict",
    logger: logging.Logger | None = None,
) -> dict[str, dict]:
    """Evaluate `equities` in chunks of `chunk_size`, merging the parsed
    verdicts; then re-run (up to `passes` total) over only the names that still
    have no verdict.

    A verdict is kept only for a ticker that was in the chunk it came back
    from, and the first verdict for a ticker wins. A chunk whose evaluator
    raises is logged and treated as returning nothing — the next pass picks
    those names up again, and one bad chunk can never sink the whole side.
    """
    log = logger or logging.getLogger(__name__)
    if passes < 1:
        raise ValueError(f"passes must be >= 1, got {passes}")

    verdicts: dict[str, dict] = {}
    remaining = [c for c in equities if equity_ticker(c)]
    total = len(remaining)
    for pass_no in range(1, passes + 1):
        if not remaining:
            break
        n_chunks = (len(remaining) + chunk_size - 1) // chunk_size
        log.info("%s: pass %d — %d name(s) in %d chunk(s) of ≤%d",
                 side, pass_no, len(remaining), n_chunks, chunk_size)
        for idx, chunk in enumerate(chunked(remaining, chunk_size), start=1):
            wanted = {equity_ticker(c) for c in chunk}
            try:
                got = evaluate_chunk(chunk) or {}
            except Exception:  # noqa: BLE001 — one chunk must not sink the side
                log.exception("%s: chunk %d/%d raised — treating as no verdicts",
                              side, idx, n_chunks)
                got = {}
            kept = 0
            for ticker, verdict in got.items():
                t = (ticker or "").strip().upper()
                if t in wanted and t not in verdicts:
                    verdicts[t] = verdict
                    kept += 1
            log.info("%s: chunk %d/%d → %d/%d verdicts", side, idx, n_chunks,
                     kept, len(chunk))
        remaining = [c for c in remaining if equity_ticker(c) not in verdicts]
        if remaining:
            level = logging.WARNING if pass_no == passes else logging.INFO
            log.log(level, "%s: after pass %d, %d/%d name(s) still have no verdict%s",
                    side, pass_no, len(remaining), total,
                    "" if pass_no < passes else
                    f": {', '.join(equity_ticker(c) for c in remaining[:20])}"
                    + (" …" if len(remaining) > 20 else ""))
    return verdicts


def coverage_shortfall(batch_size: int, verdicts: dict, *, side: str,
                       logger: logging.Logger | None = None,
                       warn_below: float = COVERAGE_WARN_FRACTION) -> int:
    """Number of batch names with no verdict on this side; logs a WARNING when
    coverage is below `warn_below` (a quiet shortfall is exactly how the bear
    side ran at ~15% for weeks without anyone noticing)."""
    log = logger or logging.getLogger(__name__)
    missing = max(batch_size - len(verdicts), 0)
    if batch_size and len(verdicts) < warn_below * batch_size:
        log.warning("%s: coverage %d/%d (%.0f%%) — %d name(s) without a verdict",
                    side, len(verdicts), batch_size,
                    100.0 * len(verdicts) / batch_size, missing)
    return missing
