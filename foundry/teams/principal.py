"""The principal supervisor (SPEC: "Decomposes goal, allocates budget, routes handoffs via
Command, loops teams, stops on: target metric hit, budget exhausted, or diminishing returns").

Code owns every hard guard; the LLM is consulted only for the one genuine judgment call this
milestone has — whether continuing looks worthwhile — and PrincipalDirective.stop_reason's
Literal deliberately excludes "budget_exhausted"/"max_iterations": those are measured before the
LLM is ever called, so a model can never talk its way past a cap. Every team returns to
`principal` (see foundry/graph.py), so this is the single routing authority and iteration_count
has exactly one owner.

M4 adds two more things principal owns during the loop, for the same "single authority" reason:
- spent_usd is DERIVED from state["costs"] every turn rather than incrementally written by
  experiment_runner — M4's Send fan-out runs several runner branches on separate threads
  (foundry/teams/experiment_runner.py), and concurrent writes to state["spent_usd"] (a plain,
  non-reducer channel) would race and silently lose cost. costs itself is safe under
  concurrency (an add-reducer, foundry/state.py); spent_usd just sums it in the one place that
  isn't running in parallel. foundry/teams/reporter.py tops it up exactly once more after the
  loop ends, folding in its own not-yet-merged LLM cost — safe because reporter always runs
  alone, never concurrently with anything else.
- leaderboard is recomputed every turn (not just at the final stop) so M5's red team can audit
  "every leaderboard candidate" as experiments complete, not only the final set (SPEC).

Send fan-out (SPEC: "experiment planner (N ExperimentSpecs) → Send fan-out of experiment
runners"): once experiment_planner has appended a batch of pending specs, principal fans out ALL
of them in one Command(goto=[Send(...), ...]) rather than routing to a single experiment_runner
— verified against the installed LangGraph 1.2.9 source that this collapses back into exactly
one principal execution once every branch's update has merged, so iteration_count still has
exactly one writer per round-trip."""

from __future__ import annotations

from typing import Literal

from langgraph.types import Command, Send
from pydantic import BaseModel

from foundry import leaderboard
from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import CostEntry, ExperimentSpec, LeaderboardEntry, PrincipalDirective
from foundry.prompting import with_context
from foundry.state import FoundryState, StopReason
from foundry.teams.experiment_runner import RunnerInput
from foundry.tools.cost import total_usd


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


def _spent_usd(state: FoundryState) -> float:
    return total_usd(state["costs"])


def _pending_specs(state: FoundryState) -> list[ExperimentSpec]:
    done_ids = {result.experiment_id for result in state["experiments"]}
    return [spec for spec in state["experiment_plan"] if spec.experiment_id not in done_ids]


def _fanout(state: FoundryState, pending: list[ExperimentSpec]) -> list[Send]:
    return [
        Send(
            "experiment_runner",
            RunnerInput(
                spec=spec,
                dataset_ref=state["dataset_ref"],
                cleaning_plan=state["cleaning_plan"],
                cv_strategy=state["cv_strategy"],
                prior_experiments=len(state["experiments"]),
                batch_index=index,
            ),
        )
        for index, spec in enumerate(pending)
    ]


def _stop(
    iteration: int,
    reason: StopReason,
    *,
    spent_usd: float,
    leaderboard_entries: list[LeaderboardEntry],
    costs: list[CostEntry] | None = None,
) -> Command[Literal["data_team", "experiment_planner", "experiment_runner", "reporter"]]:
    update: dict[str, object] = {
        "iteration_count": iteration,
        "stop_reason": reason,
        "next_team": "reporter",
        "spent_usd": spent_usd,
        "leaderboard": leaderboard_entries,
    }
    if costs:
        update["costs"] = costs
    return Command(goto="reporter", update=update)


def principal(
    state: FoundryState,
) -> Command[Literal["data_team", "experiment_planner", "experiment_runner", "reporter"]]:
    iteration = state["iteration_count"] + 1
    dataset = get_dataset(state["dataset_ref"])
    successful = [result for result in state["experiments"] if result.status == "success"]
    spent_usd = _spent_usd(state)
    board = leaderboard.rank_experiments(state["experiments"], dataset.primary_metric)
    best = leaderboard.best_result(successful, dataset.primary_metric)
    best_value = best.metrics[dataset.primary_metric] if best else None

    if iteration > settings.principal_max_iterations:
        return _stop(iteration, "max_iterations", spent_usd=spent_usd, leaderboard_entries=board)
    if spent_usd >= state["budget_usd"]:
        return _stop(
            iteration, "budget_exhausted", spent_usd=spent_usd, leaderboard_entries=board
        )
    if best_value is not None and leaderboard.target_met(
        best_value, dataset.target_value, dataset.primary_metric
    ):
        return _stop(iteration, "target_met", spent_usd=spent_usd, leaderboard_entries=board)
    if len(successful) >= settings.max_experiments_total:
        return _stop(
            iteration, "diminishing_returns", spent_usd=spent_usd, leaderboard_entries=board
        )

    if state["data_profile"] is None:
        return Command(
            goto="data_team",
            update={
                "iteration_count": iteration,
                "next_team": "data_team",
                "spent_usd": spent_usd,
                "leaderboard": board,
            },
        )

    llm = get_llm("principal")
    context = SupervisorContext(
        goal=state["goal"],
        budget_usd=state["budget_usd"],
        spent_usd=spent_usd,
        iteration=iteration,
        max_iterations=settings.principal_max_iterations,
        n_experiments_total=len(state["experiments"]),
        n_experiments_successful=len(successful),
        best_metric_so_far=best_value,
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
        return _stop(
            iteration,
            directive.stop_reason or "diminishing_returns",
            spent_usd=spent_usd,
            leaderboard_entries=board,
            costs=llm.costs,
        )

    pending = _pending_specs(state)
    next_goto: list[Send] | Literal["experiment_planner"] = (
        _fanout(state, pending) if pending else "experiment_planner"
    )
    return Command(
        goto=next_goto,
        update={
            "iteration_count": iteration,
            "next_team": "modeling_team",
            "spent_usd": spent_usd,
            "leaderboard": board,
            "costs": llm.costs,
        },
    )
