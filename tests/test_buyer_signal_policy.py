#!/usr/bin/env python3
"""The buyer must filter break and extend signals under DIFFERENT rules.

`thesis_policy.signal_permitted` takes a required `kind` because the two kinds
of signal fail in opposite directions on a price-relative field:

  * break + a DOWNSIDE static threshold -> born broken. The screen filters
    `perf_52w_vs_spy < -20`, the buyer wrote the same thing as its exit
    trigger, and every candidate arrived pre-broken.
  * extend + an UPSIDE static threshold -> the unreachable wish.
    `perf_52w_vs_spy > 0` on a name the screen guarantees is below -20 needs a
    30-point swing in a trailing-twelve-month number.

So an UPSIDE static threshold is legitimate as a break signal (it is a
take-profit: "sell if the multiple re-rates past 15") and illegitimate as an
extend one. `tests/test_thesis_policy.py` pins the rule; this file pins the
WIRING — that `_evaluate_ticker` passes the right kind at each of its two call
sites. Swapping them would silently outlaw take-profits and re-admit the wish,
and no test of the pure function would notice.

Run: pytest tests/test_buyer_signal_policy.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_watchlist_buyer as b  # noqa: E402
import thesis_policy as tp  # noqa: E402
from llm_providers import LLMResponse  # noqa: E402


def _evaluate(monkeypatch, *, break_signals, extend_signals, policy=None):
    """Drive `_evaluate_ticker` with a canned model reply."""
    payload = {
        "verdict": "BUY",
        "conviction": 5,
        "rationale": "r",
        "thesis_text": "t",
        "break_signals": break_signals,
        "extend_signals": extend_signals,
    }
    monkeypatch.setattr(b, "call_llm", lambda **kw: LLMResponse(
        text=json.dumps(payload), model="m", provider="p",
    ))
    return b._evaluate_ticker(
        provider="p", model="m", ticker="ABC",
        equity_data={"ticker": "ABC"},
        curator_rationale=None,
        portfolio={"cash_usd": 100_000.0, "total_value_usd": 1_000_000.0},
        portfolio_mandate="buy good things",
        max_tokens=1024, temperature=0.2, max_signals=5,
        policy=policy if policy is not None else tp.resolve_policy({}),
    )


def _fields(signals):
    return [s["field"] for s in signals]


# ---------------------------------------------------------------------------
# The wiring
# ---------------------------------------------------------------------------


def test_a_take_profit_break_signal_survives(monkeypatch):
    out = _evaluate(
        monkeypatch,
        break_signals=[
            {"field": "ps_now", "op": ">", "value": 15,
             "description": "multiple re-rated"},
        ],
        extend_signals=[],
    )
    assert "error" not in out, out
    assert _fields(out["break_signals"]) == ["ps_now"]
    assert out["policy_dropped_signals"] == []


def test_the_same_threshold_as_an_extend_signal_is_dropped(monkeypatch):
    out = _evaluate(
        monkeypatch,
        break_signals=[],
        extend_signals=[
            {"field": "ps_now", "op": ">", "value": 15, "description": "wish"},
        ],
    )
    assert "error" not in out, out
    assert out["extend_signals"] == []
    assert out["policy_dropped_signals"] == ["ps_now > 15.0"]


def test_both_kinds_filtered_in_one_reply(monkeypatch):
    """The swap test: each kind must be judged by its own rule, together."""
    out = _evaluate(
        monkeypatch,
        break_signals=[
            {"field": "ps_now", "op": ">", "value": 15, "description": "keep"},
            {"field": "perf_52w_vs_spy", "op": "<", "value": -20,
             "description": "born broken"},
        ],
        extend_signals=[
            {"field": "perf_52w_vs_spy", "op": ">", "value": 0,
             "description": "wish"},
            {"field": "gross_margin_pct", "op": ">", "value": 50,
             "description": "real confirmation"},
        ],
    )
    assert "error" not in out, out
    assert _fields(out["break_signals"]) == ["ps_now"]
    assert _fields(out["extend_signals"]) == ["gross_margin_pct"]
    assert sorted(out["policy_dropped_signals"]) == [
        "perf_52w_vs_spy < -20.0", "perf_52w_vs_spy > 0.0",
    ]


def test_the_stop_loss_shape_is_still_refused_on_a_break_signal(monkeypatch):
    """The original defect must stay fixed by the same call site."""
    out = _evaluate(
        monkeypatch,
        break_signals=[
            {"field": "perf_52w_vs_spy", "op": "<", "value": -20,
             "description": "FICO's real signal"},
        ],
        extend_signals=[],
    )
    assert out["break_signals"] == []
    assert out["policy_dropped_signals"] == ["perf_52w_vs_spy < -20.0"]


def test_a_plain_price_stop_reaches_the_thesis(monkeypatch):
    """`price` left RELATIVE_FIELDS in #4019 — the buyer must honour that."""
    out = _evaluate(
        monkeypatch,
        break_signals=[
            {"field": "price", "op": "<", "value": 45, "description": "stop"},
        ],
        extend_signals=[],
    )
    assert _fields(out["break_signals"]) == ["price"]
    assert out["policy_dropped_signals"] == []


def test_the_toggle_off_lets_everything_through(monkeypatch):
    out = _evaluate(
        monkeypatch,
        break_signals=[
            {"field": "perf_52w_vs_spy", "op": "<", "value": -20, "description": "d"},
        ],
        extend_signals=[
            {"field": "perf_52w_vs_spy", "op": ">", "value": 0, "description": "d"},
        ],
        policy=tp.resolve_policy({"relative_fields_change_only": False}),
    )
    assert _fields(out["break_signals"]) == ["perf_52w_vs_spy"]
    assert _fields(out["extend_signals"]) == ["perf_52w_vs_spy"]
    assert out["policy_dropped_signals"] == []


# ---------------------------------------------------------------------------
# The prompt must teach what the filter enforces
#
# CLAUDE.md: "the buyer's prompt also teaches the rules, so the model authors
# compliant signals rather than having them silently filtered." A prompt that
# still describes the old blanket ban trains the model away from take-profits
# the filter would now accept — and the one that shipped also still listed
# `price` as relative, months after #4019 removed it.
# ---------------------------------------------------------------------------


def test_the_prompt_no_longer_calls_price_a_relative_field():
    line = next(
        l for l in b.BUYER_SYSTEM_PROMPT.splitlines()
        if "PRICE-RELATIVE fields" in l
    )
    listed = [f.strip() for f in line.split("(", 1)[1].split(")", 1)[0].split(",")]
    assert "price" not in listed, listed
    assert sorted(listed) == sorted(tp.RELATIVE_FIELDS), listed


@pytest.mark.parametrize("phrase", ["take-profit", "ps_now > 15"])
def test_the_prompt_tells_the_model_take_profits_are_allowed(phrase):
    assert phrase in b.BUYER_SYSTEM_PROMPT
