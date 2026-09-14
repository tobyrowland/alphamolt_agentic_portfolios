#!/usr/bin/env python3
"""Unit tests for eval_chunking — the chunked verdict runner shared by the
bull / bear engines and verdict_evaluation.

Pins the failure it was written against: a model that answers only the first
~40 names of a 300-name prompt (the bear side, every day for weeks), and a
call that times out on a whole-batch prompt (the bull side on bad days). Pure:
no DB, no LLM. Run: pytest tests/test_eval_chunking.py
"""

from __future__ import annotations

import logging
import unittest

import eval_chunking as EC


def _eq(tickers):
    return [{"ticker": t, "company_name": t.lower()} for t in tickers]


def _verdict(t, emoji="✅"):
    return {"eval": f"{emoji} 2 fine", "score": 2}


class ChunkedTests(unittest.TestCase):
    def test_sizes_and_order(self):
        out = list(EC.chunked(list(range(7)), 3))
        self.assertEqual(out, [[0, 1, 2], [3, 4, 5], [6]])

    def test_exact_multiple_has_no_empty_tail(self):
        self.assertEqual(list(EC.chunked([1, 2, 3, 4], 2)), [[1, 2], [3, 4]])

    def test_empty(self):
        self.assertEqual(list(EC.chunked([], 5)), [])

    def test_bad_size(self):
        with self.assertRaises(ValueError):
            list(EC.chunked([1], 0))


