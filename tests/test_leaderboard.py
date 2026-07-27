"""Tests for foundry/leaderboard.py. rank_experiments/best_result are pure functions over
code-authored ExperimentResults — no LLM, no sandbox."""

from __future__ import annotations

from typing import Literal

from foundry.leaderboard import best_result, metric_direction, rank_experiments, target_met
from foundry.models import ExperimentResult


def _result(
    experiment_id: str,
    value: float,
    metric: str = "roc_auc",
    status: Literal["success", "failed", "invalidated"] = "success",
) -> ExperimentResult:
    return ExperimentResult(
        experiment_id=experiment_id,
        status=status,
        metrics={metric: value} if status == "success" else {},
        cost_usd=0.1,
        duration_s=1.0,
    )


def test_metric_direction_defaults_to_higher_is_better() -> None:
    assert metric_direction("roc_auc") == "higher_is_better"
    assert metric_direction("accuracy") == "higher_is_better"
    assert metric_direction("f1") == "higher_is_better"


def test_metric_direction_rmse_is_lower_is_better() -> None:
    assert metric_direction("rmse") == "lower_is_better"


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


def test_rank_experiments_orders_ascending_for_lower_is_better_metric() -> None:
    results = [
        _result("exp-001", 12.0, metric="rmse"),
        _result("exp-002", 4.0, metric="rmse"),
    ]
    board = rank_experiments(results, "rmse")
    assert [entry.experiment_id for entry in board] == ["exp-002", "exp-001"]


def test_rank_experiments_carries_mlflow_run_id() -> None:
    result = _result("exp-001", 0.9).model_copy(update={"mlflow_run_id": "run-abc"})
    board = rank_experiments([result], "roc_auc")
    assert board[0].mlflow_run_id == "run-abc"


def test_best_result_picks_max_for_higher_is_better() -> None:
    results = [_result("exp-001", 0.80), _result("exp-002", 0.90)]
    assert best_result(results, "roc_auc").experiment_id == "exp-002"  # type: ignore[union-attr]


def test_best_result_picks_min_for_lower_is_better() -> None:
    results = [_result("exp-001", 12.0, metric="rmse"), _result("exp-002", 4.0, metric="rmse")]
    assert best_result(results, "rmse").experiment_id == "exp-002"  # type: ignore[union-attr]


def test_best_result_none_when_nothing_succeeded() -> None:
    assert best_result([_result("exp-001", 0.5, status="failed")], "roc_auc") is None


def test_target_met_is_direction_aware() -> None:
    assert target_met(0.95, 0.90, "roc_auc") is True
    assert target_met(0.85, 0.90, "roc_auc") is False
    assert target_met(4.0, 5.0, "rmse") is True
    assert target_met(6.0, 5.0, "rmse") is False
