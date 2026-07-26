"""Tests for foundry/stubs.py — the offline determinism guarantee (SPEC M2: "graph runs with
NO api keys"). Each factory is exercised through a fresh StubClient with a realistic context,
not by calling the private factory functions directly, so these tests double as a contract test
for register_canned_responses."""

from __future__ import annotations

import ast
from typing import Any

from foundry.llm import StubClient
from foundry.models import (
    CleaningPlan,
    ColumnProfile,
    CVStrategy,
    DataProfile,
    ExperimentPlan,
    LeakageReport,
    PrincipalDirective,
    ProfileAssessment,
    ReportNarrative,
    TrainingCode,
)
from foundry.prompting import with_context
from foundry.stubs import register_canned_responses
from foundry.teams.experiment_runner import CodeRequest
from foundry.teams.modeling_team import PlanContext
from foundry.teams.principal import SupervisorContext
from foundry.teams.reporter import ReportContext
from foundry.tools.profiler import RawColumnStats, RawProfile


def _client() -> StubClient:
    client = StubClient()
    register_canned_responses(client)
    return client


_RAW_PROFILE = RawProfile(
    dataset_name="churn.csv",
    n_rows=1200,
    n_cols=3,
    target_column="churned",
    target_positive_rate=0.28,
    columns=[
        RawColumnStats(
            name="customer_id",
            dtype="object",
            n_missing=0,
            pct_missing=0.0,
            n_unique=1200,
            is_numeric=False,
            sample_values=["CUST-00001"],
        ),
        RawColumnStats(
            name="tenure_months",
            dtype="int64",
            n_missing=0,
            pct_missing=0.0,
            n_unique=72,
            is_numeric=True,
            sample_values=["1", "2"],
            target_corr=-0.2,
            target_auc=0.3,
        ),
        RawColumnStats(
            name="churned",
            dtype="int64",
            n_missing=0,
            pct_missing=0.0,
            n_unique=2,
            is_numeric=True,
            sample_values=["0", "1"],
        ),
    ],
)

_DATA_PROFILE = DataProfile(
    n_rows=1200,
    n_cols=2,
    target_column="churned",
    task_type="binary_classification",
    columns=[
        ColumnProfile(
            name="customer_id",
            dtype="object",
            n_missing=0,
            pct_missing=0.0,
            n_unique=1200,
            is_potential_leak=True,
        ),
        ColumnProfile(
            name="tenure_months",
            dtype="int64",
            n_missing=0,
            pct_missing=0.0,
            n_unique=72,
            is_potential_leak=False,
        ),
    ],
)


def test_registry_covers_exactly_the_expected_schemas() -> None:
    client = _client()
    expected = {
        ProfileAssessment,
        LeakageReport,
        CleaningPlan,
        CVStrategy,
        ExperimentPlan,
        TrainingCode,
        PrincipalDirective,
        ReportNarrative,
    }
    assert set(client._registry) == expected


def test_profile_assessment_flags_the_row_unique_column() -> None:
    result = _client().structured(with_context("assess", _RAW_PROFILE), ProfileAssessment)
    assert result.task_type == "binary_classification"
    assert "customer_id" in result.potential_leak_columns
    assert "tenure_months" not in result.potential_leak_columns


def test_leakage_report_finds_the_id_column() -> None:
    result = _client().structured(with_context("scan", _RAW_PROFILE), LeakageReport)
    assert any(finding.column == "customer_id" for finding in result.findings)


def test_stub_responses_are_deterministic() -> None:
    client = _client()
    prompt = with_context("assess", _RAW_PROFILE)
    assert client.structured(prompt, ProfileAssessment) == client.structured(
        prompt, ProfileAssessment
    )


def test_cleaning_plan_drops_flagged_leak_columns() -> None:
    result = _client().structured(with_context("clean", _DATA_PROFILE), CleaningPlan)
    assert "customer_id" in result.drop_columns
    assert "tenure_months" not in result.drop_columns


def test_cv_strategy_uses_stratified_kfold_for_classification() -> None:
    result = _client().structured(with_context("split", _DATA_PROFILE), CVStrategy)
    assert result.kind == "stratified_kfold"
    assert result.n_splits >= 2


