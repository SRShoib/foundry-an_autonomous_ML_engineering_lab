"""lesson_writer (SPEC M7: "Store-backed lessons written at run end"). A standalone node between
final_gate and END (foundry/graph.py) — not folded into foundry/teams/reporter.py — for the same
replay-safety reason foundry/gates.py's final_gate is its own node rather than code inside
reporter: LangGraph 1.2.9 re-executes a node's entire body from the top when it resumes past an
interrupt() (foundry/gates.py's module docstring), so a node placed strictly AFTER the final gate
runs exactly once, its LLM call never re-billed across a pause/resume round trip — and, unlike
placing this logic inside reporter, the recorded Lesson.signed_off reflects the human's actual
decision rather than being written before it exists.

Lessons are written regardless of the sign-off outcome (SPEC's "written at run end" has no
"only if approved" clause, and a declined run still teaches what the red team caught or what
model family underperformed) — but Lesson.signed_off=False keeps that run's winner out of a later
run's foundry/teams/modeling_team.py::_best_past_family recommendation. Every numeric/categorical
fact on the persisted Lesson is code-derived from state (leaderboard, invalidations,
leakage_findings, human_decisions) — LessonDraft, the LLM's only output, carries prose alone (see
foundry/models.py's Lesson/LessonDraft docstrings), the same split every other LLM-authored type
in this codebase already follows.

A second, final spent_usd top-up: foundry/teams/reporter.py already folds its own not-yet-merged
LLM cost into spent_usd once, on the (until M7) correct assumption that nothing billed runs after
it. This node's own get_llm("worker") call now does, strictly after that top-up — so lesson_writer
repeats the same total_usd([*state["costs"], *llm.costs]) computation one more time, on top of
state["costs"] which by now already includes reporter's own entry (its `costs` update having
already merged via the add-reducer). Skipping this would leave spent_usd permanently short by
whatever this node's own call cost, the same lost-update shape reporter's own docstring already
warns about."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import Lesson, LessonDraft, RedTeamCategory
from foundry.prompting import with_context
from foundry.state import FoundryState
from foundry.tools import memory
from foundry.tools.cost import total_usd


class LessonContext(BaseModel):
    goal: str
    task_type: str
    stop_reason: str | None
    n_experiments: int
    n_successful: int
    n_invalidated: int
    primary_metric: str
    best_metric_value: float | None = None
    signed_off: bool


def _leak_columns(state: FoundryState) -> list[str]:
    return sorted({f.column for f in state["leakage_findings"] if f.severity == "high"})


def _invalidated_categories(state: FoundryState) -> list[RedTeamCategory]:
    seen: list[RedTeamCategory] = []
    for finding in state["invalidations"]:
        if finding.verdict == "invalidated" and finding.category not in seen:
            seen.append(finding.category)
    return seen


def _final_decision(state: FoundryState) -> bool | None:
    return next(
        (
            decision.approved
            for decision in reversed(state["human_decisions"])
            if decision.gate == "final"
        ),
        None,
    )


def lesson_writer(state: FoundryState) -> dict[str, Any]:
    dataset = get_dataset(state["dataset_ref"])
    board = state["leaderboard"]
    best = board[0] if board else None
    best_spec = (
        next((s for s in state["experiment_plan"] if s.experiment_id == best.experiment_id), None)
        if best is not None
        else None
    )
    signed_off = _final_decision(state)

    llm = get_llm("worker")
    context = LessonContext(
        goal=state["goal"],
        task_type=dataset.task_type,
        stop_reason=state["stop_reason"],
        n_experiments=len(state["experiments"]),
        n_successful=sum(1 for r in state["experiments"] if r.status == "success"),
        n_invalidated=sum(1 for f in state["invalidations"] if f.verdict == "invalidated"),
        primary_metric=dataset.primary_metric,
        best_metric_value=best.primary_metric_value if best else None,
        signed_off=bool(signed_off),
    )
    draft = llm.structured(
        with_context(
            "Distill one short, actionable lesson from this completed run for whoever plans "
            "the next run on the same dataset — what worked, what to avoid, and why.",
            context,
        ),
        LessonDraft,
    )

    lesson = Lesson(
        dataset_ref=state["dataset_ref"],
        task_type=dataset.task_type,
        text=draft.text,
        best_model_family=best_spec.model_family if best_spec else None,
        best_metric_name=best.primary_metric_name if best else None,
        best_metric_value=best.primary_metric_value if best else None,
        invalidated_categories=_invalidated_categories(state),
        leak_columns=_leak_columns(state),
        stop_reason=state["stop_reason"],
        signed_off=signed_off,
    )
    memory.write(lesson)

    report_md = state["report_md"] or ""
    return {
        "lessons": [lesson.text],
        "report_md": f"{report_md}\n\n## Lessons learned\n\n{lesson.text}",
        "costs": llm.costs,
        "spent_usd": total_usd([*state["costs"], *llm.costs]),
    }
