"""Thin LLM provider adapters for the llm_pick strategy.

Single dispatch surface — the picker calls ``call_llm(provider=…, model=…)``
and gets back a raw text response. Each adapter reads its own API key from
env vars (per-provider naming so secrets stay scoped):

    anthropic → ANTHROPIC_API_KEY
    openai    → CODEX_API_KEY            # OpenAI's Codex line
    deepseek  → DEEPSEEK_API_KEY         # OpenAI-compatible API
    google    → GEMINI_API_KEY           # already used by update_ai_narratives.py

The picker is responsible for parsing JSON out of the response (with one
retry on failure). Adapters here are deliberately dumb — model in,
text out, errors raised — so they're easy to swap or add to.

REASONING DEPTH. ``call_llm`` takes an optional ``thinking_level``
(``minimal`` | ``low`` | ``medium`` | ``high``) so a caller can buy more
deliberation per call without changing model. Today only the Google adapter
acts on it — Gemini 3.x exposes it directly — and every other provider
ignores it, so the knob is safe to set on any agent config.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import time
from dataclasses import dataclass

logger = logging.getLogger("llm_providers")


PROVIDERS = ("anthropic", "openai", "deepseek", "google", "xai", "qwen")

# Per-provider env var holding the API key. Centralised so the heartbeat
# workflow's env stanza and the agents.config docs can stay in sync.
ENV_VAR_FOR_PROVIDER = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "CODEX_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "google": "GEMINI_API_KEY",
    "xai": "GROK_API_KEY",
    "qwen": "DASHSCOPE_API_KEY",
}

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
XAI_BASE_URL = "https://api.x.ai/v1"
# Alibaba's DashScope exposes an OpenAI-compatible endpoint that serves
# the Qwen model family. We dispatch via _call_openai_compatible.
QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"

# --- Gemini 3.x reasoning depth ------------------------------------------
#
# Gemini 3 replaced 2.5's numeric `thinking_budget` with a coarse
# `thinking_level`; sending BOTH in one request is a hard 400, so the adapter
# only ever sends the level, and only to a 3.x model.
THINKING_LEVELS = ("minimal", "low", "medium", "high")

# Gemini 3 is documented to DEGRADE below its default temperature of 1.0:
# "setting it below 1.0 may lead to unexpected behavior, such as looping or
# degraded performance, particularly in complex mathematical or reasoning
# tasks". Every caller in this repo passes 0.2 — a Gemini-2.5-era habit baked
# into agents.config rows we don't control — so the floor is enforced HERE,
# at the one place that knows which model family it is talking to, rather
# than trusted to each config remembering.
GEMINI3_MIN_TEMPERATURE = 1.0

# Substrings that mean "this model id does not exist for this API/key" rather
# than "the call failed". Worth separating because a retired preview model is
# a silent, total outage: the buyer evaluates nothing and reports "no
# candidates met the conviction threshold" — the exact failure mode PR #1045
# and the Anthropic streaming bug both produced. See `fallback_model`.
_MODEL_UNAVAILABLE_MARKERS = (
    "not_found",
    "404",
    "is not found for api version",
    "not supported for",
    "does not exist",
    "unsupported model",
)


class LLMProviderError(RuntimeError):
    """Raised when a provider call fails after the adapter's own retries."""


class LLMModelUnavailableError(LLMProviderError):
    """The model id itself is gone/unknown — retrying it will never help.

    Distinct from a transient failure so ``call_llm`` can swap in
    ``fallback_model`` instead of leaving an agent silently doing nothing.
    """


@dataclass
class LLMResponse:
    """Uniform return shape across providers."""

    text: str
    model: str
    provider: str
    input_tokens: int | None = None
    output_tokens: int | None = None


