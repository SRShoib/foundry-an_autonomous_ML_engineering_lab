"""Tests for foundry/prompting.py. Pure round-trip over a Pydantic model — no LLM involved."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from foundry.prompting import CONTEXT_MARKER, ContextParseError, read_context, with_context


class _Ctx(BaseModel):
    name: str
    count: int


def test_with_context_puts_instructions_before_the_marker() -> None:
    prompt = with_context("do the thing", _Ctx(name="a", count=3))
    assert prompt.startswith("do the thing")
    assert CONTEXT_MARKER in prompt


def test_read_context_recovers_the_same_model() -> None:
    ctx = _Ctx(name="b", count=7)
    prompt = with_context("some instructions", ctx)
    assert read_context(prompt, _Ctx) == ctx


def test_read_context_ignores_prose_before_the_marker() -> None:
    ctx = _Ctx(name="c", count=1)
    prompt = with_context("ignore this entirely: {not json}", ctx)
    assert read_context(prompt, _Ctx) == ctx


def test_read_context_raises_when_marker_missing() -> None:
    with pytest.raises(ContextParseError, match=CONTEXT_MARKER):
        read_context("no marker here", _Ctx)


def test_read_context_raises_on_malformed_json() -> None:
    prompt = f"stuff\n\n{CONTEXT_MARKER}\nnot json"
    with pytest.raises(ContextParseError):
        read_context(prompt, _Ctx)


def test_read_context_raises_on_schema_mismatch() -> None:
    class _Other(BaseModel):
        unrelated: float

    prompt = with_context("instructions", _Ctx(name="x", count=1))
    with pytest.raises(ContextParseError):
        read_context(prompt, _Other)
