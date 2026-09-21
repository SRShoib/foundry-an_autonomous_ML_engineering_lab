"""Unit tests for foundry/models.py: validation, and Literal fields rejecting values outside
the closed set they were declared to route or classify on."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from foundry.config import settings
from foundry.models import (
    ColumnProfile,
    CVStrategy,
    DataProfile,
    ExperimentResult,
    ExperimentSpec,
    HumanDecision,
    LeaderboardEntry,
    LeakageFinding,
    RedTeamFinding,
    RedTeamVerdict,
    SandboxLimits,
    SandboxResult,
)


def test_data_profile_round_trips_through_dump_and_validate() -> None:
    profile = DataProfile(
        n_rows=100,
        n_cols=1,
        target_column="churn",
        task_type="binary_classification",
        columns=[
            ColumnProfile(name="churn", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=2)
        ],
    )
    assert DataProfile.model_validate(profile.model_dump()) == profile


def test_data_profile_rejects_unknown_task_type() -> None:
    with pytest.raises(ValidationError):
        DataProfile(
            n_rows=1,
            n_cols=1,
            target_column="y",
            task_type="not_a_real_task",  # type: ignore[arg-type]
            columns=[],
        )


def test_leakage_finding_rejects_unknown_severity() -> None:
    with pytest.raises(ValidationError):
        LeakageFinding(column="x", reason="leaks target", severity="extreme")  # type: ignore[arg-type]


def test_cv_strategy_rejects_unknown_kind() -> None:
    with pytest.raises(ValidationError):
        CVStrategy(kind="bootstrap", n_splits=5, rationale="")  # type: ignore[arg-type]


def test_experiment_spec_rejects_unknown_model_family() -> None:
    with pytest.raises(ValidationError):
        ExperimentSpec(
            experiment_id="exp-1",
            model_family="deep_transformer",  # type: ignore[arg-type]
            hyperparams={},
            rationale="",
            est_cost_usd=0.1,
        )


def test_red_team_finding_rejects_unknown_category() -> None:
    with pytest.raises(ValidationError):
        RedTeamFinding(
            experiment_id="exp-1",
            category="bribery",  # type: ignore[arg-type]
            verdict="invalidated",
            explanation="",
            recommendation="",
        )


def test_experiment_result_rejects_unknown_status() -> None:
    with pytest.raises(ValidationError):
        ExperimentResult(
            experiment_id="exp-1",
            status="pending",  # type: ignore[arg-type]
            cost_usd=0.0,
            duration_s=0.0,
        )


def test_experiment_result_no_longer_accepts_invalidated_as_a_status() -> None:
    """M5: invalidation is recorded in state["invalidations"], never written back into
    ExperimentResult.status — see foundry/leaderboard.py and foundry/teams/red_team.py."""
    with pytest.raises(ValidationError):
        ExperimentResult(
            experiment_id="exp-1",
            status="invalidated",  # type: ignore[arg-type]
            cost_usd=0.0,
            duration_s=0.0,
        )


def test_red_team_verdict_rejects_unknown_category() -> None:
    with pytest.raises(ValidationError):
        RedTeamVerdict(
            verdict="valid",
            category="bribery",  # type: ignore[arg-type]
            explanation="",
            recommendation="",
        )


def test_sandbox_limits_default_from_settings() -> None:
    limits = SandboxLimits()
    assert limits.memory == settings.sandbox_memory_limit
    assert limits.cpus == settings.sandbox_cpu_limit
    assert limits.pids == settings.sandbox_pids_limit
    assert limits.timeout_seconds == settings.sandbox_timeout_seconds


def test_sandbox_result_carries_bytes_artifacts() -> None:
    result = SandboxResult(
        stdout="ok",
        stderr="",
        exit_code=0,
        duration_s=0.1,
        timed_out=False,
        artifacts={"model.pkl": b"\x80\x04binary"},
    )
    assert result.artifacts["model.pkl"] == b"\x80\x04binary"


def test_leaderboard_entry_and_human_decision_construct() -> None:
    entry = LeaderboardEntry(
        experiment_id="exp-1",
        mlflow_run_id="run-1",
        primary_metric_name="roc_auc",
        primary_metric_value=0.91,
        rank=1,
    )
    assert entry.rank == 1

    decision = HumanDecision(gate="budget", approved=True)
    assert decision.gate == "budget"
    assert decision.approved is True

    with pytest.raises(ValidationError):
        HumanDecision(gate="prelaunch", approved=True)  # type: ignore[arg-type]
