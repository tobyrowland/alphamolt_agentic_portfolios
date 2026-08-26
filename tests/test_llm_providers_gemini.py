"""Gemini adapter: reasoning depth, temperature floor, cost accounting, fallback.

Four things here are easy to get wrong and expensive-but-silent when you do,
which is why each is pinned:

1. `thinking_level` is a Gemini-3-only parameter. Sent to a 2.5 model it 400s;
   combined with the legacy `thinking_budget` it also 400s. Either way the
   agent evaluates nothing and reports "no candidates met the conviction
   threshold" — a total outage that reads like a quiet market.
2. Gemini 3 degrades below its 1.0 default temperature. Every agents.config row
   in this repo predates Gemini 3 and carries 0.2.
3. Thinking tokens bill at the OUTPUT rate but are reported separately from
   `candidates_token_count`. Counting only the visible tokens under-reports a
   deep-thinking run's cost by an order of magnitude.
4. `gemini-3.1-pro-preview` is a preview id. When Google retires it, a plain
   retry loop turns the buyer and the reviewer into no-ops indefinitely.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_providers  # noqa: E402


# --------------------------------------------------------------------------
# Fake google-genai SDK
# --------------------------------------------------------------------------


class _Usage:
    def __init__(self, prompt=100, visible=200, thoughts=4000):
        self.prompt_token_count = prompt
        self.candidates_token_count = visible
        self.thoughts_token_count = thoughts


class _Resp:
    def __init__(self, text='{"ok": true}', usage=None):
        self.text = text
        self.usage_metadata = usage if usage is not None else _Usage()


class _ThinkingConfig:
    def __init__(self, thinking_level=None, thinking_budget=None):
        self.thinking_level = thinking_level
        self.thinking_budget = thinking_budget


class _GenerateContentConfig:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
        self._kwargs = kwargs


def _install_fake_sdk(monkeypatch, *, responses=None, error=None):
    """Put a minimal `google.genai` in sys.modules; return the call recorder."""
    calls: list[dict] = []
    queue = list(responses or [])

    class _Models:
        def generate_content(self, **kwargs):
            calls.append(kwargs)
            if error is not None:
                raise error
            return queue.pop(0) if queue else _Resp()

    class _Client:
        def __init__(self, api_key=None):
            self.api_key = api_key
            self.models = _Models()

    genai_mod = types.ModuleType("google.genai")
    genai_mod.Client = _Client
    types_mod = types.ModuleType("google.genai.types")
    types_mod.ThinkingConfig = _ThinkingConfig
    types_mod.GenerateContentConfig = _GenerateContentConfig
    genai_mod.types = types_mod
    google_pkg = types.ModuleType("google")
    google_pkg.genai = genai_mod

    monkeypatch.setitem(sys.modules, "google", google_pkg)
    monkeypatch.setitem(sys.modules, "google.genai", genai_mod)
    monkeypatch.setitem(sys.modules, "google.genai.types", types_mod)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    # Never actually sleep through the adapter's backoff.
    monkeypatch.setattr(llm_providers.time, "sleep", lambda *_a, **_k: None)
    return calls


def _config_of(call) -> dict:
    return call["config"]._kwargs


# --------------------------------------------------------------------------
# 1. thinking_level is sent only to Gemini 3
# --------------------------------------------------------------------------


def test_gemini_3_receives_thinking_level(monkeypatch):
    calls = _install_fake_sdk(monkeypatch)
    llm_providers.call_llm(
        provider="google", model="gemini-3.1-pro-preview",
        system="s", user="u", thinking_level="high",
    )
    cfg = _config_of(calls[0])
    assert cfg["thinking_config"].thinking_level == "high"
    # The legacy numeric budget must never ride along — sending both is a 400.
    assert cfg["thinking_config"].thinking_budget is None


def test_gemini_25_never_receives_thinking_level(monkeypatch):
    """A 2.5 model rejects the param, so an agent config carrying the key must
    still work rather than 400 on every ticker."""
    calls = _install_fake_sdk(monkeypatch)
    llm_providers.call_llm(
        provider="google", model="gemini-2.5-pro",
        system="s", user="u", thinking_level="high",
    )
    assert "thinking_config" not in _config_of(calls[0])


def test_no_thinking_level_leaves_model_default(monkeypatch):
    calls = _install_fake_sdk(monkeypatch)
    llm_providers.call_llm(
        provider="google", model="gemini-3.1-pro-preview", system="s", user="u",
    )
    assert "thinking_config" not in _config_of(calls[0])


@pytest.mark.parametrize("model", [
    "gemini-3-flash-preview", "gemini-3.1-pro-preview",
    "gemini-3.5-flash", "gemini-3.7-flash", "GEMINI-3.9-PRO",
])
def test_family_prefix_matches_every_gemini_3_point_release(model):
    """Prefix match, not an allow-list: a new point release must not fall back
    onto the 2.5 code path (no thinking_level, temperature 0.2)."""
    assert llm_providers._is_gemini_3(model)


@pytest.mark.parametrize("model", ["gemini-2.5-pro", "gemini-2.5-flash", ""])
def test_non_gemini_3_models_are_not_matched(model):
    assert not llm_providers._is_gemini_3(model)


def test_unknown_thinking_level_is_rejected(monkeypatch):
    _install_fake_sdk(monkeypatch)
    with pytest.raises(llm_providers.LLMProviderError, match="thinking_level"):
        llm_providers.call_llm(
            provider="google", model="gemini-3.1-pro-preview",
            system="s", user="u", thinking_level="ultra",
        )


# --------------------------------------------------------------------------
# 2. temperature floor
# --------------------------------------------------------------------------


def test_gemini_3_temperature_is_raised_to_the_supported_floor(monkeypatch):
    calls = _install_fake_sdk(monkeypatch)
    llm_providers.call_llm(
        provider="google", model="gemini-3.1-pro-preview",
        system="s", user="u", temperature=0.2,
    )
    assert _config_of(calls[0])["temperature"] == 1.0


def test_gemini_25_temperature_is_left_alone(monkeypatch):
    calls = _install_fake_sdk(monkeypatch)
    llm_providers.call_llm(
        provider="google", model="gemini-2.5-pro",
        system="s", user="u", temperature=0.2,
    )
    assert _config_of(calls[0])["temperature"] == 0.2


def test_a_higher_temperature_is_never_lowered(monkeypatch):
    calls = _install_fake_sdk(monkeypatch)
    llm_providers.call_llm(
        provider="google", model="gemini-3.1-pro-preview",
        system="s", user="u", temperature=1.4,
    )
    assert _config_of(calls[0])["temperature"] == 1.4


# --------------------------------------------------------------------------
# 3. cost accounting — thinking tokens bill as output
# --------------------------------------------------------------------------


def test_output_tokens_include_thinking_tokens(monkeypatch):
    _install_fake_sdk(
        monkeypatch,
        responses=[_Resp(usage=_Usage(prompt=5000, visible=200, thoughts=4000))],
    )
    resp = llm_providers.call_llm(
        provider="google", model="gemini-3.1-pro-preview",
        system="s", user="u", thinking_level="high",
    )
    assert resp.input_tokens == 5000
    assert resp.output_tokens == 4200  # NOT 200


def test_output_tokens_survive_a_model_that_reports_no_thoughts(monkeypatch):
    class _NoThoughts:
        prompt_token_count = 10
        candidates_token_count = 20

    _install_fake_sdk(monkeypatch, responses=[_Resp(usage=_NoThoughts())])
    resp = llm_providers.call_llm(
        provider="google", model="gemini-2.5-pro", system="s", user="u",
    )
    assert resp.output_tokens == 20


def test_missing_usage_metadata_reports_none(monkeypatch):
    _install_fake_sdk(monkeypatch, responses=[_Resp(usage=None)])
    # _Resp substitutes a default usage when passed None, so build it directly.
    assert llm_providers._gemini_output_tokens(None) is None


# --------------------------------------------------------------------------
# 4. retired-model fallback
# --------------------------------------------------------------------------


def test_missing_model_raises_the_distinct_unavailable_error(monkeypatch):
    _install_fake_sdk(
        monkeypatch,
        error=RuntimeError("404 models/gemini-3.1-pro-preview is not found "
                           "for API version v1beta"),
    )
    with pytest.raises(llm_providers.LLMModelUnavailableError):
        llm_providers.call_llm(
            provider="google", model="gemini-3.1-pro-preview",
            system="s", user="u",
        )


def test_a_missing_model_burns_no_retries(monkeypatch):
    """Retrying an id that doesn't exist just doubles the latency of failing."""
    calls = _install_fake_sdk(monkeypatch, error=RuntimeError("404 NOT_FOUND"))
    with pytest.raises(llm_providers.LLMModelUnavailableError):
        llm_providers.call_llm(
            provider="google", model="gemini-3.1-pro-preview",
            system="s", user="u",
        )
    assert len(calls) == 1


