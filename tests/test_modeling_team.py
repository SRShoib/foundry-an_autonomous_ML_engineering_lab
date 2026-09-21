"""Tests for foundry/teams/modeling_team.py. Code owns model-family filtering (unsupported AND,
as of M7, scout-avoided), the per-iteration cap, the fallback baseline, and experiment_id
assignment — the LLM's plan is a starting point, never the final word. M7 also covers
literature_scout directly: it operates on ModelingTeamState (the subgraph's private schema, not
the full FoundryState), so its tests build that narrower fixture instead."""

from __future__ import annotations

from typing import Any, Literal, cast

import pytest

from foundry.models import (
    ApproachMemo,
    ExperimentPlan,
    ExperimentResult,
    ExperimentSpec,
    Lesson,
    RedTeamFinding,
)
from foundry.prompting import read_context
from foundry.teams import modeling_team
from foundry.teams.modeling_team import ModelingTeamState, PlanContext, ScoutContext

_ModelFamily = Literal[
    "logistic_regression", "random_forest", "gradient_boosting", "xgboost", "lightgbm", "mlp"
]


class _FixedLLM:
    """A fake LLMClient that always returns the same fixed response, whatever schema is asked
    for — used for both ExperimentPlan and ApproachMemo responses in this file."""

    def __init__(self, response: Any) -> None:
        self._response = response
        self.costs: list[Any] = []
        self.last_prompt: str | None = None

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        self.last_prompt = prompt
        return self._response


def _state(**overrides: Any) -> ModelingTeamState:
    state: ModelingTeamState = {
        "goal": "predict churn",
        "dataset_ref": "churn",
        "data_profile": None,
        "experiment_plan": [],
        "experiments": [],
        "invalidations": [],
        "approach_memo": None,
        "errors": [],
        "costs": [],
    }
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


def _spec(family: _ModelFamily, experiment_id: str = "stub") -> ExperimentSpec:
    return ExperimentSpec(
        experiment_id=experiment_id, model_family=family, hyperparams={}, rationale="r",
        est_cost_usd=0.01,
    )


def _plan(update: dict[str, object]) -> list[ExperimentSpec]:
    return cast("list[ExperimentSpec]", update["experiment_plan"])


def _errors(update: dict[str, object]) -> list[str]:
    return cast("list[str]", update["errors"])


# --- experiment_planner ------------------------------------------------------------------------


