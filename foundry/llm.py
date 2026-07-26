"""LLM interface (SPEC M2: "LLM interface with a deterministic stub — graph runs with NO api
keys"). get_llm(role) is the single switch: with no ANTHROPIC_API_KEY it returns the module's
StubClient singleton, so the graph is fully runnable offline; with a key it returns a real
ChatAnthropic-backed client. Every structured output goes through .structured(...), which
validates against a Pydantic schema and retries on parse failure (CLAUDE.md convention) —
never returns free-form text for a field the graph will branch on.

Sampling params (temperature/top_p/top_k) are deliberately never set: they are rejected with a
400 on Claude Opus 5 and Sonnet 5 (verified against current docs, not memory, per CLAUDE.md).
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Any, Literal, Protocol, TypeVar, cast

from langchain_anthropic import ChatAnthropic
from pydantic import BaseModel, SecretStr

from foundry.config import settings

AgentRole = Literal["principal", "red_team", "worker"]

T = TypeVar("T", bound=BaseModel)


def deterministic_seed(*parts: str) -> int:
    """Stable integer seed derived from the given strings — the building block canned-response
    factories use so StubClient output is a pure function of (prompt, schema), not of run order
    or wall-clock time."""
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return int(digest, 16)


class LLMClient(Protocol):
    def structured(self, prompt: str, schema: type[T], *, system: str | None = None) -> T: ...


def _model_for_role(role: AgentRole) -> str:
    return {
        "principal": settings.principal_model,
        "red_team": settings.red_team_model,
        "worker": settings.worker_model,
    }[role]


class AnthropicClient:
    """Real LLMClient backed by langchain_anthropic.ChatAnthropic."""

    def __init__(self, role: AgentRole) -> None:
        if not settings.anthropic_api_key:
            raise ValueError("AnthropicClient requires ANTHROPIC_API_KEY to be set")
        self._role = role
        self._chat = ChatAnthropic(
            model_name=_model_for_role(role),
            max_tokens_to_sample=settings.llm_max_tokens,
            api_key=SecretStr(settings.anthropic_api_key),
            timeout=None,
            stop=None,
        )

    def structured(self, prompt: str, schema: type[T], *, system: str | None = None) -> T:
        structured_llm = self._chat.with_structured_output(schema, include_raw=True)
        messages: list[tuple[str, str]] = []
        if system is not None:
            messages.append(("system", system))
        messages.append(("user", prompt))

        last_error: Exception | None = None
        attempts = settings.llm_max_parse_retries + 1
        for attempt in range(attempts):
            # include_raw=True always returns a dict at runtime; the Runnable's declared
            # return type is a union with BaseModel (the include_raw=False case) because
            # langchain-core doesn't overload on the include_raw literal.
            result = cast("dict[str, Any]", structured_llm.invoke(messages))
            parsed = result["parsed"]
            if parsed is not None:
                return cast(T, parsed)
            last_error = result["parsing_error"]
            if attempt < attempts - 1:
                messages.append(
                    (
                        "user",
                        f"Your previous response could not be parsed as {schema.__name__}: "
                        f"{last_error}. Reply again with output that matches the schema exactly.",
                    )
                )
        raise ValueError(
            f"AnthropicClient({self._role}) failed to produce a valid {schema.__name__} "
            f"after {attempts} attempt(s)"
        ) from last_error


class StubClient:
    """Deterministic LLMClient used whenever no API key is configured. Holds a registry of
    canned-response factories keyed by schema; each factory maps a prompt to a valid instance
    of that schema. There is no generic fallback — an unregistered schema raises immediately,
    so a node wired to a schema nobody has registered a response for fails loudly instead of
    silently returning a hollow default (e.g. an experiment plan with zero specs)."""

    def __init__(self) -> None:
        self._registry: dict[type[BaseModel], Callable[[str], BaseModel]] = {}

    def register(self, schema: type[T], factory: Callable[[str], T]) -> None:
        self._registry[schema] = factory

    def structured(self, prompt: str, schema: type[T], *, system: str | None = None) -> T:
        factory = self._registry.get(schema)
        if factory is None:
            raise KeyError(
                f"StubClient has no canned response registered for {schema.__name__}. "
                "Call StubClient.register(schema, factory) before using it in the graph."
            )
        result = factory(prompt)
        assert isinstance(result, schema)
        return result


_stub_client = StubClient()


def get_llm(role: AgentRole) -> LLMClient:
    # Falsy, not just `is None`: `cp .env.example .env` without filling in a key leaves
    # ANTHROPIC_API_KEY="" (present but empty), which must be treated as "unset" too.
    if not settings.anthropic_api_key:
        return _stub_client
    return AnthropicClient(role)
