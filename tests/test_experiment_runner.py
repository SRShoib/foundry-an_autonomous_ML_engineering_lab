"""Tests for foundry/teams/experiment_runner.py — the self-debug loop. sandbox.run and
tracker.log_run are monkeypatched to fake, scripted results for these fast tests; a real offline
run against churn.csv (still exercising the real sandbox) is proven under @pytest.mark.docker.

experiment_runner is reached only via Send fan-out from foundry/teams/principal.py (LangGraph's
map-reduce pattern), so its input is a RunnerInput payload — one ExperimentSpec plus the handful
of fields it needs — not the full FoundryState, and there is no more "no pending spec" case to
guard against: Send always names exactly the one spec this branch runs."""

from __future__ import annotations

from typing import Any, cast

import pytest

from foundry.config import settings
from foundry.models import (
    CleaningPlan,
    CostEntry,
    CVStrategy,
    ExperimentResult,
    ExperimentSpec,
    SandboxResult,
    TrainingCode,
)
from foundry.prompting import read_context
from foundry.teams import experiment_runner as runner_module
from foundry.teams.experiment_runner import CodeRequest, RunnerInput, build_code_prompt


def _spec(experiment_id: str = "exp-001") -> ExperimentSpec:
    return ExperimentSpec(
        experiment_id=experiment_id, model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=0.01,
    )


def _payload(**overrides: Any) -> RunnerInput:
    payload: RunnerInput = {
        "spec": _spec(),
        "dataset_ref": "churn",
        "cleaning_plan": CleaningPlan(
            drop_columns=["customer_id"], numeric_impute="median",
            categorical_impute="most_frequent", rationale="r",
        ),
        "cv_strategy": CVStrategy(kind="stratified_kfold", n_splits=5, rationale="r"),
        "prior_experiments": 0,
        "batch_index": 0,
    }
    payload.update(overrides)  # type: ignore[typeddict-item]
    return payload


def _experiments(update: dict[str, object]) -> list[ExperimentResult]:
    return cast(list[ExperimentResult], update["experiments"])


def _costs(update: dict[str, object]) -> list[CostEntry]:
    return cast(list[CostEntry], update["costs"])


def _errors(update: dict[str, object]) -> list[str]:
    return cast(list[str], update.get("errors", []))


def test_build_code_prompt_round_trips_through_read_context() -> None:
    request = CodeRequest(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        dataset_path="/data/churn.csv", target_column="churned",
        task_type="binary_classification", primary_metric="roc_auc",
        drop_columns=["customer_id"], numeric_impute="median",
        categorical_impute="most_frequent", cv_kind="stratified_kfold", cv_n_splits=5,
        random_seed=42, metrics_sentinel="FOUNDRY_METRICS", attempt=0, prior_experiments=0,
        batch_index=0, previous_error=None,
    )
    prompt = build_code_prompt(request)
    assert read_context(prompt, CodeRequest) == request


class _RecordingLLM:
    """Returns TrainingCode tagged with the attempt number and records every prompt, so tests
    can assert the traceback feedback loop is real, not decorative."""

    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.costs: list[CostEntry] = []

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        self.prompts.append(prompt)
        request = read_context(prompt, CodeRequest)
        self.costs.append(CostEntry(agent_role="worker", model="stub", kind="llm", usd=0.01))
        return TrainingCode(code=f"# attempt {request.attempt}", reasoning="")


def _sandbox_result(*, exit_code: int, stdout: str = "", stderr: str = "") -> SandboxResult:
    return SandboxResult(
        stdout=stdout, stderr=stderr, exit_code=exit_code, duration_s=0.1, timed_out=False
    )


@pytest.fixture(autouse=True)
def _stub_tracker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: "run-stub-id")


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

    update = runner_module.experiment_runner(_payload())
    assert len(calls) == 3
    result = _experiments(update)[0]
    assert result.status == "success"
    assert result.attempts == 3
    assert result.metrics == {"roc_auc": 0.9}
    assert result.mlflow_run_id == "run-stub-id"

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

    update = runner_module.experiment_runner(_payload())
    assert len(calls) == settings.self_debug_max_attempts
    result = _experiments(update)[0]
    assert result.status == "failed"
    assert result.attempts == settings.self_debug_max_attempts
    assert "broken attempt" in (result.error or "")


def test_exit_zero_with_no_metrics_line_counts_as_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_module, "get_llm", lambda role: _RecordingLLM())

    def _fake_run(code: str, **kwargs: Any) -> SandboxResult:
        return _sandbox_result(exit_code=0, stdout="no metrics printed")

    monkeypatch.setattr(runner_module.sandbox, "run", _fake_run)

    update = runner_module.experiment_runner(_payload())
    result = _experiments(update)[0]
    assert result.status == "failed"
    assert result.metrics == {}


def _fake_run_success(code: str, **kwargs: Any) -> SandboxResult:
    return _sandbox_result(exit_code=0, stdout='FOUNDRY_METRICS {"roc_auc": 0.9}')


def test_costs_include_one_entry_per_llm_attempt_plus_sandbox_compute(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    llm = _RecordingLLM()
    monkeypatch.setattr(runner_module, "get_llm", lambda role: llm)
    monkeypatch.setattr(runner_module.sandbox, "run", _fake_run_success)

    update = runner_module.experiment_runner(_payload())
    costs = _costs(update)
    assert sum(1 for c in costs if c.kind == "llm") == 1
    assert sum(1 for c in costs if c.kind == "sandbox") == 1


def test_spent_usd_is_not_written_directly_by_the_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    """foundry/teams/principal.py is the sole writer of spent_usd (derived from state["costs"])
    — under Send fan-out, concurrent runners writing it directly would race and lose cost."""
    monkeypatch.setattr(runner_module, "get_llm", lambda role: _RecordingLLM())
    monkeypatch.setattr(runner_module.sandbox, "run", _fake_run_success)

    update = runner_module.experiment_runner(_payload())
    assert "spent_usd" not in update


def test_tracker_failure_is_recorded_as_an_error_but_experiment_still_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner_module, "get_llm", lambda role: _RecordingLLM())
    monkeypatch.setattr(runner_module.sandbox, "run", _fake_run_success)
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: None)

    update = runner_module.experiment_runner(_payload())
    result = _experiments(update)[0]
    assert result.status == "success"
    assert result.mlflow_run_id is None
    assert any("mlflow logging failed" in error for error in _errors(update))


@pytest.mark.docker
def test_real_offline_run_against_churn_csv(monkeypatch: pytest.MonkeyPatch) -> None:
    from foundry.llm import StubClient
    from foundry.stubs import register_canned_responses

    client = StubClient()
    register_canned_responses(client)
    client.costs = []  # type: ignore[attr-defined]  # bare StubClient, not MeteredClient-wrapped
    monkeypatch.setattr(runner_module, "get_llm", lambda role: client)

    update = runner_module.experiment_runner(_payload())
    result = _experiments(update)[0]
    assert result.status == "success"
    assert result.metrics["roc_auc"] > 0.75
    assert result.attempts == 2  # attempt 0 (naive) fails, attempt 1 (pipeline) succeeds
