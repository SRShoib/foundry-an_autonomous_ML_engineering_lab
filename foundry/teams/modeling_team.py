"""Experiment planner (SPEC: "experiment planner (N ExperimentSpecs)"). Flat — a single node,
not a subgraph — because Send fan-out (SPEC: "Send fan-out of experiment runners") is owned by
foundry/teams/principal.py, the graph's single routing authority (see its module docstring): once
this node appends a batch of pending specs and returns to principal, principal is the one that
decides how many of them to run in parallel and constructs the Send list. Turning modeling_team
into a real subgraph (mirroring foundry/teams/data_team.py) remains a reasonable future refactor
— e.g. once a literature scout joins it in a later milestone — but nothing about M4's fan-out
requires it.

Code owns the things that must never depend on the LLM getting it right: which model families
are actually installed in the sandbox image, how many specs one planning pass may add, and
experiment_id assignment (so ids are unique and stable regardless of what the LLM echoes back).
"""

from __future__ import annotations

from typing import Literal

from langgraph.types import Command
from pydantic import BaseModel, Field

from foundry import leaderboard
from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import ExperimentPlan, ExperimentSpec
from foundry.prompting import with_context
from foundry.state import FoundryState
from foundry.teams.experiment_runner import SUPPORTED_MODEL_FAMILIES

_FALLBACK_SPEC = ExperimentSpec(
    experiment_id="fallback",
    model_family="logistic_regression",
    hyperparams={},
    rationale="Fallback baseline: no valid LLM-proposed spec survived filtering.",
    est_cost_usd=0.01,
)


class PlanContext(BaseModel):
    goal: str
    task_type: str
    primary_metric: str
    n_rows: int
    n_cols: int
    prior_experiments: int
    prior_model_families: list[str]
    best_metric_so_far: float | None = None
    # M5: what the red team has invalidated so far, so a replacement spec is planned in light of
    # the invalidation (e.g. "don't repeat the family that just seed-hacked its way to 0.99")
    # rather than by accident. Empty on every dataset the red team hasn't flagged anything on.
    recent_invalidations: list[str] = Field(default_factory=list)


def experiment_planner(state: FoundryState) -> Command[Literal["principal"]]:
    data_profile = state["data_profile"]
    dataset = get_dataset(state["dataset_ref"])
    llm = get_llm("worker")

    done_ids = {result.experiment_id for result in state["experiments"]}
    prior_families = [
        spec.model_family for spec in state["experiment_plan"] if spec.experiment_id in done_ids
    ]

    invalidated = [f for f in state["invalidations"] if f.verdict == "invalidated"]
    invalidated_ids = frozenset(f.experiment_id for f in invalidated)
    best = leaderboard.best_result(state["experiments"], dataset.primary_metric, invalidated_ids)
    context = PlanContext(
        goal=state["goal"],
        task_type=data_profile.task_type if data_profile else dataset.task_type,
        primary_metric=dataset.primary_metric,
        n_rows=data_profile.n_rows if data_profile else 0,
        n_cols=data_profile.n_cols if data_profile else 0,
        prior_experiments=len(state["experiments"]),
        prior_model_families=prior_families,
        best_metric_so_far=best.metrics[dataset.primary_metric] if best else None,
        recent_invalidations=[f"{f.category}: {f.recommendation}" for f in invalidated],
    )
    plan = llm.structured(
        with_context(
            "Propose the next experiment to run: pick a model family not yet tried if "
            "possible, with reasonable hyperparameters.",
            context,
        ),
        ExperimentPlan,
    )

    errors: list[str] = []
    candidates = [spec for spec in plan.specs if spec.model_family in SUPPORTED_MODEL_FAMILIES]
    if len(candidates) < len(plan.specs):
        skipped = [
            spec.model_family
            for spec in plan.specs
            if spec.model_family not in SUPPORTED_MODEL_FAMILIES
        ]
        errors.append(f"experiment_planner: dropped unsupported model families: {skipped}")

    candidates = candidates[: settings.max_experiments_per_iteration] or [_FALLBACK_SPEC]

    n_prior = len(state["experiment_plan"])
    new_specs = [
        spec.model_copy(update={"experiment_id": f"exp-{n_prior + i + 1:03d}"})
        for i, spec in enumerate(candidates)
    ]

    update: dict[str, object] = {
        "experiment_plan": state["experiment_plan"] + new_specs,
        "costs": llm.costs,
    }
    if errors:
        update["errors"] = errors
    return Command(goto="principal", update=update)