def _plan_context(**overrides: Any) -> PlanContext:
    base = PlanContext(
        goal="predict churn",
        task_type="binary_classification",
        primary_metric="roc_auc",
        n_rows=1200,
        n_cols=12,
        prior_experiments=0,
        prior_model_families=[],
        best_metric_so_far=None,
    )
    return base.model_copy(update=overrides)


def test_experiment_plan_escalates_model_family_by_prior_attempts() -> None:
    client = _client()
    first = client.structured(with_context("plan", _plan_context()), ExperimentPlan)
    assert first.specs[0].model_family == "logistic_regression"

    second_ctx = _plan_context(prior_experiments=1, prior_model_families=["logistic_regression"])
    second = client.structured(with_context("plan", second_ctx), ExperimentPlan)
    assert second.specs[0].model_family == "random_forest"


def _code_request(*, attempt: int, prior_experiments: int) -> CodeRequest:
    return CodeRequest(
        experiment_id="exp-001",
        model_family="logistic_regression",
        hyperparams={},
        dataset_path="/data/churn.csv",
        target_column="churned",
        task_type="binary_classification",
        primary_metric="roc_auc",
        drop_columns=["customer_id"],
        numeric_impute="median",
        categorical_impute="most_frequent",
        cv_kind="stratified_kfold",
        cv_n_splits=5,
        random_seed=42,
        metrics_sentinel="FOUNDRY_METRICS",
        attempt=attempt,
        prior_experiments=prior_experiments,
        previous_error=None,
    )


def test_training_code_first_attempt_is_naive_and_syntactically_valid() -> None:
    request = _code_request(attempt=0, prior_experiments=0)
    result = _client().structured(with_context("write code", request), TrainingCode)
    ast.parse(result.code)
    assert "OneHotEncoder" not in result.code


def test_training_code_later_attempt_uses_the_encoding_pipeline() -> None:
    request = _code_request(attempt=1, prior_experiments=0)
    result = _client().structured(with_context("write code", request), TrainingCode)
    ast.parse(result.code)
    assert "OneHotEncoder" in result.code


def test_training_code_differs_between_attempt_0_and_attempt_1() -> None:
    client = _client()
    naive = client.structured(
        with_context("c", _code_request(attempt=0, prior_experiments=0)), TrainingCode
    )
    piped = client.structured(
        with_context("c", _code_request(attempt=1, prior_experiments=0)), TrainingCode
    )
    assert naive.code != piped.code


def _supervisor_context(**overrides: Any) -> SupervisorContext:
    base = SupervisorContext(
        goal="predict churn",
        budget_usd=20.0,
        spent_usd=0.1,
        iteration=1,
        max_iterations=12,
        n_experiments_total=0,
        n_experiments_successful=0,
        best_metric_so_far=None,
        primary_metric="roc_auc",
        target_value=0.9,
    )
    return base.model_copy(update=overrides)


def test_principal_directive_continues_when_little_progress_made() -> None:
    result = _client().structured(
        with_context("decide", _supervisor_context()), PrincipalDirective
    )
    assert result.should_continue is True


def test_principal_directive_stops_with_diminishing_returns_after_two_successes() -> None:
    ctx = _supervisor_context(
        iteration=5, n_experiments_total=2, n_experiments_successful=2, best_metric_so_far=0.85
    )
    result = _client().structured(with_context("decide", ctx), PrincipalDirective)
    assert result.should_continue is False
    assert result.stop_reason == "diminishing_returns"


def test_principal_directive_stops_with_target_met() -> None:
    ctx = _supervisor_context(
        iteration=2, n_experiments_total=1, n_experiments_successful=1, best_metric_so_far=0.96
    )
    result = _client().structured(with_context("decide", ctx), PrincipalDirective)
    assert result.should_continue is False
    assert result.stop_reason == "target_met"


def test_report_narrative_has_no_numeric_fields() -> None:
    for name, field in ReportNarrative.model_fields.items():
        assert field.annotation is str, f"{name} must be str-typed, got {field.annotation}"


def test_report_narrative_summarizes_the_run() -> None:
    context = ReportContext(
        goal="predict churn",
        dataset_name="churn",
        stop_reason="diminishing_returns",
        iteration_count=6,
        n_experiments=2,
        n_successful=2,
        primary_metric="roc_auc",
        leaderboard=[],
    )
    result = _client().structured(with_context("summarize", context), ReportNarrative)
    assert "churn" in result.summary
