"""Tests for foundry/llm.py. No network calls: the StubClient tests exercise the deterministic
canned-response registry directly, and the AnthropicClient retry tests swap in a fake chat
object rather than hitting the real Anthropic API."""

from __future__ import annotations

import random

import pytest
from pydantic import BaseModel

from foundry.config import settings
from foundry.llm import AnthropicClient, StubClient, deterministic_seed, get_llm


class _Greeting(BaseModel):
    text: str
    number: int


def _greeting_factory(prompt: str) -> _Greeting:
    seed = deterministic_seed(prompt, _Greeting.__name__)
    rng = random.Random(seed)
    return _Greeting(text=f"hello-{rng.randint(0, 1_000_000)}", number=rng.randint(0, 100))


# --- get_llm switch -----------------------------------------------------------------------


def test_get_llm_returns_stub_when_no_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    assert isinstance(get_llm("worker"), StubClient)
    assert isinstance(get_llm("principal"), StubClient)


def test_get_llm_returns_stub_when_api_key_is_empty_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `cp .env.example .env` without filling in a key leaves ANTHROPIC_API_KEY="" (present but
    # empty) rather than unset — must be treated the same as None, not passed to AnthropicClient.
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    assert isinstance(get_llm("worker"), StubClient)


def test_get_llm_returns_anthropic_client_when_key_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-test-00000000000000000000000000")
    client = get_llm("worker")
    assert isinstance(client, AnthropicClient)


# --- StubClient -----------------------------------------------------------------------------


def test_stub_client_is_deterministic_for_the_same_prompt() -> None:
    stub = StubClient()
    stub.register(_Greeting, _greeting_factory)

    first = stub.structured("plan the churn experiment", _Greeting)
    second = stub.structured("plan the churn experiment", _Greeting)
    assert first == second


def test_stub_client_varies_with_the_prompt() -> None:
    stub = StubClient()
    stub.register(_Greeting, _greeting_factory)

    a = stub.structured("prompt A", _Greeting)
    b = stub.structured("prompt B", _Greeting)
    assert a != b


def test_stub_client_raises_for_unregistered_schema() -> None:
    stub = StubClient()
    with pytest.raises(KeyError, match="_Greeting"):
        stub.structured("anything", _Greeting)


# --- AnthropicClient retry-on-parse-failure --------------------------------------------------


class _FakeStructuredRunnable:
    def __init__(self, results: list[dict]) -> None:
        self._results = list(results)

    def invoke(self, messages: object) -> dict:
        return self._results.pop(0)


class _FakeChat:
    def __init__(self, results: list[dict]) -> None:
        self._results = results

    def with_structured_output(
        self, schema: type, include_raw: bool = False
    ) -> _FakeStructuredRunnable:
        return _FakeStructuredRunnable(self._results)


def _anthropic_client(
    monkeypatch: pytest.MonkeyPatch, *, max_parse_retries: int
) -> AnthropicClient:
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-test-00000000000000000000000000")
    monkeypatch.setattr(settings, "llm_max_parse_retries", max_parse_retries)
    client = get_llm("worker")
    assert isinstance(client, AnthropicClient)
    return client


def test_anthropic_client_retries_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _anthropic_client(monkeypatch, max_parse_retries=2)
    good = _Greeting(text="ok", number=1)
    client._chat = _FakeChat(  # type: ignore[attr-defined]
        [
            {"raw": None, "parsed": None, "parsing_error": ValueError("bad json")},
            {"raw": None, "parsed": good, "parsing_error": None},
        ]
    )

    assert client.structured("plan it", _Greeting) == good


def test_anthropic_client_raises_after_exhausting_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _anthropic_client(monkeypatch, max_parse_retries=1)
    client._chat = _FakeChat(  # type: ignore[attr-defined]
        [
            {"raw": None, "parsed": None, "parsing_error": ValueError("bad json 1")},
            {"raw": None, "parsed": None, "parsing_error": ValueError("bad json 2")},
        ]
    )

    with pytest.raises(ValueError, match="failed to produce a valid"):
        client.structured("plan it", _Greeting)
