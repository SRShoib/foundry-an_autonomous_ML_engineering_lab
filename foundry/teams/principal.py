"""The principal supervisor (SPEC: "Decomposes goal, allocates budget, routes handoffs via
Command, loops teams, stops on: target metric hit, budget exhausted, or diminishing returns").

Code owns every hard guard; the LLM is consulted only for the one genuine judgment call this
milestone has — whether continuing looks worthwhile — and PrincipalDirective.stop_reason's
Literal deliberately excludes "budget_exhausted"/"max_iterations": those are measured before the
LLM is ever called, so a model can never talk its way past a cap. Every team returns to
`principal` (see foundry/graph.py), so this is the single routing authority and iteration_count
has exactly one owner.
"""

from __future__ import annotations

from typing import Literal

from langgraph.types import Command
from pydantic import BaseModel

from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import ExperimentResult, PrincipalDirective
from foundry.prompting import with_context
from foundry.state import FoundryState, StopReason


class SupervisorContext(BaseModel):
    goal: str
    budget_usd: float
    spent_usd: float
    iteration: int
    max_iterations: int
    n_experiments_total: int
    n_experiments_successful: int
    best_metric_so_far: float | None = None
    primary_metric: str
    target_value: float


def _best_metric(results: list[ExperimentResult], metric_name: str) -> float | None:
    values = [
        result.metrics[metric_name]
        for result in results
        if result.status == "success" and metric_name in result.metrics
    ]
    return max(values) if values else None


def _has_pending_spec(state: FoundryState) -> bool:
    done_ids = {result.experiment_id for result in state["experiments"]}
    return any(spec.experiment_id not in done_ids for spec in state["experiment_plan"])


def _stop(
    iteration: int, reason: StopReason
) -> Command[Literal["data_team", "experiment_planner", "experiment_runner", "reporter"]]:
    return Command(
        goto="reporter",
        update={"iteration_count": iteration, "stop_reason": reason, "next_team": "reporter"},
    )


def principal(
    state: FoundryState,
) -> Command[Literal["data_team", "experiment_planner", "experiment_runner", "reporter"]]:
    iteration = state["iteration_count"] + 1
    dataset = get_dataset(state["dataset_ref"])
    successful = [result for result in state["experiments"] if result.status == "success"]
    best_metric = _best_metric(successful, dataset.primary_metric)

    if iteration > settings.principal_max_iterations:
        return _stop(iteration, "max_iterations")
    if state["spent_usd"] >= state["budget_usd"]:
        return _stop(iteration, "budget_exhausted")
    if best_metric is not None and best_metric >= dataset.target_value:
        return _stop(iteration, "target_met")
    if len(successful) >= settings.max_experiments_total:
        return _stop(iteration, "diminishing_returns")

    if state["data_profile"] is None:
        return Command(
            goto="data_team", update={"iteration_count": iteration, "next_team": "data_team"}
        )

    llm = get_llm("principal")
    context = SupervisorContext(
        goal=state["goal"],
        budget_usd=state["budget_usd"],
        spent_usd=state["spent_usd"],
        iteration=iteration,
        max_iterations=settings.principal_max_iterations,
        n_experiments_total=len(state["experiments"]),
        n_experiments_successful=len(successful),
        best_metric_so_far=best_metric,
        primary_metric=dataset.primary_metric,
        target_value=dataset.target_value,
    )
    directive = llm.structured(
        with_context(
            "Decide whether to keep running experiments or stop, given progress so far.",
            context,
        ),
        PrincipalDirective,
    )
    if not directive.should_continue:
        return _stop(iteration, directive.stop_reason or "diminishing_returns")

    next_node: Literal["experiment_runner", "experiment_planner"] = (
        "experiment_runner" if _has_pending_spec(state) else "experiment_planner"
    )
    return Command(
        goto=next_node,
        update={"iteration_count": iteration, "next_team": "modeling_team"},
    )