def call_llm(
    *,
    provider: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int = 8192,
    temperature: float = 0.2,
    thinking_level: str | None = None,
    fallback_model: str | None = None,
) -> LLMResponse:
    """Dispatch to the right provider adapter.

    ``thinking_level`` buys reasoning depth on models that expose it (Gemini
    3.x today); providers that don't ignore it. ``fallback_model`` is used ONLY
    when the primary model turns out not to exist — the failure mode a preview
    model id (e.g. ``gemini-3.1-pro-preview``) eventually hits when Google
    retires it. Everything else still raises.
    """
    if provider not in PROVIDERS:
        raise LLMProviderError(f"unknown provider: {provider}")
    try:
        return _dispatch(
            provider=provider, model=model, system=system, user=user,
            max_tokens=max_tokens, temperature=temperature,
            thinking_level=thinking_level,
        )
    except LLMModelUnavailableError:
        if not fallback_model or fallback_model == model:
            raise
        # Loud: the configured brain is gone. The run continues on the
        # fallback so an agent degrades instead of silently doing nothing,
        # but this needs a human to repoint agents.config.
        logger.error(
            "model %r unavailable for provider %s — falling back to %r. "
            "Update agents.config: the configured model is retired or unknown.",
            model, provider, fallback_model,
        )
        return _dispatch(
            provider=provider, model=fallback_model, system=system, user=user,
            max_tokens=max_tokens, temperature=temperature,
            thinking_level=thinking_level,
        )


def _dispatch(
    *,
    provider: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
    thinking_level: str | None,
) -> LLMResponse:
    if provider == "anthropic":
        return _call_anthropic(model, system, user, max_tokens, temperature)
    if provider == "openai":
        return _call_openai_compatible(
            model, system, user, max_tokens, temperature,
            api_key_env="CODEX_API_KEY",
            base_url=None,
            provider_label="openai",
        )
    if provider == "deepseek":
        return _call_openai_compatible(
            model, system, user, max_tokens, temperature,
            api_key_env="DEEPSEEK_API_KEY",
            base_url=DEEPSEEK_BASE_URL,
            provider_label="deepseek",
        )
    if provider == "google":
        return _call_gemini(
            model, system, user, max_tokens, temperature,
            thinking_level=thinking_level,
        )
    if provider == "xai":
        return _call_openai_compatible(
            model, system, user, max_tokens, temperature,
            api_key_env="GROK_API_KEY",
            base_url=XAI_BASE_URL,
            provider_label="xai",
        )
    if provider == "qwen":
        return _call_openai_compatible(
            model, system, user, max_tokens, temperature,
            api_key_env="DASHSCOPE_API_KEY",
            base_url=QWEN_BASE_URL,
            provider_label="qwen",
        )
    # Unreachable — guarded by PROVIDERS check above, but keeps type-checkers happy.
    raise LLMProviderError(f"unhandled provider: {provider}")


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

# Models discovered (this process) to reject the `temperature` param, so we
# stop sending it after the first 400 instead of paying the retry tax per call.
_NO_TEMPERATURE_MODELS: set[str] = set()

def _accepts_temperature(stream_fn) -> bool:
    """Does this SDK's `messages.stream` take a `temperature` kwarg?

    anthropic **1.0.0 removed `temperature` (and `top_p`) from
    `Messages.create` and `Messages.stream` entirely** — no `**kwargs`, so
    passing it raises `TypeError` *before* any HTTP request. That is not an
    `APIError`, so the drop-and-retry path below never saw it, and every
    Anthropic call died the same way:

        Messages.stream() got an unexpected keyword argument 'temperature'

    requirements.txt pins `anthropic>=0.40.0`, so a runner resolving 1.0.0 took
    out every Anthropic caller at once — `double_down` evaluated 0 of 16 held
    names, and `buyer-claude` / the bull evaluator fail identically.

    Asking the bound method we are ABOUT TO CALL — rather than the version
    string, an import path, or a per-model allowlist — keeps one rule that
    survives SDK upgrades in both directions and makes no assumption about the
    package layout. A signature we cannot read, or one with `**kwargs`, is
    treated as accepting it: the API-level fallback below still covers a model
    that rejects it at request time.
    """
    try:
        params = inspect.signature(stream_fn).parameters
    except (TypeError, ValueError):  # builtins / C-implemented callables
        return True
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return True
    return "temperature" in params


