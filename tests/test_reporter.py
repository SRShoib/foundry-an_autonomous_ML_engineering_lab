"""Tests for foundry/teams/reporter.py. Every number in the rendered report/card comes from
ExperimentResult/LeaderboardEntry (code-authored) — render_report/render_model_card are tested
directly against a fixed ReportNarrative, with no LLM involved except in the one node-level test."""

from __future__ import annotations

from typing import Any, Literal, cast

import pytest

from foundry.models import CVStrategy, ExperimentResult, ReportNarrative
from foundry.state import FoundryState
from foundry.teams import reporter as reporter_module
from foundry.teams.reporter import rank_experiments, render_model_card, render_report


def _state(**overrides: Any) -> FoundryState:
    state: FoundryState = {
        "goal": "predict churn",
        "dataset_ref": "churn",
        "budget_usd": 20.0,
        "spent_usd": 0.5,
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": None,
        "cv_strategy": CVStrategy(
            kind="stratified_kfold", n_splits=5, rationale="balanced classes"
        ),
        "experiment_plan": [],
        "experiments": [],
        "leaderboard": [],
        "invalidations": [],
        "lessons": [],
        "report_md": None,
        "model_card_md": None,
        "human_decisions": [],
        "errors": [],
        "iteration_count": 6,
        "next_team": None,
        "stop_reason": "diminishing_returns",
    }
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


def _result(
    experiment_id: str,
    roc_auc: float,
    status: Literal["success", "failed", "invalidated"] = "success",
) -> ExperimentResult:
    return ExperimentResult(
        experiment_id=experiment_id,
        status=status,
        metrics={"roc_auc": roc_auc} if status == "success" else {},
        cost_usd=0.1,
        duration_s=1.0,
        attempts=1,
        error=None if status == "success" else "boom",
    )


def test_rank_experiments_orders_by_metric_and_skips_failures() -> None:
    results = [
        _result("exp-001", 0.80),
        _result("exp-002", 0.90),
        _result("exp-003", 0.5, status="failed"),
    ]
    board = rank_experiments(results, "roc_auc")
    assert [entry.experiment_id for entry in board] == ["exp-002", "exp-001"]
    assert board[0].rank == 1
    assert board[1].rank == 2


def test_render_report_contains_every_experiment_and_its_code_computed_metric() -> None:
    results = [_result("exp-001", 0.8520), _result("exp-002", 0.8251)]
    board = rank_experiments(results, "roc_auc")
    narrative = ReportNarrative(summary="a run happened", recommendation="promote exp-001")
    state = _state(experiments=results)

    report = render_report(state, narrative, board)
    assert "exp-001" in report
    assert "exp-002" in report
    assert "0.8520" in report
    assert "0.8251" in report
    assert "diminishing_returns" in report


def test_render_report_lists_errors_when_present() -> None:
    narrative = ReportNarrative(summary="s", recommendation="r")
    state = _state(errors=["profiler: sandbox profiling failed: boom"])
    report = render_report(state, narrative, [])
    assert "sandbox profiling failed" in report


def test_render_model_card_names_the_winning_family_and_cv_protocol() -> None:
    results = [_result("exp-001", 0.8520)]
    board = rank_experiments(results, "roc_auc")
    narrative = ReportNarrative(summary="s", recommendation="promote it")
    state = _state(experiments=results)

    card = render_model_card(state, narrative, board[0])
    assert "exp-001" in card
    assert "0.8520" in card
    assert "stratified_kfold" in card
    assert "balanced classes" in card


def test_render_model_card_handles_no_successful_experiment() -> None:
    narrative = ReportNarrative(summary="s", recommendation="investigate")
    card = render_model_card(_state(), narrative, None)
    assert "No successful experiment" in card


def test_reporter_node_returns_report_and_model_card_and_leaderboard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FixedLLM:
        def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
            return ReportNarrative(summary="ran things", recommendation="ship exp-001")

    monkeypatch.setattr(reporter_module, "get_llm", lambda role: _FixedLLM())
    results = [_result("exp-001", 0.85)]
    update = reporter_module.reporter(_state(experiments=results))
    assert update["report_md"]
    assert update["model_card_md"]
    assert len(cast(list[Any], update["leaderboard"])) == 1
