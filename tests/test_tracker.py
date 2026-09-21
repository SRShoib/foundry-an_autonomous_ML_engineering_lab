"""Tests for foundry/tools/tracker.py. _build_params/_build_tags/_experiment_name are pure and
tested without any MLflow server, mirroring test_sandbox.py's _build_command pattern. The
"offline" test proves log_run/query_runs degrade to None/[] instead of raising when the tracking
server is unreachable — the guarantee that lets make test/make run work without `make up`.
Live round-trip is under @pytest.mark.mlflow, auto-skipped when no server is reachable."""

from __future__ import annotations

import uuid

import pytest

from foundry.config import settings
from foundry.models import ExperimentSpec
from foundry.tools import tracker


def _spec(experiment_id: str = "exp-001") -> ExperimentSpec:
    return ExperimentSpec(
        experiment_id=experiment_id,
        model_family="logistic_regression",
        hyperparams={"C": 1.0, "max_iter": 1000},
        rationale="r",
        est_cost_usd=0.01,
    )


def test_experiment_name_is_scoped_by_dataset_ref() -> None:
    assert tracker._experiment_name("churn") == f"{settings.mlflow_experiment_name}-churn"


def test_build_params_includes_model_family_prefixed_hyperparams_and_extras() -> None:
    params = tracker._build_params(_spec(), {"cv_kind": "stratified_kfold"})
    assert params["model_family"] == "logistic_regression"
    assert params["hp_C"] == "1.0"
    assert params["hp_max_iter"] == "1000"
    assert params["cv_kind"] == "stratified_kfold"


def test_build_tags_carries_foundry_experiment_id_and_status() -> None:
    tags = tracker._build_tags(_spec("exp-007"), dataset_ref="churn", status="success")
    assert tags == {
        "foundry_experiment_id": "exp-007",
        "dataset_ref": "churn",
        "status": "success",
    }


def _make_tracking_server_fail_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    """Points at a port nothing listens on and disables mlflow's own HTTP retry/backoff (default
    7 retries, up to 120s timeout) — otherwise the "unreachable" tests take minutes instead of
    failing fast."""
    monkeypatch.setattr(settings, "mlflow_tracking_uri", "http://127.0.0.1:1")
    monkeypatch.setenv("MLFLOW_HTTP_REQUEST_MAX_RETRIES", "0")
    monkeypatch.setenv("MLFLOW_HTTP_REQUEST_TIMEOUT", "2")


def test_log_run_returns_none_when_tracking_server_is_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _make_tracking_server_fail_fast(monkeypatch)
    run_id = tracker.log_run(
        spec=_spec(),
        dataset_ref="churn",
        metrics={"roc_auc": 0.9},
        params={"cv_kind": "stratified_kfold", "cv_n_splits": "5"},
        artifacts={"model.pkl": b"fake-bytes"},
        status="success",
        duration_s=1.0,
    )
    assert run_id is None


def test_query_runs_returns_empty_list_when_tracking_server_is_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _make_tracking_server_fail_fast(monkeypatch)
    assert tracker.query_runs("churn") == []


@pytest.mark.mlflow
def test_log_run_and_query_runs_round_trip_against_a_real_server() -> None:
    dataset_ref = f"test-{uuid.uuid4().hex[:8]}"
    spec = _spec(f"exp-{uuid.uuid4().hex[:8]}")

    run_id = tracker.log_run(
        spec=spec,
        dataset_ref=dataset_ref,
        metrics={"roc_auc": 0.91},
        params={"cv_kind": "stratified_kfold", "cv_n_splits": "5"},
        artifacts={"model.pkl": b"fake-model-bytes", "nested/train.py": b"print('hi')"},
        status="success",
        duration_s=12.5,
    )
    assert run_id is not None

    runs = tracker.query_runs(dataset_ref)
    assert len(runs) == 1
    logged = runs[0]
    assert logged.run_id == run_id
    assert logged.status == "FINISHED"
    assert logged.metrics["roc_auc"] == pytest.approx(0.91)
    assert logged.tags["foundry_experiment_id"] == spec.experiment_id
    assert logged.params["model_family"] == "logistic_regression"


@pytest.mark.mlflow
def test_log_run_marks_failed_status_as_failed_in_mlflow() -> None:
    dataset_ref = f"test-{uuid.uuid4().hex[:8]}"
    run_id = tracker.log_run(
        spec=_spec(),
        dataset_ref=dataset_ref,
        metrics={},
        params={"cv_kind": "stratified_kfold", "cv_n_splits": "5"},
        artifacts={},
        status="failed",
        duration_s=3.0,
    )
    assert run_id is not None
    runs = tracker.query_runs(dataset_ref)
    assert runs[0].status == "FAILED"