class RunChunkedTests(unittest.TestCase):
    def setUp(self):
        self.log = logging.getLogger("test_eval_chunking")
        self.calls: list[list[str]] = []

    def _full_answer(self, chunk):
        """A model that answers every name it is asked."""
        self.calls.append([EC.equity_ticker(c) for c in chunk])
        return {EC.equity_ticker(c): _verdict(EC.equity_ticker(c)) for c in chunk}

    def test_splits_into_ceil_n_over_size_calls_and_merges(self):
        eq = _eq([f"T{i}" for i in range(11)])
        out = EC.run_chunked(eq, self._full_answer, chunk_size=4, logger=self.log)
        self.assertEqual(len(self.calls), 3)  # 4 + 4 + 3
        self.assertEqual([len(c) for c in self.calls], [4, 4, 3])
        self.assertEqual(set(out), {f"T{i}" for i in range(11)})

    def test_the_bear_failure_first_forty_only(self):
        """A model that answers only the first 40 names of whatever it is sent
        (the bear side, every day for weeks). Sent 300 at once it covers 40.
        Chunked at 50 with a re-ask pass it covers 290 — pass 1 answers 6×40,
        pass 2 re-asks the 60 misses as 50+10 and answers 40+10 — and chunked
        at the model's real ceiling it covers all 300 in one pass."""
        eq = _eq([f"N{i:03d}" for i in range(300)])

        def first_forty(chunk):
            self.calls.append([EC.equity_ticker(c) for c in chunk])
            return {EC.equity_ticker(c): _verdict(EC.equity_ticker(c)) for c in chunk[:40]}

        whole = EC.run_chunked(eq, first_forty, chunk_size=300, passes=1, logger=self.log)
        self.assertEqual(len(whole), 40)

        self.calls.clear()
        out = EC.run_chunked(eq, first_forty, chunk_size=50, passes=2, logger=self.log)
        self.assertEqual(len(out), 290)
        self.assertEqual([len(c) for c in self.calls], [50] * 6 + [50, 10])

        self.calls.clear()
        out = EC.run_chunked(eq, first_forty, chunk_size=40, passes=2, logger=self.log)
        self.assertEqual(len(out), 300)
        self.assertEqual([len(c) for c in self.calls], [40] * 7 + [20])

    def test_second_pass_resends_only_the_misses(self):
        eq = _eq(["A", "B", "C", "D"])
        answers = iter([
            {"A": _verdict("A")},                 # chunk 1 of pass 1: B missed
            {"C": _verdict("C"), "D": _verdict("D")},  # chunk 2 of pass 1
            {"B": _verdict("B")},                 # pass 2: only B
        ])

        def call(chunk):
            self.calls.append([EC.equity_ticker(c) for c in chunk])
            return next(answers)

        out = EC.run_chunked(eq, call, chunk_size=2, passes=2, logger=self.log)
        self.assertEqual(self.calls, [["A", "B"], ["C", "D"], ["B"]])
        self.assertEqual(set(out), {"A", "B", "C", "D"})

    def test_single_pass_never_retries(self):
        eq = _eq(["A", "B"])

        def call(chunk):
            self.calls.append([EC.equity_ticker(c) for c in chunk])
            return {"A": _verdict("A")}

        out = EC.run_chunked(eq, call, chunk_size=10, passes=1, logger=self.log)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(set(out), {"A"})

    def test_stops_early_when_everything_is_covered(self):
        eq = _eq(["A", "B"])
        EC.run_chunked(eq, self._full_answer, chunk_size=10, passes=3, logger=self.log)
        self.assertEqual(len(self.calls), 1)

    def test_ignores_tickers_that_were_not_asked_for(self):
        """A model may pad its answer with names it remembers; never write those."""
        eq = _eq(["A", "B"])

        def call(chunk):
            return {"A": _verdict("A"), "B": _verdict("B"), "NVDA": _verdict("NVDA")}

        out = EC.run_chunked(eq, call, chunk_size=10, logger=self.log)
        self.assertEqual(set(out), {"A", "B"})

    def test_first_verdict_wins_and_ticker_case_is_normalised(self):
        eq = _eq(["abc"])
        answers = iter([{"ABC": {"eval": "✅ 1 first", "score": 1}},
                        {"ABC": {"eval": "❌ 5 second", "score": 5}}])
        out = EC.run_chunked(eq, lambda c: next(answers), chunk_size=1, passes=2,
                             logger=self.log)
        self.assertEqual(out["ABC"]["score"], 1)

    def test_failed_chunk_returns_nothing_and_is_retried(self):
        """A call failure ({} or an exception) loses only that chunk for that
        pass — the names come back on the next pass."""
        eq = _eq(["A", "B", "C", "D"])
        state = {"n": 0}

        def flaky(chunk):
            state["n"] += 1
            tickers = [EC.equity_ticker(c) for c in chunk]
            self.calls.append(tickers)
            if state["n"] == 1:
                raise RuntimeError("curl timeout")
            if state["n"] == 2:
                return {}
            return {t: _verdict(t) for t in tickers}

        out = EC.run_chunked(eq, flaky, chunk_size=2, passes=2, logger=self.log)
        self.assertEqual(set(out), {"A", "B", "C", "D"})
        self.assertEqual(self.calls, [["A", "B"], ["C", "D"], ["A", "B"], ["C", "D"]])

    def test_skips_equities_without_a_ticker(self):
        eq = [{"ticker": ""}, {"ticker": None}, {"ticker": "A"}]
        out = EC.run_chunked(eq, self._full_answer, chunk_size=10, logger=self.log)
        self.assertEqual(self.calls, [["A"]])
        self.assertEqual(set(out), {"A"})

    def test_bad_passes(self):
        with self.assertRaises(ValueError):
            EC.run_chunked(_eq(["A"]), self._full_answer, chunk_size=1, passes=0)


class CoverageShortfallTests(unittest.TestCase):
    def test_counts_missing(self):
        self.assertEqual(EC.coverage_shortfall(300, {f"T{i}": {} for i in range(40)},
                                               side="bear"), 260)
        self.assertEqual(EC.coverage_shortfall(300, {f"T{i}": {} for i in range(300)},
                                               side="bull"), 0)
        self.assertEqual(EC.coverage_shortfall(0, {}, side="bull"), 0)

    def test_warns_below_threshold_only(self):
        log = logging.getLogger("cov_test")
        with self.assertLogs(log, level="WARNING"):
            EC.coverage_shortfall(300, {f"T{i}": {} for i in range(40)},
                                  side="bear", logger=log)
        with self.assertNoLogs(log, level="WARNING"):
            EC.coverage_shortfall(300, {f"T{i}": {} for i in range(291)},
                                  side="bull", logger=log)


