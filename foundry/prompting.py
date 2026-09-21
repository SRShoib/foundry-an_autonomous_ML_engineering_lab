"""Typed prompt context — the input-side mirror of llm.structured(). That function guarantees
a valid instance of T comes OUT of an LLM call; with_context/read_context guarantee a valid
instance of a context model can be read back out of what went IN.

Every LLM-authored node builds its prompt with with_context(instructions, context) instead of
interpolating fields into prose. A real model benefits from a clean structured block same as
good prompting always does; StubClient's canned-response factories need a reliable way to
recover the exact typed inputs a prompt was built from without parsing natural language — the
factories only ever receive the rendered prompt string (see foundry/llm.py's LLMClient
Protocol), so this is the only route back to structured data.
"""

from __future__ import annotations

from typing import TypeVar

from pydantic import BaseModel

CONTEXT_MARKER = "<<<FOUNDRY-CONTEXT>>>"

T = TypeVar("T", bound=BaseModel)


class ContextParseError(ValueError):
    pass


def with_context(instructions: str, context: BaseModel) -> str:
    return f"{instructions}\n\n{CONTEXT_MARKER}\n{context.model_dump_json()}"


def read_context(prompt: str, schema: type[T]) -> T:
    if CONTEXT_MARKER not in prompt:
        raise ContextParseError(f"prompt has no {CONTEXT_MARKER} block: {prompt!r}")
    _, _, payload = prompt.partition(CONTEXT_MARKER)
    try:
        return schema.model_validate_json(payload.strip())
    except Exception as exc:
        raise ContextParseError(
            f"context block did not match {schema.__name__}: {exc}"
        ) from exc