def test_truncates_to_max_experiments_per_iteration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(modeling_team.settings, "max_experiments_per_iteration", 1)
    plan = ExperimentPlan(specs=[_spec("logistic_regression"), _spec("random_forest")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedLLM(plan))

    update = modeling_team.experiment_planner(_state())
    assert len(_plan(update)) == 1


def test_unsupported_model_families_are_filtered_with_an_error_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = ExperimentPlan(specs=[_spec("xgboost")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedLLM(plan))

    update = modeling_team.experiment_planner(_state())
    new_specs = _plan(update)
    assert len(new_specs) == 1
    assert new_specs[0].model_family == "logistic_regression"  # fallback baseline
    assert "xgboost" in _errors(update)[0]


def test_falls_back_to_baseline_when_nothing_survives_filtering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = ExperimentPlan(specs=[_spec("lightgbm"), _spec("xgboost")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedLLM(plan))

    update = modeling_team.experiment_planner(_state())
    new_specs = _plan(update)
    assert len(new_specs) == 1
    assert new_specs[0].model_family == "logistic_regression"


def test_experiment_ids_are_code_assigned_unique_and_appended(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = ExperimentPlan(specs=[_spec("random_forest", experiment_id="whatever-the-llm-said")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedLLM(plan))

    existing = _spec("logistic_regression", experiment_id="exp-001")
    update = modeling_team.experiment_planner(_state(experiment_plan=[existing]))
    new_plan = _plan(update)

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
    llm = _FixedLLM(plan)
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


def test_plan_context_carries_recommended_and_avoid_families_from_approach_memo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    memo = ApproachMemo(
        summary="s", recommended_families=["gradient_boosting"], avoid_families=["mlp"],
        cautions="careful of the leak column",
    )
    plan = ExperimentPlan(specs=[_spec("random_forest")])
    llm = _FixedLLM(plan)
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: llm)

    modeling_team.experiment_planner(_state(approach_memo=memo))

    assert llm.last_prompt is not None
    context = read_context(llm.last_prompt, PlanContext)
    assert context.recommended_families == ["gradient_boosting"]
    assert context.avoid_families == ["mlp"]
    assert context.cautions == "careful of the leak column"


def test_avoided_families_are_dropped_from_the_plan_with_an_error_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Code guard: a family the scout said to avoid can never be scheduled regardless of what
    the planner's LLM proposed — the same 'LLM proposes, code disposes' split as unsupported
    families."""
    memo = ApproachMemo(summary="s", avoid_families=["mlp"])
    plan = ExperimentPlan(specs=[_spec("mlp"), _spec("random_forest")])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedLLM(plan))

    update = modeling_team.experiment_planner(_state(approach_memo=memo))
    new_specs = _plan(update)
    assert [spec.model_family for spec in new_specs] == ["random_forest"]
    assert "mlp" in _errors(update)[0]


# --- literature_scout ---------------------------------------------------------------------------


def test_literature_scout_skips_the_llm_once_a_memo_already_exists_this_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _raise(role: str) -> Any:
        raise AssertionError("LLM should not be consulted once this run already has a memo")

    monkeypatch.setattr(modeling_team, "get_llm", _raise)
    existing = ApproachMemo(summary="already scouted this run")
    update = modeling_team.literature_scout(_state(approach_memo=existing))
    assert update == {}


def test_literature_scout_consults_memory_and_recommends_the_past_winner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lesson = Lesson(
        dataset_ref="churn",
        task_type="binary_classification",
        text="gradient_boosting reached roc_auc=0.93, the best of 3 families tried.",
        best_model_family="gradient_boosting",
        best_metric_name="roc_auc",
        best_metric_value=0.93,
    )
    monkeypatch.setattr(modeling_team.memory, "search", lambda dataset_ref, **kw: [lesson])
    memo = ApproachMemo(summary="s", recommended_families=["gradient_boosting"])
    llm = _FixedLLM(memo)
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: llm)

    update = modeling_team.literature_scout(_state())

    assert llm.last_prompt is not None
    context = read_context(llm.last_prompt, ScoutContext)
    assert context.past_lessons == [lesson.text]
    assert context.past_best_family == "gradient_boosting"
    assert update["approach_memo"] == memo
    assert update["costs"] == []


def test_literature_scout_ignores_lessons_for_a_different_primary_metric(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    off_metric_lesson = Lesson(
        dataset_ref="churn",
        task_type="binary_classification",
        text="on a different metric, mlp won",
        best_model_family="mlp",
        best_metric_name="accuracy",  # churn's primary metric is roc_auc
        best_metric_value=0.99,
    )
    monkeypatch.setattr(
        modeling_team.memory, "search", lambda dataset_ref, **kw: [off_metric_lesson]
    )
    llm = _FixedLLM(ApproachMemo(summary="s"))
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: llm)

    modeling_team.literature_scout(_state())

    assert llm.last_prompt is not None
    context = read_context(llm.last_prompt, ScoutContext)
    assert context.past_best_family is None


def test_literature_scout_filters_unsupported_families_with_an_error_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(modeling_team.memory, "search", lambda dataset_ref, **kw: [])
    memo = ApproachMemo(summary="s", recommended_families=["xgboost"], avoid_families=["lightgbm"])
    monkeypatch.setattr(modeling_team, "get_llm", lambda role: _FixedLLM(memo))

    update = modeling_team.literature_scout(_state())

    result_memo = cast(ApproachMemo, update["approach_memo"])
    assert result_memo.recommended_families == []
    assert result_memo.avoid_families == []
    assert "xgboost" in _errors(update)[0]
    assert "lightgbm" in _errors(update)[0]
