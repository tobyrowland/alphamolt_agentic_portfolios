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
"""

from __future__ import annotations

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


class LLMProviderError(RuntimeError):
    """Raised when a provider call fails after the adapter's own retries."""


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
) -> LLMResponse:
    """Dispatch to the right provider adapter."""
    if provider not in PROVIDERS:
        raise LLMProviderError(f"unknown provider: {provider}")
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
        return _call_gemini(model, system, user, max_tokens, temperature)
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
    # Some newer Anthropic models (e.g. Opus 4.7) reject `temperature`. We
    # try with it first, drop it on the second attempt if that's the issue.
    send_temperature = True
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
            resp = client.messages.create(**kwargs)
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
        except APIError as exc:  # type: ignore[misc]
            last_err = exc
            logger.warning("anthropic call attempt %d failed: %s", attempt + 1, exc)
            if "temperature" in str(exc).lower() and send_temperature:
                send_temperature = False
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


def _call_gemini(
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
) -> LLMResponse:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise LLMProviderError("GEMINI_API_KEY env var not set")
    try:
        import google.generativeai as genai  # type: ignore
    except ImportError as exc:
        raise LLMProviderError(
            f"google-generativeai SDK not installed: {exc}"
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
                output_tokens=getattr(usage, "candidates_token_count", None)
                if usage else None,
            )
        except Exception as exc:  # noqa: BLE001 — SDK exception class is broad
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
