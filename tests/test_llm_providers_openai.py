"""The OpenAI path must not send `temperature` to a model that only takes its
default.

GPT-5 (and the o-series) reject any non-default temperature with a hard 400:

    Unsupported value: 'temperature' does not support 0.2 with this model.
    Only the default (1) value is supported.

Every `agents.config` in this repo carries the pre-GPT-5 `0.2`, so on
2026-09-15 `buyer-chatgpt` failed every one of the 16 candidates on the
Ex-Taiwan Chip Industry book and the heartbeat reported "no candidates met the
conviction threshold" — a no-op indistinguishable from a quiet market. These
tests pin that the param is never sent to that family, that a rejection from
any other model drops it and retries once, and that the model is remembered
for the rest of the process.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _Usage:
    prompt_tokens = 11
    completion_tokens = 7


class _Choice:
    def __init__(self, text):
        self.message = types.SimpleNamespace(content=text)


class _Response:
    def __init__(self, text="{}"):
        self.choices = [_Choice(text)]
        self.usage = _Usage()


class _APIError(Exception):
    def __init__(self, message, *, param=None, code=None):
        super().__init__(message)
        self.param = param
        self.code = code


TEMPERATURE_400 = (
    "Error code: 400 - {'error': {'message': \"Unsupported value: 'temperature' "
    "does not support 0.2 with this model. Only the default (1) value is "
    "supported.\", 'type': 'invalid_request_error', 'param': 'temperature', "
    "'code': 'unsupported_value'}}"
)


@pytest.fixture(autouse=True)
def _reset_model_cache():
    import llm_providers
    llm_providers._NO_TEMPERATURE_MODELS.clear()
    yield
    llm_providers._NO_TEMPERATURE_MODELS.clear()


@pytest.fixture
def fake_openai(monkeypatch):
    """Install a stub `openai` module. `recorder["reject_temperature"]` makes
    the fake behave like GPT-5 (400 on any request carrying the param)."""
    recorder = {"calls": [], "reject_temperature": False}

    class _Completions:
        def create(self, **kwargs):
            recorder["calls"].append(kwargs)
            if recorder["reject_temperature"] and "temperature" in kwargs:
                raise _APIError(TEMPERATURE_400, param="temperature", code="unsupported_value")
            return _Response()

    class _Client:
        def __init__(self, **_kw):
            self.chat = types.SimpleNamespace(completions=_Completions())

    module = types.ModuleType("openai")
    module.OpenAI = _Client
    module.APIError = _APIError
    monkeypatch.setitem(sys.modules, "openai", module)
    monkeypatch.setenv("CODEX_API_KEY", "sk-test")
    monkeypatch.setattr("time.sleep", lambda *_a, **_k: None)
    return recorder


def _call(model="gpt-5", **overrides):
    import llm_providers

    kwargs = dict(
        model=model, system="sys", user="usr", max_tokens=16384, temperature=0.2,
        api_key_env="CODEX_API_KEY", base_url=None, provider_label="openai",
    )
    kwargs.update(overrides)
    return llm_providers._call_openai_compatible(**kwargs)


def test_gpt5_never_receives_temperature(fake_openai):
    # The production failure: GPT-5 rejects 0.2 outright. The param must not
    # be sent even once — a rejected first attempt is a wasted round trip
    # per candidate, forty times a run.
    fake_openai["reject_temperature"] = True
    resp = _call("gpt-5")
    assert len(fake_openai["calls"]) == 1
    assert "temperature" not in fake_openai["calls"][0]
    assert fake_openai["calls"][0]["max_completion_tokens"] == 16384
    assert resp.provider == "openai" and resp.output_tokens == 7


@pytest.mark.parametrize("model", ["gpt-5-mini", "GPT-5.1", "o3", "o4-mini", "o1"])
def test_the_whole_reasoning_family_is_treated_the_same(fake_openai, model):
    fake_openai["reject_temperature"] = True
    _call(model)
    assert "temperature" not in fake_openai["calls"][0]


def test_legacy_chat_models_still_get_the_configured_temperature(fake_openai):
    _call("gpt-4o")
    call = fake_openai["calls"][0]
    assert call["temperature"] == 0.2
    assert call["max_tokens"] == 16384


def test_deepseek_keeps_temperature_and_max_tokens(fake_openai, monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    _call("deepseek-chat", api_key_env="DEEPSEEK_API_KEY",
          base_url="https://api.deepseek.com", provider_label="deepseek")
    call = fake_openai["calls"][0]
    assert call["temperature"] == 0.2 and call["max_tokens"] == 16384


def test_an_unlisted_model_that_rejects_temperature_recovers_and_is_remembered(fake_openai):
    # A model outside the known family starts refusing the param: drop it,
    # retry once without it, and never send it to that model again this
    # process.
    import llm_providers
    fake_openai["reject_temperature"] = True
    resp = _call("gpt-6-preview")
    assert resp.text == "{}"
    assert [("temperature" in c) for c in fake_openai["calls"]] == [True, False]
    assert "gpt-6-preview" in llm_providers._NO_TEMPERATURE_MODELS

    fake_openai["calls"].clear()
    _call("gpt-6-preview")
    assert len(fake_openai["calls"]) == 1
    assert "temperature" not in fake_openai["calls"][0]


def test_a_rejection_signalled_only_in_the_message_is_recognised(fake_openai):
    # Other OpenAI-compatible providers don't set `.param`; the message is
    # enough.
    import llm_providers
    assert llm_providers._is_temperature_error(_APIError(TEMPERATURE_400))
    assert not llm_providers._is_temperature_error(_APIError("rate limit exceeded"))


def test_an_unrelated_error_is_not_treated_as_a_temperature_rejection(fake_openai):
    import llm_providers

    class _Completions:
        def create(self, **kwargs):
            fake_openai["calls"].append(kwargs)
            raise _APIError("Error code: 500 - server error")

    sys.modules["openai"].OpenAI = lambda **_kw: types.SimpleNamespace(
        chat=types.SimpleNamespace(completions=_Completions()))
    with pytest.raises(llm_providers.LLMProviderError):
        _call("gpt-4o")
    # Both attempts still carried the configured temperature — nothing was
    # dropped on a failure that had nothing to do with it.
    assert all(c["temperature"] == 0.2 for c in fake_openai["calls"])
    assert "gpt-4o" not in llm_providers._NO_TEMPERATURE_MODELS
