"""Tests for foundry/teams/lessons.py. Every numeric/categorical field on the persisted Lesson
must come from state (leaderboard, invalidations, leakage_findings, human_decisions) — the fake
LLM below returns a fixed LessonDraft (prose only, no numeric fields, matching foundry/models.py's
LessonDraft docstring) so these tests can prove the structured facts never pass through it."""

from __future__ import annotations

from typing import Any

import pytest

from foundry.leaderboard import rank_experiments
from foundry.models import (
    CostEntry,
    ExperimentResult,
    ExperimentSpec,
    HumanDecision,
    LeakageFinding,
    LessonDraft,
    RedTeamFinding,
)
from foundry.state import FoundryState
from foundry.teams import lessons as lessons_module


class _FixedLLM:
    def __init__(self, draft: LessonDraft) -> None:
        self._draft = draft
        self.costs: list[CostEntry] = [
            CostEntry(agent_role="worker", model="m", kind="llm", usd=0.01)
        ]

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        return self._draft


def _state(**overrides: Any) -> FoundryState:
    state: FoundryState = {
        "goal": "predict churn",
        "dataset_ref": "churn",
        "budget_usd": 20.0,
        "spent_usd": 0.5,
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": None,
        "cv_strategy": None,
        "approach_memo": None,
        "experiment_plan": [],
        "experiments": [],
        "leaderboard": [],
        "invalidations": [],
        "audited_experiments": [],
        "costs": [],
        "lessons": [],
        "report_md": "# Experiment Report",
        "model_card_md": None,
        "human_decisions": [],
        "errors": [],
        "iteration_count": 3,
        "next_team": None,
        "stop_reason": "target_met",
    }
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


def _result(experiment_id: str, roc_auc: float) -> ExperimentResult:
    return ExperimentResult(
        experiment_id=experiment_id, status="success", metrics={"roc_auc": roc_auc},
        cost_usd=0.1, duration_s=1.0,
    )


def test_lesson_writer_derives_best_family_and_metric_from_state_not_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    draft = LessonDraft(text="gradient_boosting was the strongest candidate")
    monkeypatch.setattr(lessons_module, "get_llm", lambda role: _FixedLLM(draft))
    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        lessons_module.memory, "write", lambda lesson: captured.setdefault("lesson", lesson)
    )

    spec_result = _result("exp-001", 0.93)
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="gradient_boosting", hyperparams={}, rationale="r",
        est_cost_usd=0.01,
    )
    board = rank_experiments([spec_result], "roc_auc")
    state = _state(
        experiments=[spec_result],
        experiment_plan=[spec],
        leaderboard=board,
        human_decisions=[HumanDecision(gate="final", approved=True, note="lgtm")],
    )

    update = lessons_module.lesson_writer(state)

    lesson = captured["lesson"]
    assert lesson.best_model_family == "gradient_boosting"
    assert lesson.best_metric_name == "roc_auc"
    assert lesson.best_metric_value == pytest.approx(0.93)
    assert lesson.signed_off is True
    assert lesson.text == draft.text
    assert update["lessons"] == [draft.text]


def test_lesson_writer_records_invalidated_categories_and_leak_columns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    draft = LessonDraft(text="watch for leakage next time")
    monkeypatch.setattr(lessons_module, "get_llm", lambda role: _FixedLLM(draft))
    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        lessons_module.memory, "write", lambda lesson: captured.setdefault("lesson", lesson)
    )

    finding = RedTeamFinding(
        experiment_id="exp-001", category="leakage", verdict="invalidated",
        explanation="e", recommendation="r",
    )
    leak = LeakageFinding(column="retention_call_outcome", reason="red team", severity="high")
    state = _state(
        invalidations=[finding],
        leakage_findings=[leak],
        human_decisions=[HumanDecision(gate="final", approved=False, note="not yet")],
    )

    lessons_module.lesson_writer(state)

    lesson = captured["lesson"]
    assert lesson.invalidated_categories == ["leakage"]
    assert lesson.leak_columns == ["retention_call_outcome"]
    assert lesson.signed_off is False
    assert lesson.best_model_family is None  # no successful, cleared experiment


def test_lesson_writer_appends_lessons_learned_section_to_the_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    draft = LessonDraft(text="try gradient_boosting first next time")
    monkeypatch.setattr(lessons_module, "get_llm", lambda role: _FixedLLM(draft))
    monkeypatch.setattr(lessons_module.memory, "write", lambda lesson: None)

    state = _state(report_md="# Experiment Report\n\n## Sign-off\n\n**APPROVED**")
    update = lessons_module.lesson_writer(state)

    report_md = update["report_md"]
    assert "## Lessons learned" in report_md
    assert draft.text in report_md
    assert report_md.index("## Sign-off") < report_md.index("## Lessons learned")


def test_lesson_writer_writes_to_memory_regardless_of_sign_off_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SPEC's 'written at run end' has no 'only if approved' clause — a declined run still
    teaches what the red team caught or which family underperformed."""
    draft = LessonDraft(text="declined, but still informative")
    monkeypatch.setattr(lessons_module, "get_llm", lambda role: _FixedLLM(draft))
    write_calls: list[Any] = []
    monkeypatch.setattr(lessons_module.memory, "write", lambda lesson: write_calls.append(lesson))

    state = _state(human_decisions=[HumanDecision(gate="final", approved=False)])
    lessons_module.lesson_writer(state)

    assert len(write_calls) == 1
    assert write_calls[0].signed_off is False


def test_lesson_writer_tops_up_spent_usd_with_its_own_llm_cost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """lesson_writer runs strictly after foundry/teams/reporter.py's own top-up, which has no way
    to know about a cost this node hasn't incurred yet — this node must fold its own call's cost
    on top of state["costs"] (which by now already includes reporter's entry) one more time, or
    spent_usd is permanently short by whatever this call cost."""
    draft = LessonDraft(text="s")
    monkeypatch.setattr(lessons_module, "get_llm", lambda role: _FixedLLM(draft))
    monkeypatch.setattr(lessons_module.memory, "write", lambda lesson: None)

    state = _state(costs=[CostEntry(agent_role="worker", model="m", kind="llm", usd=0.10)])
    update = lessons_module.lesson_writer(state)

    assert update["spent_usd"] == pytest.approx(0.11)
