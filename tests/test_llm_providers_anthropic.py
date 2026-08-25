"""The Anthropic provider must STREAM, not use messages.create().

The SDK refuses a non-streaming request whose `max_tokens` implies a completion
that could exceed the 10-minute HTTP limit:

    "Streaming is required for operations that may take longer than 10 minutes"

Every caller inheriting the buyer defaults sends max_tokens=65536, so
`messages.create` failed on EVERY ticker of EVERY run. `double_down` reported
"no held name met the conviction gate" for three consecutive runs while
evaluating nothing, and `buyer-claude` would have done the same for any owner
who hired it. These tests pin the streaming call so it cannot regress.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _Block:
    type = "text"

    def __init__(self, text):
        self.text = text


class _Usage:
    input_tokens = 11
    output_tokens = 22


class _Message:
    content = [_Block("hello")]
    usage = _Usage()


class _Stream:
    """Context manager mimicking client.messages.stream(...)."""

    def __init__(self, recorder, kwargs):
        self._recorder = recorder
        self._kwargs = kwargs

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        self._recorder["streamed"].append(self._kwargs)
        return _Message()


class _Messages:
    def __init__(self, recorder):
        self._recorder = recorder

    def stream(self, **kwargs):
        return _Stream(self._recorder, kwargs)

    def create(self, **kwargs):  # pragma: no cover - must never be reached
        self._recorder["created"].append(kwargs)
        raise AssertionError(
            "messages.create() was called — this is the 10-minute bug. "
            "The Anthropic path must stream."
        )


class _Client:
    def __init__(self, recorder, **_kw):
        self.messages = _Messages(recorder)


@pytest.fixture
def fake_anthropic(monkeypatch):
    """Install a stub `anthropic` module and return the call recorder."""
    recorder = {"streamed": [], "created": []}

    class _APIError(Exception):
        pass

    module = types.ModuleType("anthropic")
    module.Anthropic = lambda **kw: _Client(recorder, **kw)
    module.APIError = _APIError
    monkeypatch.setitem(sys.modules, "anthropic", module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    return recorder


def _call(**overrides):
    import llm_providers

    kwargs = dict(
        model="claude-opus-4-8",
        system="sys",
        user="usr",
        max_tokens=65536,
        temperature=0.2,
    )
    kwargs.update(overrides)
    return llm_providers._call_anthropic(**kwargs)


def test_uses_streaming_not_create(fake_anthropic):
    resp = _call()
    assert fake_anthropic["streamed"], "expected a streaming call"
    assert not fake_anthropic["created"]
    assert resp.text == "hello"
    assert resp.provider == "anthropic"


def test_the_large_max_tokens_that_broke_production_is_passed_through(fake_anthropic):
    """65536 is the value every buyer-defaults caller sends."""
    _call(max_tokens=65536)
    assert fake_anthropic["streamed"][0]["max_tokens"] == 65536


def test_usage_is_still_reported(fake_anthropic):
    resp = _call()
    assert resp.input_tokens == 11
    assert resp.output_tokens == 22


def test_small_max_tokens_streams_too(fake_anthropic):
    """One code path — no threshold to get wrong."""
    _call(max_tokens=256)
    assert len(fake_anthropic["streamed"]) == 1
    assert not fake_anthropic["created"]
