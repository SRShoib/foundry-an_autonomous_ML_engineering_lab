"""Tests for foundry/tools/cost.py — pure pricing math, no LLM or sandbox involved."""

from __future__ import annotations

import pytest

from foundry.config import settings
from foundry.tools.cost import sandbox_cost_usd, usd_for_tokens


def test_usd_for_tokens_uses_registered_price() -> None:
    cost = usd_for_tokens("claude-haiku-4-5", input_tokens=1_000_000, output_tokens=0)
    assert cost == pytest.approx(1.00)

    cost = usd_for_tokens("claude-opus-5", input_tokens=0, output_tokens=1_000_000)
    assert cost == pytest.approx(25.00)


def test_usd_for_tokens_combines_input_and_output() -> None:
    cost = usd_for_tokens("claude-sonnet-5", input_tokens=1_000_000, output_tokens=1_000_000)
    assert cost == pytest.approx(3.00 + 15.00)


def test_usd_for_tokens_unpriced_model_raises() -> None:
    with pytest.raises(KeyError, match="no pricing registered"):
        usd_for_tokens("claude-nonexistent", input_tokens=1, output_tokens=1)


def test_sandbox_cost_usd_scales_with_duration() -> None:
    one_minute = sandbox_cost_usd(60.0)
    assert one_minute == pytest.approx(settings.cost_per_sandbox_minute_usd)
    assert sandbox_cost_usd(120.0) == pytest.approx(one_minute * 2)
    assert sandbox_cost_usd(0.0) == 0.0