class EngineWiringTests(unittest.TestCase):
    """The engines must route through the chunked runner with the documented
    chunk sizes — a whole-batch call is exactly the regression."""

    def test_bear_evaluate_batch_chunks_and_reasks(self):
        import bear_evaluation as bear
        self.assertEqual(bear.CHUNK_SIZE, 50)
        eq = _eq([f"N{i:03d}" for i in range(120)])
        seen: list[int] = []

        def fake_call(prompt, api_key, logger):
            n = prompt.count("\n--- ")
            seen.append(n)
            # Answer only the first 40 lines of each chunk, like Flash did.
            tickers = [ln.split()[1] for ln in prompt.splitlines() if ln.startswith("--- ")]
            return "\n".join(f"{t}: ❌ 4 weak" for t in tickers[:40])

        orig = bear.call_gemini_bear
        bear.call_gemini_bear = fake_call
        try:
            out = bear.evaluate_batch(eq, "key", logging.getLogger("t"))
        finally:
            bear.call_gemini_bear = orig
        self.assertEqual(len(out), 120)
        self.assertEqual(seen, [50, 50, 20, 20])  # pass 1: 3 chunks; pass 2: 20 misses
        self.assertEqual(out["N000"]["score"], 4)

    def test_bull_evaluate_batch_chunks(self):
        import bull_evaluation as bull
        self.assertEqual(bull.CHUNK_SIZE, 100)
        eq = _eq([f"N{i:03d}" for i in range(250)])
        seen: list[int] = []

        def fake_call(prompt, api_key, logger):
            tickers = [ln.split()[1] for ln in prompt.splitlines() if ln.startswith("--- ")]
            seen.append(len(tickers))
            return "\n".join(f"{t}: ✅ 5 strong" for t in tickers)

        orig = bull.call_claude_bull
        bull.call_claude_bull = fake_call
        try:
            out = bull.evaluate_batch(eq, "key", logging.getLogger("t"))
        finally:
            bull.call_claude_bull = orig
        self.assertEqual(len(out), 250)
        self.assertEqual(seen, [100, 100, 50])


class GeminiPartsJoinTests(unittest.TestCase):
    """Gemini can split one answer over several non-thought parts; keeping only
    the last part silently dropped every verdict line in the earlier ones."""

    def test_all_text_parts_are_joined(self):
        import json
        import bear_evaluation as bear
        raw = json.dumps({"candidates": [{"content": {"parts": [
            {"text": "A: ✅ 1 ok\nB: ❌ 5 bad"},
            {"text": "C: ✅ 2 ok"},
        ]}, "finishReason": "STOP"}]})
        orig = bear._call_gemini_text
        bear._call_gemini_text = lambda *a, **k: raw
        try:
            text = bear.call_gemini_bear("prompt", "key", logging.getLogger("t"))
        finally:
            bear._call_gemini_text = orig
        self.assertEqual(set(bear.parse_bear_results(text)), {"A", "B", "C"})

    def test_thought_parts_are_dropped(self):
        import json
        import bear_evaluation as bear
        raw = json.dumps({"candidates": [{"content": {"parts": [
            {"text": "X: ✅ 1 thinking aloud", "thought": True},
            {"text": "A: ✅ 1 ok"},
        ]}}]})
        orig = bear._call_gemini_text
        bear._call_gemini_text = lambda *a, **k: raw
        try:
            text = bear.call_gemini_bear("prompt", "key", logging.getLogger("t"))
        finally:
            bear._call_gemini_text = orig
        self.assertEqual(set(bear.parse_bear_results(text)), {"A"})


if __name__ == "__main__":
    unittest.main()
