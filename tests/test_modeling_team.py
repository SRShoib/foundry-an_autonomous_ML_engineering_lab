"""Tests for foundry/teams/modeling_team.py. Code owns model-family filtering, the per-iteration
cap, the fallback baseline, and experiment_id assignment — the LLM's plan is a starting point,
never the final word."""

from __future__ import annotations

from typing import Any, Literal

import pytest
from langgraph.types import Command

from foundry.models import ExperimentPlan, ExperimentResult, ExperimentSpec, RedTeamFinding
from foundry.prompting import read_context
from foundry.state import FoundryState
from foundry.teams import modeling_team
from foundry.teams.modeling_team import PlanContext

_ModelFamily = Literal[
    "logistic_regression", "random_forest", "gradient_boosting", "xgboost", "lightgbm", "mlp"
]


class _FixedPlanLLM:
    def __init__(self, plan: ExperimentPlan) -> None:
        self._plan = plan
        self.costs: list[Any] = []
        self.last_prompt: str | None = None

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        self.last_prompt = prompt
        return self._plan


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
        "audited_experiments": [],
        "costs": [],
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


def _spec(family: _ModelFamily, experiment_id: str = "stub") -> ExperimentSpec:
    return ExperimentSpec(
        experiment_id=experiment_id, model_family=family, hyperparams={}, rationale="r",
        est_cost_usd=0.01,
    )


def test_truncates_to_max_experiments_per_iteration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(modeling_team.settings, "max_experiments_per_iteration", 1)
    plan = ExperimentPlan(specs=[_spec("logistic_regression"), _spec("random_forest")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedPlanLLM(plan))

    command = modeling_team.experiment_planner(_state())
    assert len(_update(command)["experiment_plan"]) == 1


def test_unsupported_model_families_are_filtered_with_an_error_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = ExperimentPlan(specs=[_spec("xgboost")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedPlanLLM(plan))

    command = modeling_team.experiment_planner(_state())
    update = _update(command)
    new_specs = update["experiment_plan"]
    assert len(new_specs) == 1
    assert new_specs[0].model_family == "logistic_regression"  # fallback baseline
    assert "xgboost" in update["errors"][0]


def test_falls_back_to_baseline_when_nothing_survives_filtering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = ExperimentPlan(specs=[_spec("lightgbm"), _spec("xgboost")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedPlanLLM(plan))

    command = modeling_team.experiment_planner(_state())
    new_specs = _update(command)["experiment_plan"]
    assert len(new_specs) == 1
    assert new_specs[0].model_family == "logistic_regression"


def test_experiment_ids_are_code_assigned_unique_and_appended(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = ExperimentPlan(specs=[_spec("random_forest", experiment_id="whatever-the-llm-said")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedPlanLLM(plan))

    existing = _spec("logistic_regression", experiment_id="exp-001")
    command = modeling_team.experiment_planner(_state(experiment_plan=[existing]))
    new_plan = _update(command)["experiment_plan"]

    assert len(new_plan) == 2
    assert new_plan[0] is existing  # appended, not replaced
    assert new_plan[1].experiment_id == "exp-002"


def test_plan_context_carries_recent_invalidations_and_excludes_them_from_best_metric(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """M5: an invalidated experiment's inflated metric must not leak into best_metric_so_far,
    and its finding's recommendation should reach the LLM's context so a replacement spec is
    planned in light of it."""
    plan = ExperimentPlan(specs=[_spec("random_forest")])
    llm = _FixedPlanLLM(plan)
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: llm)

    leaky = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.99}, cost_usd=0.1,
        duration_s=1.0,
    )
    finding = RedTeamFinding(
        experiment_id="exp-001", category="leakage", verdict="invalidated",
        explanation="target-association AUC clears the threshold",
        recommendation="drop the leak column and retrain",
    )
    modeling_team.experiment_planner(_state(experiments=[leaky], invalidations=[finding]))

    assert llm.last_prompt is not None
    context = read_context(llm.last_prompt, PlanContext)
    assert context.best_metric_so_far is None
    assert context.recent_invalidations == ["leakage: drop the leak column and retrain"]