def _call_anthropic(
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
) -> LLMResponse:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise LLMProviderError("ANTHROPIC_API_KEY env var not set")
    try:
        from anthropic import Anthropic, APIError  # type: ignore
    except ImportError as exc:
        raise LLMProviderError(f"anthropic SDK not installed: {exc}") from exc

    client = Anthropic(api_key=api_key)
    last_err: Exception | None = None
    # Some newer Anthropic models (e.g. Opus 4.7+) reject `temperature`. We try
    # with it first, drop it on a temperature error, and REMEMBER that for the
    # model so every later call this process skips it from the start (a buyer
    # run is ~40 calls — without the cache each one pays a 400-then-retry tax).
    send_temperature = (
        _accepts_temperature(client.messages.stream)
        and model not in _NO_TEMPERATURE_MODELS
    )
    for attempt in range(2):
        try:
            kwargs = {
                "model": model,
                "max_tokens": max_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            }
            if send_temperature:
                kwargs["temperature"] = temperature
            # ALWAYS stream, even though we only want the final message.
            #
            # The SDK refuses a non-streaming request whose `max_tokens` implies
            # a completion that could exceed the 10-minute HTTP limit:
            #   "Streaming is required for operations that may take longer than
            #    10 minutes"
            # Every caller inheriting the buyer defaults sends max_tokens=65536,
            # so `messages.create` failed on EVERY ticker of EVERY run. That is
            # how `double_down` came to report "no held name met the conviction
            # gate" for weeks while evaluating precisely nothing — and
            # `buyer-claude` would have done the same for anyone who hired it.
            #
            # Streaming unconditionally (rather than only above some max_tokens
            # threshold) keeps one code path: there is no size at which this is
            # worse, and a threshold is just a second thing to get wrong.
            with client.messages.stream(**kwargs) as stream:
                resp = stream.get_final_message()
            text = "".join(
                block.text  # type: ignore[attr-defined]
                for block in resp.content
                if getattr(block, "type", None) == "text"
            )
            usage = getattr(resp, "usage", None)
            return LLMResponse(
                text=text,
                model=model,
                provider="anthropic",
                input_tokens=getattr(usage, "input_tokens", None) if usage else None,
                output_tokens=getattr(usage, "output_tokens", None) if usage else None,
            )
        except TypeError as exc:
            # The SDK rejected a kwarg before any request went out. Only the
            # temperature case is recoverable (drop it and retry); anything
            # else is a real bug and must surface rather than be retried.
            if "temperature" not in str(exc) or not send_temperature:
                raise
            last_err = exc
            send_temperature = False
            _NO_TEMPERATURE_MODELS.add(model)
            continue
        except APIError as exc:  # type: ignore[misc]
            last_err = exc
            logger.warning("anthropic call attempt %d failed: %s", attempt + 1, exc)
            if "temperature" in str(exc).lower() and send_temperature:
                send_temperature = False
                _NO_TEMPERATURE_MODELS.add(model)  # skip it for the rest of the process
                continue  # retry immediately without the deprecated param
            time.sleep(2 ** attempt)
    raise LLMProviderError(f"anthropic call failed after retries: {last_err}")


# ---------------------------------------------------------------------------
# OpenAI-compatible (OpenAI itself + DeepSeek)
# ---------------------------------------------------------------------------


def _call_openai_compatible(
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
    *,
    api_key_env: str,
    base_url: str | None,
    provider_label: str,
) -> LLMResponse:
    api_key = os.environ.get(api_key_env, "").strip()
    if not api_key:
        raise LLMProviderError(f"{api_key_env} env var not set")
    try:
        from openai import OpenAI, APIError  # type: ignore
    except ImportError as exc:
        raise LLMProviderError(f"openai SDK not installed: {exc}") from exc

    kwargs: dict = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    client = OpenAI(**kwargs)

    # OpenAI's GPT-5+ family and reasoning models (o1/o3/o4) require
    # `max_completion_tokens`; legacy chat models and DeepSeek still
    # use `max_tokens`. Pick the right param name by model id rather
    # than discovering it via a 400 on every call.
    model_lower = model.lower()
    needs_completion_tokens = (
        provider_label == "openai"
        and (
            model_lower.startswith("gpt-5")
            or model_lower.startswith("o1")
            or model_lower.startswith("o3")
            or model_lower.startswith("o4")
        )
    )
    token_kwarg = (
        {"max_completion_tokens": max_tokens}
        if needs_completion_tokens
        else {"max_tokens": max_tokens}
    )

    last_err: Exception | None = None
    for attempt in range(2):
        try:
            resp = client.chat.completions.create(
                model=model,
                temperature=temperature,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                response_format={"type": "json_object"},
                **token_kwarg,
            )
            text = resp.choices[0].message.content or ""
            usage = getattr(resp, "usage", None)
            return LLMResponse(
                text=text,
                model=model,
                provider=provider_label,
                input_tokens=getattr(usage, "prompt_tokens", None) if usage else None,
                output_tokens=getattr(usage, "completion_tokens", None) if usage else None,
            )
        except APIError as exc:  # type: ignore[misc]
            last_err = exc
            logger.warning(
                "%s call attempt %d failed: %s",
                provider_label, attempt + 1, exc,
            )
            time.sleep(2 ** attempt)
    raise LLMProviderError(
        f"{provider_label} call failed after retries: {last_err}"
    )