def test_transient_errors_still_retry_and_do_not_fall_back(monkeypatch):
    calls = _install_fake_sdk(monkeypatch, error=RuntimeError("503 overloaded"))
    with pytest.raises(llm_providers.LLMProviderError) as exc:
        llm_providers.call_llm(
            provider="google", model="gemini-3.1-pro-preview",
            system="s", user="u", fallback_model="gemini-3.7-flash",
        )
    assert not isinstance(exc.value, llm_providers.LLMModelUnavailableError)
    assert len(calls) == 2                       # retried
    assert all(c["model"] == "gemini-3.1-pro-preview" for c in calls)


def test_retired_preview_falls_back_instead_of_silently_doing_nothing(monkeypatch):
    """The whole point: a retired preview id must degrade the agent, not mute it."""
    calls: list[dict] = []
    attempts = {"n": 0}

    class _Models:
        def generate_content(self, **kwargs):
            calls.append(kwargs)
            attempts["n"] += 1
            if kwargs["model"] == "gemini-3.1-pro-preview":
                raise RuntimeError("404 NOT_FOUND: model has been retired")
            return _Resp()

    class _Client:
        def __init__(self, api_key=None):
            self.models = _Models()

    genai_mod = types.ModuleType("google.genai")
    genai_mod.Client = _Client
    types_mod = types.ModuleType("google.genai.types")
    types_mod.ThinkingConfig = _ThinkingConfig
    types_mod.GenerateContentConfig = _GenerateContentConfig
    genai_mod.types = types_mod
    google_pkg = types.ModuleType("google")
    google_pkg.genai = genai_mod
    monkeypatch.setitem(sys.modules, "google", google_pkg)
    monkeypatch.setitem(sys.modules, "google.genai", genai_mod)
    monkeypatch.setitem(sys.modules, "google.genai.types", types_mod)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(llm_providers.time, "sleep", lambda *_a, **_k: None)

    resp = llm_providers.call_llm(
        provider="google", model="gemini-3.1-pro-preview",
        system="s", user="u", thinking_level="high",
        fallback_model="gemini-3.7-flash",
    )
    assert resp.model == "gemini-3.7-flash"
    assert [c["model"] for c in calls] == [
        "gemini-3.1-pro-preview", "gemini-3.7-flash",
    ]
    # The fallback inherits the requested depth — a cheaper brain, not a
    # shallower question.
    assert _config_of(calls[1])["thinking_config"].thinking_level == "high"


def test_no_fallback_configured_still_raises(monkeypatch):
    _install_fake_sdk(monkeypatch, error=RuntimeError("404 NOT_FOUND"))
    with pytest.raises(llm_providers.LLMModelUnavailableError):
        llm_providers.call_llm(
            provider="google", model="gemini-3.1-pro-preview",
            system="s", user="u",
        )


# --------------------------------------------------------------------------
# 5. the legacy SDK must never silently serve a Gemini 3 config
# --------------------------------------------------------------------------


def test_gemini_3_without_the_new_sdk_fails_loudly(monkeypatch):
    """`google-generativeai` cannot reach Gemini 3 or thinking_level at all.
    Falling back to it would quietly answer a different question."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    for name in ("google", "google.genai", "google.genai.types"):
        monkeypatch.delitem(sys.modules, name, raising=False)

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) \
        else __builtins__.__import__

    def _blocked(name, *args, **kwargs):
        if name in ("google", "google.genai") or name.startswith("google.genai"):
            raise ImportError("no google-genai")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", _blocked)
    with pytest.raises(llm_providers.LLMProviderError, match="google-genai"):
        llm_providers.call_llm(
            provider="google", model="gemini-3.1-pro-preview",
            system="s", user="u", thinking_level="high",
        )
