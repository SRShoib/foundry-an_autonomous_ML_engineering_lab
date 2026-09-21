"""SPEC's reporter: "experiment report + model card ... citing MLflow run IDs" — mlflow_run_id
stays None throughout M3 (the MLflow tool lands in M4), so citations are deferred, not faked.
Every number in the rendered report/card comes from ExperimentResult or LeaderboardEntry
(code-authored); the LLM-authored ReportNarrative supplies only prose (it has no numeric fields
at all — see foundry/models.py), so a report number can never be LLM-invented.

Returns a plain dict rather than a Command: reporter is the one team with a single, static
destination (END), wired with a plain add_edge in foundry/graph.py.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import BaseModel

from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import ExperimentResult, LeaderboardEntry, ReportNarrative
from foundry.prompting import with_context
from foundry.state import FoundryState


class ReportContext(BaseModel):
    goal: str
    dataset_name: str
    stop_reason: str | None = None
    iteration_count: int
    n_experiments: int
    n_successful: int
    primary_metric: str
    leaderboard: list[LeaderboardEntry]


def rank_experiments(
    experiments: Sequence[ExperimentResult], metric: str
) -> list[LeaderboardEntry]:
    scored = [
        (result, result.metrics[metric])
        for result in experiments
        if result.status == "success" and metric in result.metrics
    ]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return [
        LeaderboardEntry(
            experiment_id=result.experiment_id,
            mlflow_run_id=result.mlflow_run_id,
            primary_metric_name=metric,
            primary_metric_value=value,
            rank=i + 1,
        )
        for i, (result, value) in enumerate(scored)
    ]


def render_report(
    state: FoundryState, narrative: ReportNarrative, board: list[LeaderboardEntry]
) -> str:
    n_successful = sum(1 for r in state["experiments"] if r.status == "success")
    lines = [
        f"# Experiment Report — {state['goal']}",
        "",
        f"**Stop reason:** {state['stop_reason']}  ",
        f"**Iterations:** {state['iteration_count']}  ",
        f"**Experiments run:** {len(state['experiments'])} ({n_successful} successful)",
        "",
        "## Summary",
        narrative.summary,
        "",
        "## Leaderboard",
        "",
        "| rank | experiment | metric | value |",
        "|---|---|---|---|",
    ]
    for entry in board:
        lines.append(
            f"| {entry.rank} | {entry.experiment_id} | {entry.primary_metric_name} | "
            f"{entry.primary_metric_value:.4f} |"
        )
    if not board:
        lines.append("| — | no successful experiments | — | — |")
    lines += ["", "## Recommendation", narrative.recommendation]
    if state["errors"]:
        lines += ["", "## Errors encountered", *(f"- {error}" for error in state["errors"])]
    return "\n".join(lines)


def render_model_card(
    state: FoundryState, narrative: ReportNarrative, best: LeaderboardEntry | None
) -> str:
    lines = [f"# Model Card — {state['goal']}", ""]
    if best is None:
        lines.append("No successful experiment produced a model.")
    else:
        result = next(r for r in state["experiments"] if r.experiment_id == best.experiment_id)
        lines += [
            f"**Winning experiment:** {best.experiment_id}",
            f"**{best.primary_metric_name}:** {best.primary_metric_value:.4f}",
            f"**Self-debug attempts used:** {result.attempts}",
            "",
            "## Metrics",
            "",
            *(f"- **{name}**: {value:.4f}" for name, value in result.metrics.items()),
        ]
    cv_strategy = state["cv_strategy"]
    if cv_strategy is not None:
        lines += [
            "",
            "## Validation protocol",
            f"{cv_strategy.kind} (n_splits={cv_strategy.n_splits}). {cv_strategy.rationale}",
        ]
    lines += ["", "## Notes", narrative.recommendation]
    return "\n".join(lines)


def reporter(state: FoundryState) -> dict[str, object]:
    dataset = get_dataset(state["dataset_ref"])
    board = rank_experiments(state["experiments"], dataset.primary_metric)
    llm = get_llm("worker")

    context = ReportContext(
        goal=state["goal"],
        dataset_name=dataset.name,
        stop_reason=state["stop_reason"],
        iteration_count=state["iteration_count"],
        n_experiments=len(state["experiments"]),
        n_successful=sum(1 for r in state["experiments"] if r.status == "success"),
        primary_metric=dataset.primary_metric,
        leaderboard=board,
    )
    narrative = llm.structured(
        with_context("Summarize this experiment run and recommend next steps.", context),
        ReportNarrative,
    )

    best = board[0] if board else None
    return {
        "leaderboard": board,
        "report_md": render_report(state, narrative, board),
        "model_card_md": render_model_card(state, narrative, best),
    }