# ---------------------------------------------------------------------------
# Google (Gemini)
# ---------------------------------------------------------------------------


def _is_gemini_3(model: str) -> bool:
    """True for the Gemini 3 generation (3, 3.1, 3.5, 3.7, … Pro/Flash/Lite).

    Matches on the family prefix rather than an allow-list of ids: Google ships
    a new point release every few months and an allow-list would silently drop
    a new model back onto the 2.5 code path (no thinking_level, temperature
    0.2) — the two settings Gemini 3 is most sensitive to.
    """
    return (model or "").strip().lower().startswith("gemini-3")


def _gemini_temperature(model: str, temperature: float) -> float:
    """Clamp a Gemini-2.5-era temperature up to Gemini 3's supported floor."""
    if _is_gemini_3(model) and temperature < GEMINI3_MIN_TEMPERATURE:
        logger.debug(
            "raising temperature %.2f → %.2f for %s (Gemini 3 degrades below "
            "its 1.0 default)", temperature, GEMINI3_MIN_TEMPERATURE, model,
        )
        return GEMINI3_MIN_TEMPERATURE
    return temperature


def _resolve_thinking_level(model: str, thinking_level: str | None) -> str | None:
    """The level to actually send, or None to leave it to the model default.

    Silently drops the knob on non-3.x models: Gemini 2.5 rejects
    `thinking_level` (it only understands the numeric `thinking_budget`), and
    an agent config that carries the key should not start 400-ing just because
    an owner pinned an older model.
    """
    if not thinking_level:
        return None
    level = str(thinking_level).strip().lower()
    if level not in THINKING_LEVELS:
        raise LLMProviderError(
            f"unknown thinking_level {thinking_level!r} "
            f"(expected one of {', '.join(THINKING_LEVELS)})"
        )
    if not _is_gemini_3(model):
        logger.debug("ignoring thinking_level=%s — %s is not a Gemini 3 model",
                     level, model)
        return None
    return level


