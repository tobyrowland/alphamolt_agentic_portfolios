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

import inspect
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
    """Stub whose `stream` signature mirrors anthropic 1.0.0 — NO temperature.

    The previous stub took `**kwargs`, so it happily swallowed a parameter the
    real SDK rejects. That permissiveness is exactly why the production failure
    got through a green test suite: every Claude call died on
    "Messages.stream() got an unexpected keyword argument 'temperature'" while
    these tests passed. A stub must be no more forgiving than the thing it
    stands in for.
    """

    def __init__(self, recorder):
        self._recorder = recorder

    def stream(self, *, model, max_tokens, system, messages, **kwargs):
        # Every ATTEMPT is recorded, including one that raises — a call the SDK
        # rejects is still a round trip we paid for, and "it was never sent
        # even once" is only checkable if the failed attempt is visible. The
        # body takes **kwargs so it can see and record the bad one; the
        # DECLARED signature below hides it, which is what the real 1.0.0 SDK
        # looks like from the outside and what the probe reads.
        self._recorder["attempts"].append(dict(kwargs))
        if kwargs:
            raise TypeError(
                "Messages.stream() got an unexpected keyword argument "
                f"{next(iter(kwargs))!r}"
            )
        return _Stream(self._recorder, dict(
            model=model, max_tokens=max_tokens, system=system, messages=messages,
        ))

    # anthropic 1.0.0's real signature: these four, and no temperature.
    stream.__signature__ = inspect.Signature([
        inspect.Parameter("self", inspect.Parameter.POSITIONAL_OR_KEYWORD),
        *(inspect.Parameter(n, inspect.Parameter.KEYWORD_ONLY)
          for n in ("model", "max_tokens", "system", "messages")),
    ])

    def create(self, **kwargs):  # pragma: no cover - must never be reached
        self._recorder["created"].append(kwargs)
        raise AssertionError(
            "messages.create() was called — this is the 10-minute bug. "
            "The Anthropic path must stream."
        )


class _Client:
    def __init__(self, recorder, **_kw):
        self.messages = _Messages(recorder)


@pytest.fixture(autouse=True)
def _reset_model_cache():
    """`_NO_TEMPERATURE_MODELS` is process-wide — keep tests independent."""
    import llm_providers
    llm_providers._NO_TEMPERATURE_MODELS.clear()
    yield
    llm_providers._NO_TEMPERATURE_MODELS.clear()


@pytest.fixture
def fake_anthropic(monkeypatch):
    """Install a stub `anthropic` module and return the call recorder."""
    recorder = {"streamed": [], "created": [], "attempts": []}

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


# ---------------------------------------------------------------------------
# `temperature` and the SDK that dropped it
#
# anthropic 1.0.0 removed `temperature` (and `top_p`) from Messages.create and
# Messages.stream entirely. There is no **kwargs, so passing it raises
# TypeError BEFORE any HTTP request — which is not an APIError, so the existing
# drop-and-retry path never saw it. requirements pins `anthropic>=0.40.0`, so a
# runner resolving 1.0.0 took out every Anthropic caller at once: double_down
# evaluated 0 of 16 held names, all with the same TypeError.
# ---------------------------------------------------------------------------


def test_temperature_is_not_sent_to_an_sdk_that_cannot_take_it(fake_anthropic):
    """The regression: the stub now rejects it, as the real 1.0.0 SDK does."""
    _call(temperature=0.2)
    assert fake_anthropic["streamed"], "the call must still go out"
    assert "temperature" not in fake_anthropic["streamed"][0]


def test_the_bad_kwarg_is_never_sent_even_once(fake_anthropic):
    """The signature is READ, not discovered by failing.

    A TypeError handler alone would also end up sending no temperature — but
    only after every model burned an attempt finding that out. Exactly one
    stream call means the probe did its job.
    """
    _call(temperature=0.2)
    assert fake_anthropic["attempts"] == [{}], fake_anthropic["attempts"]


def test_temperature_is_still_sent_to_an_sdk_that_takes_it(monkeypatch):
    """Older SDKs (0.40.x) accept it — we must not stop sending it there."""
    recorder = {"streamed": [], "created": [], "attempts": []}

    class _OldMessages(_Messages):
        def stream(self, *, model, max_tokens, system, messages, temperature=None):
            self._recorder["attempts"].append({"temperature": temperature})
            return _Stream(self._recorder, dict(
                model=model, max_tokens=max_tokens, system=system,
                messages=messages, temperature=temperature,
            ))

    class _OldClient:
        def __init__(self, **_kw):
            self.messages = _OldMessages(recorder)

    module = types.ModuleType("anthropic")
    module.Anthropic = lambda **kw: _OldClient(**kw)
    module.APIError = type("APIError", (Exception,), {})
    monkeypatch.setitem(sys.modules, "anthropic", module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    _call(temperature=0.7)
    assert recorder["streamed"][0]["temperature"] == 0.7


def test_a_typeerror_that_is_not_about_temperature_is_not_swallowed(monkeypatch):
    """Only the recoverable case retries — real bugs must surface."""
    import llm_providers

    class _BadMessages:
        def stream(self, **kwargs):
            raise TypeError("stream() got an unexpected keyword argument 'banana'")

    class _BadClient:
        def __init__(self, **_kw):
            self.messages = _BadMessages()

    module = types.ModuleType("anthropic")
    module.Anthropic = lambda **kw: _BadClient(**kw)
    module.APIError = type("APIError", (Exception,), {})
    monkeypatch.setitem(sys.modules, "anthropic", module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    with pytest.raises(TypeError, match="banana"):
        llm_providers._call_anthropic(
            model="m", system="s", user="u", max_tokens=256, temperature=0.2,
        )


# ---------------------------------------------------------------------------
# The check a stub cannot make: agree with the SDK that is actually installed.
# ---------------------------------------------------------------------------


def test_our_kwargs_are_all_accepted_by_the_real_installed_sdk():
    """Every kwarg `_call_anthropic` builds must exist on the real signature.

    This is the test the stub could never be: it reads the SDK that CI and the
    Actions runner actually install. A future release dropping another
    parameter fails here instead of in production.
    """
    import inspect
    import llm_providers

    anthropic = pytest.importorskip("anthropic")
    from anthropic.resources.messages import Messages

    params = inspect.signature(Messages.stream).parameters
    sends_temperature = llm_providers._accepts_temperature(Messages.stream)

    always = {"model", "max_tokens", "system", "messages"}
    for name in always:
        assert name in params, f"{name} missing from {anthropic.__version__}"
    assert sends_temperature == ("temperature" in params)


# ---------------------------------------------------------------------------
# The probe itself
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fn,expected,why", [
    (lambda *, model, temperature=None: None, True, "explicit param — send it"),
    (lambda *, model: None, False, "1.0.0 shape — do not send it"),
    (lambda *, model, **kw: None, True, "**kwargs — unknowable, stay permissive"),
    (object(), True, "signature unreadable — stay permissive"),
    (len, False, "readable and has no temperature — a real answer, not a guess"),
])
def test_the_probe_reads_the_signature_it_is_given(fn, expected, why):
    """Permissive on doubt: the API-level fallback still catches a model that
    rejects temperature at request time, but wrongly withholding it from an SDK
    that wants it would silently change every model's sampling."""
    import llm_providers
    assert llm_providers._accepts_temperature(fn) is expected, why
