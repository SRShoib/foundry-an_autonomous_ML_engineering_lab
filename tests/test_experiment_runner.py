"""Tests for foundry/teams/experiment_runner.py — the self-debug loop. sandbox.run is
monkeypatched to a fake, scripted sequence of results for the fast tests; a real offline run
against churn.csv is proven under @pytest.mark.docker, exercising the loop for real."""

from __future__ import annotations

from typing import Any

import pytest
from langgraph.types import Command

from foundry.config import settings
from foundry.models import (
    CleaningPlan,
    CVStrategy,
    ExperimentResult,
    ExperimentSpec,
    SandboxResult,
    TrainingCode,
)
from foundry.prompting import read_context
from foundry.state import FoundryState
from foundry.teams import experiment_runner as runner_module
from foundry.teams.experiment_runner import CodeRequest, build_code_prompt


def _update(command: Command[Any]) -> dict[str, Any]:
    assert isinstance(command.update, dict)
    return command.update


def _spec(experiment_id: str = "exp-001") -> ExperimentSpec:
    return ExperimentSpec(
        experiment_id=experiment_id, model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=0.01,
    )


def _state(**overrides: Any) -> FoundryState:
    state: FoundryState = {
        "goal": "predict churn",
        "dataset_ref": "churn",
        "budget_usd": 20.0,
        "spent_usd": 0.0,
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": CleaningPlan(
            drop_columns=["customer_id"], numeric_impute="median",
            categorical_impute="most_frequent", rationale="r",
        ),
        "cv_strategy": CVStrategy(kind="stratified_kfold", n_splits=5, rationale="r"),
        "experiment_plan": [_spec()],
        "experiments": [],
        "leaderboard": [],
        "invalidations": [],
        "lessons": [],
        "report_md": None,
        "model_card_md": None,
        "human_decisions": [],
        "errors": [],
        "iteration_count": 1,
        "next_team": None,
        "stop_reason": None,
    }
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


def test_build_code_prompt_round_trips_through_read_context() -> None:
    request = CodeRequest(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        dataset_path="/data/churn.csv", target_column="churned",
        task_type="binary_classification", primary_metric="roc_auc",
        drop_columns=["customer_id"], numeric_impute="median",
        categorical_impute="most_frequent", cv_kind="stratified_kfold", cv_n_splits=5,
        random_seed=42, metrics_sentinel="FOUNDRY_METRICS", attempt=0, prior_experiments=0,
        previous_error=None,
    )
    prompt = build_code_prompt(request)
    assert read_context(prompt, CodeRequest) == request


class _RecordingLLM:
    """Returns TrainingCode tagged with the attempt number and records every prompt, so tests
    can assert the traceback feedback loop is real, not decorative."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        self.prompts.append(prompt)
        request = read_context(prompt, CodeRequest)
        return TrainingCode(code=f"# attempt {request.attempt}", reasoning="")


def _sandbox_result(*, exit_code: int, stdout: str = "", stderr: str = "") -> SandboxResult:
    return SandboxResult(
        stdout=stdout, stderr=stderr, exit_code=exit_code, duration_s=0.1, timed_out=False
    )


def test_succeeds_after_two_failed_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    llm = _RecordingLLM()
    monkeypatch.setattr(runner_module, "get_llm", lambda role: llm)

    results = [
        _sandbox_result(exit_code=1, stderr="ValueError: could not convert string to float: 'x'"),
        _sandbox_result(exit_code=1, stderr="ValueError: still broken"),
        _sandbox_result(exit_code=0, stdout='FOUNDRY_METRICS {"roc_auc": 0.9}'),
    ]
    calls: list[str] = []

    def _fake_run(code: str, **kwargs: Any) -> SandboxResult:
        calls.append(code)
        return results[len(calls) - 1]

    monkeypatch.setattr(runner_module.sandbox, "run", _fake_run)

    command = runner_module.experiment_runner(_state())
    assert len(calls) == 3
    result = _update(command)["experiments"][0]
    assert result.status == "success"
    assert result.attempts == 3
    assert result.metrics == {"roc_auc": 0.9}

    # The feedback loop is real: the second prompt carries the first attempt's traceback.
    assert "could not convert string to float" in llm.prompts[1]


def test_gives_up_after_max_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    llm = _RecordingLLM()
    monkeypatch.setattr(runner_module, "get_llm", lambda role: llm)
    calls: list[str] = []

    def _fake_run(code: str, **kwargs: Any) -> SandboxResult:
        calls.append(code)
        return _sandbox_result(exit_code=1, stderr=f"ValueError: broken attempt {len(calls)}")

    monkeypatch.setattr(runner_module.sandbox, "run", _fake_run)

    command = runner_module.experiment_runner(_state())
    assert len(calls) == settings.self_debug_max_attempts
    result = _update(command)["experiments"][0]
    assert result.status == "failed"
    assert result.attempts == settings.self_debug_max_attempts
    assert "broken attempt" in (result.error or "")


def test_exit_zero_with_no_metrics_line_counts_as_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_module, "get_llm", lambda role: _RecordingLLM())

    def _fake_run(code: str, **kwargs: Any) -> SandboxResult:
        return _sandbox_result(exit_code=0, stdout="no metrics printed")

    monkeypatch.setattr(runner_module.sandbox, "run", _fake_run)

    command = runner_module.experiment_runner(_state())
    result = _update(command)["experiments"][0]
    assert result.status == "failed"
    assert result.metrics == {}


def test_no_pending_spec_records_an_error_without_crashing() -> None:
    existing = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.5}, cost_usd=0.1,
        duration_s=1.0,
    )
    command = runner_module.experiment_runner(_state(experiments=[existing]))
    assert "errors" in _update(command)


@pytest.mark.docker
def test_real_offline_run_against_churn_csv(monkeypatch: pytest.MonkeyPatch) -> None:
    from foundry.llm import StubClient
    from foundry.stubs import register_canned_responses

    client = StubClient()
    register_canned_responses(client)
    monkeypatch.setattr(runner_module, "get_llm", lambda role: client)

    command = runner_module.experiment_runner(_state())
    result = _update(command)["experiments"][0]
    assert result.status == "success"
    assert result.metrics["roc_auc"] > 0.75
    assert result.attempts == 2  # attempt 0 (naive) fails, attempt 1 (pipeline) succeeds
