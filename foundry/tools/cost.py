"""Real per-model $/token pricing (SPEC M4: "per-agent cost logging" — the model split from
CLAUDE.md, "Cheap model for workers/runners; strong model ONLY for principal + red team", only
means something in a cost report if the roles are actually priced differently). A code table,
not a Settings field — same rationale as foundry/datasets.py's REGISTRY: this is data about the
world (published API prices), not deployment configuration. An unpriced model raises rather than
silently falling back to a guessed rate, matching StubClient's no-silent-fallback convention.

foundry/llm.py is the only caller for the LLM half; foundry/teams/experiment_runner.py calls
sandbox_cost_usd directly for the sandbox-compute half. Neither call site estimates a token count
itself — real usage comes from AIMessage.usage_metadata (foundry/llm.py) or is simply absent for
the deterministic stub, which is priced at a flat per-call rate instead (SPEC's "crude,
deterministic cost model" persists for the no-API-key path; only the real OpenAI path gets
real token accounting)."""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import BaseModel

from foundry.config import settings
from foundry.models import CostEntry


class ModelPrice(BaseModel):
    input_per_mtok_usd: float
    output_per_mtok_usd: float


# Verified against developers.openai.com/api/docs/pricing at plan time (fetched live), not
# memory (CLAUDE.md) — pricing changes too often to trust a remembered figure.
MODEL_PRICING: dict[str, ModelPrice] = {
    "gpt-5.5": ModelPrice(input_per_mtok_usd=5.00, output_per_mtok_usd=30.00),
    "gpt-5": ModelPrice(input_per_mtok_usd=1.25, output_per_mtok_usd=10.00),
    "gpt-5-nano": ModelPrice(input_per_mtok_usd=0.05, output_per_mtok_usd=0.40),
}


def usd_for_tokens(model: str, *, input_tokens: int, output_tokens: int) -> float:
    try:
        price = MODEL_PRICING[model]
    except KeyError:
        valid = ", ".join(sorted(MODEL_PRICING))
        raise KeyError(
            f"no pricing registered for model {model!r}; priced models: {valid}"
        ) from None
    return round(
        input_tokens * price.input_per_mtok_usd / 1_000_000
        + output_tokens * price.output_per_mtok_usd / 1_000_000,
        8,
    )


def sandbox_cost_usd(duration_s: float) -> float:
    return round((duration_s / 60.0) * settings.cost_per_sandbox_minute_usd, 8)


def total_usd(entries: Sequence[CostEntry]) -> float:
    """Sums a batch of CostEntry.usd. Shared by foundry/teams/principal.py (deriving
    spent_usd from state["costs"] every turn — SPEC M4) and foundry/teams/reporter.py (which
    must fold in its own not-yet-merged llm.costs, since it runs strictly after principal's
    last turn and nothing re-checks the budget after it)."""
    return round(sum(entry.usd for entry in entries), 8)


def project_run_usd(est_cost_usd: float, completed_costs: Sequence[float]) -> float:
    """The budget gate's (foundry/teams/principal.py, M6) projection for one pending
    ExperimentSpec: max(code floor, the LLM's own est_cost_usd). The floor is the mean cost of
    experiments actually completed so far, or settings.est_cost_usd_per_experiment before any
    have — an LLM-authored estimate is allowed to raise how much oversight a human gets, never to
    talk it down, the same asymmetry foundry/teams/red_team.py's `_apply_floor` applies to
    verdicts and PrincipalDirective.stop_reason's Literal applies to stop conditions."""
    floor = (
        sum(completed_costs) / len(completed_costs)
        if completed_costs
        else settings.est_cost_usd_per_experiment
    )
    return round(max(floor, est_cost_usd), 8)