def _is_model_unavailable(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(marker in msg for marker in _MODEL_UNAVAILABLE_MARKERS)


def _gemini_output_tokens(usage: object) -> int | None:
    """Visible output + thinking tokens.

    Google bills thinking tokens at the OUTPUT rate but reports them in a
    SEPARATE `thoughts_token_count`. Returning only `candidates_token_count`
    would under-report a deep-thinking call's cost by an order of magnitude —
    exactly the calls we now make — so both are summed.
    """
    if usage is None:
        return None
    visible = getattr(usage, "candidates_token_count", None)
    thoughts = getattr(usage, "thoughts_token_count", None)
    if visible is None and thoughts is None:
        return None
    return int(visible or 0) + int(thoughts or 0)


def _call_gemini(
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
    thinking_level: str | None = None,
) -> LLMResponse:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise LLMProviderError("GEMINI_API_KEY env var not set")

    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except ImportError as exc:
        # `google-generativeai` is deprecated (Nov 2025) and cannot reach the
        # Gemini 3 family or thinking_level at all, so it is a fallback for the
        # legacy 2.5 models only — never a silent downgrade for a 3.x config.
        if _is_gemini_3(model):
            raise LLMProviderError(
                f"{model} requires the google-genai SDK "
                f"(pip install google-genai): {exc}"
            ) from exc
        return _call_gemini_legacy(model, system, user, max_tokens, temperature)

    client = genai.Client(api_key=api_key)
    config_kwargs: dict = {
        "system_instruction": system,
        "temperature": _gemini_temperature(model, temperature),
        "max_output_tokens": max_tokens,
        "response_mime_type": "application/json",
    }
    level = _resolve_thinking_level(model, thinking_level)
    if level:
        config_kwargs["thinking_config"] = types.ThinkingConfig(
            thinking_level=level,
        )

    last_err: Exception | None = None
    for attempt in range(2):
        try:
            resp = client.models.generate_content(
                model=model,
                contents=user,
                config=types.GenerateContentConfig(**config_kwargs),
            )
            # Some safety blocks come back with no candidates / no .text.
            text = getattr(resp, "text", None) or ""
            if not text:
                # Surface a parseable signal so the picker can journal it.
                raise LLMProviderError(
                    f"gemini returned empty response (finish_reason="
                    f"{_first_finish_reason(resp)})"
                )
            usage = getattr(resp, "usage_metadata", None)
            return LLMResponse(
                text=text,
                model=model,
                provider="google",
                input_tokens=getattr(usage, "prompt_token_count", None)
                if usage else None,
                output_tokens=_gemini_output_tokens(usage),
            )
        except Exception as exc:  # noqa: BLE001 — SDK exception class is broad
            if _is_model_unavailable(exc):
                # Never burn a retry on a model id that doesn't exist.
                raise LLMModelUnavailableError(
                    f"gemini model {model!r} unavailable: {exc}"
                ) from exc
            last_err = exc
            logger.warning("gemini call attempt %d failed: %s", attempt + 1, exc)
            time.sleep(2 ** attempt)
    raise LLMProviderError(f"gemini call failed after retries: {last_err}")


def _call_gemini_legacy(
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
) -> LLMResponse:
    """Deprecated `google-generativeai` path — Gemini 2.5 and older only."""
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    try:
        import google.generativeai as genai  # type: ignore
    except ImportError as exc:
        raise LLMProviderError(
            f"no Google SDK installed (pip install google-genai): {exc}"
        ) from exc

    genai.configure(api_key=api_key)
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            gen_model = genai.GenerativeModel(
                model_name=model,
                system_instruction=system,
                generation_config={
                    "temperature": temperature,
                    "max_output_tokens": max_tokens,
                    "response_mime_type": "application/json",
                },
            )
            resp = gen_model.generate_content(user)
            text = getattr(resp, "text", None) or ""
            if not text:
                raise LLMProviderError(
                    f"gemini returned empty response (finish_reason="
                    f"{_first_finish_reason(resp)})"
                )
            usage = getattr(resp, "usage_metadata", None)
            return LLMResponse(
                text=text,
                model=model,
                provider="google",
                input_tokens=getattr(usage, "prompt_token_count", None)
                if usage else None,
                output_tokens=_gemini_output_tokens(usage),
            )
        except Exception as exc:  # noqa: BLE001 — SDK exception class is broad
            if _is_model_unavailable(exc):
                raise LLMModelUnavailableError(
                    f"gemini model {model!r} unavailable: {exc}"
                ) from exc
            last_err = exc
            logger.warning("gemini call attempt %d failed: %s", attempt + 1, exc)
            time.sleep(2 ** attempt)
    raise LLMProviderError(f"gemini call failed after retries: {last_err}")


def _first_finish_reason(resp: object) -> str:
    candidates = getattr(resp, "candidates", None)
    if not candidates:
        return "no candidates"
    return str(getattr(candidates[0], "finish_reason", "unknown"))


# ---------------------------------------------------------------------------
# Helpers — JSON parsing that tolerates a leading/trailing prose wrapper
# (some models still emit ```json fences despite response_format hints).
# ---------------------------------------------------------------------------


def parse_json_response(text: str) -> dict:
    """Parse JSON, falling back to the first/last brace pair if wrapped.

    Raises LLMProviderError if no valid JSON can be extracted.
    """
    text = (text or "").strip()
    if not text:
        raise LLMProviderError("empty response")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Strip ```json fences if present.
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
    # Last resort: substring between first '{' and last '}'.
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise LLMProviderError(
                f"could not parse JSON from response: {exc}"
            ) from exc
    raise LLMProviderError("response did not contain a JSON object")
