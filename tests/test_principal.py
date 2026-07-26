"""Tests for foundry/teams/principal.py. Every code guard runs before any LLM call — proven
here by handing the "LLM" a client that raises if invoked at all, for every guard that should
short-circuit without ever consulting a model."""

from __future__ import annotations

from typing import Any

import pytest
from langgraph.types import Command

from foundry.config import settings
from foundry.models import DataProfile, ExperimentResult, ExperimentSpec, PrincipalDirective
from foundry.state import FoundryState
from foundry.teams import principal as principal_module

_PROFILE = DataProfile(
    n_rows=10, n_cols=1, target_column="churned", task_type="binary_classification", columns=[]
)


class _AssertNotCalledLLM:
    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        raise AssertionError("LLM should not be consulted once a code guard has fired")


class _FixedDirectiveLLM:
    def __init__(self, directive: PrincipalDirective) -> None:
        self._directive = directive

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        return self._directive


def _update(command: Command[Any]) -> dict[str, Any]:
    assert isinstance(command.update, dict)
    return command.update


def _state(**overrides: Any) -> FoundryState:
    state: FoundryState = {
        "goal": "predict churn",
        "dataset_ref": "churn",
        "budget_usd": 20.0,
        "spent_usd": 0.0,
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": None,
        "cv_strategy": None,
        "experiment_plan": [],
        "experiments": [],
        "leaderboard": [],
        "invalidations": [],
        "lessons": [],
        "report_md": None,
        "model_card_md": None,
        "human_decisions": [],
        "errors": [],
        "iteration_count": 0,
        "next_team": None,
        "stop_reason": None,
    }
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


def test_routes_to_data_team_when_no_profile_yet(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    command = principal_module.principal(_state())
    assert command.goto == "data_team"
    assert _update(command)["next_team"] == "data_team"


def test_max_iterations_guard_stops_without_consulting_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    state = _state(data_profile=_PROFILE, iteration_count=settings.principal_max_iterations)
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "max_iterations"


def test_budget_exhausted_guard_stops_without_consulting_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    state = _state(data_profile=_PROFILE, spent_usd=25.0, budget_usd=20.0)
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "budget_exhausted"


def test_target_met_guard_stops_before_consulting_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    result = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.95}, cost_usd=0.1,
        duration_s=1.0,
    )
    state = _state(data_profile=_PROFILE, experiments=[result])
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "target_met"


def test_diminishing_returns_guard_on_experiment_count_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    results = [
        ExperimentResult(
            experiment_id=f"exp-{i:03d}", status="success", metrics={"roc_auc": 0.5},
            cost_usd=0.1, duration_s=1.0,
        )
        for i in range(settings.max_experiments_total)
    ]
    state = _state(data_profile=_PROFILE, experiments=results)
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "diminishing_returns"


def test_llm_directive_can_stop_the_loop_before_any_code_cap_is_hit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(
        should_continue=False, stop_reason="diminishing_returns", rationale="enough"
    )
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    command = principal_module.principal(_state(data_profile=_PROFILE))
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "diminishing_returns"


def test_routes_to_experiment_runner_when_a_spec_is_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=0.01,
    )
    state = _state(data_profile=_PROFILE, experiment_plan=[spec])
    command = principal_module.principal(state)
    assert command.goto == "experiment_runner"
    assert _update(command)["next_team"] == "modeling_team"


def test_routes_to_experiment_planner_when_plan_is_exhausted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=0.01,
    )
    result = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.5}, cost_usd=0.1,
        duration_s=1.0,
    )
    state = _state(data_profile=_PROFILE, experiment_plan=[spec], experiments=[result])
    command = principal_module.principal(state)
    assert command.goto == "experiment_planner"


def test_iteration_count_always_increments(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    command = principal_module.principal(_state(iteration_count=3))
    assert _update(command)["iteration_count"] == 4
