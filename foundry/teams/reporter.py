"""SPEC's reporter: "experiment report + model card ... citing MLflow run IDs". mlflow_run_id is
real as of M4 (foundry/tools/tracker.py, wired in via foundry/teams/experiment_runner.py) — the
report's leaderboard table cites it directly. Every number in the rendered report/card comes
from ExperimentResult, LeaderboardEntry, or CostEntry (all code-authored); the LLM-authored
ReportNarrative supplies only prose (it has no numeric fields at all — see foundry/models.py), so
a report number can never be LLM-invented.

The leaderboard itself is read from state, not recomputed: foundry/teams/principal.py is the
single place that ranks experiments (SPEC M4 — "leaderboard" is live state maintained every
principal turn, not a reporter-only computation), and reporter is always reached through
principal's terminal `_stop()` call, so state["leaderboard"] is guaranteed fresh by the time this
runs (see foundry/leaderboard.py for the ranking logic itself).

spent_usd gets one final top-up here: reporter's own LLM call happens strictly after principal's
last turn, so its cost is not yet folded into state["spent_usd"] when this runs, and nothing
downstream will ever recompute it again. render_report takes the topped-up total as an explicit
`spent_usd` parameter rather than reading state["spent_usd"] directly, so the rendered number is
never the stale, pre-reporter-cost figure.

Returns a plain dict rather than a Command: reporter is the one team with a single, static
destination (END), wired with a plain add_edge in foundry/graph.py.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import BaseModel

from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import CostEntry, LeaderboardEntry, ReportNarrative
from foundry.prompting import with_context
from foundry.state import FoundryState
from foundry.tools.cost import total_usd


class ReportContext(BaseModel):
    goal: str
    dataset_name: str
    stop_reason: str | None = None
    iteration_count: int
    n_experiments: int
    n_successful: int
    primary_metric: str
    leaderboard: list[LeaderboardEntry]


def cost_by_agent(costs: Sequence[CostEntry]) -> dict[str, float]:
    totals: dict[str, float] = {}
    for entry in costs:
        totals[entry.agent_role] = totals.get(entry.agent_role, 0.0) + entry.usd
    return {agent: round(usd, 6) for agent, usd in totals.items()}


def render_report(
    state: FoundryState,
    narrative: ReportNarrative,
    board: list[LeaderboardEntry],
    *,
    spent_usd: float,
) -> str:
    # spent_usd is a caller-supplied parameter, not state["spent_usd"]: reporter runs strictly
    # after principal's last turn, so its own LLM call's cost hasn't been folded into
    # state["spent_usd"] yet — the caller (foundry/teams/reporter.py::reporter) computes the
    # true final total including that last call before rendering.
    n_successful = sum(1 for r in state["experiments"] if r.status == "success")
    lines = [
        f"# Experiment Report — {state['goal']}",
        "",
        f"**Stop reason:** {state['stop_reason']}  ",
        f"**Iterations:** {state['iteration_count']}  ",
        f"**Experiments run:** {len(state['experiments'])} ({n_successful} successful)  ",
        f"**Total cost:** ${spent_usd:.4f}",
        "",
        "## Summary",
        narrative.summary,
        "",
        "## Leaderboard",
        "",
        "| rank | experiment | metric | value | mlflow run |",
        "|---|---|---|---|---|",
    ]
    for entry in board:
        lines.append(
            f"| {entry.rank} | {entry.experiment_id} | {entry.primary_metric_name} | "
            f"{entry.primary_metric_value:.4f} | {entry.mlflow_run_id or '—'} |"
        )
    if not board:
        lines.append("| — | no successful experiments | — | — | — |")

    lines += ["", "## Cost by agent", "", "| agent | usd |", "|---|---|"]
    totals = cost_by_agent(state["costs"])
    if totals:
        lines.extend(f"| {agent} | {usd:.4f} |" for agent, usd in sorted(totals.items()))
    else:
        lines.append("| — | — |")

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
            f"**MLflow run:** {best.mlflow_run_id or '—'}",
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
    board = state["leaderboard"]
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

    # Folds in this call's own cost: reporter runs strictly after principal's last turn, so
    # nothing else will ever recompute spent_usd from state["costs"] + this update again.
    spent_usd = total_usd([*state["costs"], *llm.costs])

    best = board[0] if board else None
    return {
        "report_md": render_report(state, narrative, board, spent_usd=spent_usd),
        "model_card_md": render_model_card(state, narrative, best),
        "spent_usd": spent_usd,
        "costs": llm.costs,
    }
