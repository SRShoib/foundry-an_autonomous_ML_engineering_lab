"""Tests for foundry/teams/data_team.py. profiler_tool.profile is monkeypatched everywhere so
these never touch Docker — the real sandbox integration is proven in tests/test_profiler.py
under @pytest.mark.docker. LLM calls go through StubClient (or a purpose-built fake) rather
than a real model.
"""

from __future__ import annotations

from typing import Any, cast, get_type_hints

import pytest

from foundry.llm import StubClient
from foundry.models import (
    CleaningPlan,
    ColumnProfile,
    CVStrategy,
    DataProfile,
    LeakageFinding,
    LeakageReport,
    ProfileAssessment,
)
from foundry.state import FoundryState
from foundry.stubs import register_canned_responses
from foundry.teams import data_team
from foundry.teams.data_team import (
    DATA_TEAM_INPUT_KEYS,
    DATA_TEAM_OUTPUT_KEYS,
    DataTeamState,
    cleaner,
    data_team_node,
    splitter,
)
from foundry.tools.profiler import RawColumnStats, RawProfile


def _raw_profile() -> RawProfile:
    return RawProfile(
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
                sample_values=["1"],
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


def _empty_data_team_state(**overrides: Any) -> DataTeamState:
    state: DataTeamState = {
        "goal": "predict churn",
        "dataset_ref": "churn",
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": None,
        "cv_strategy": None,
        "errors": [],
        "costs": [],
    }
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


class _FakeLLM:
    """Returns one fixed response regardless of schema/prompt — for tests that need to prove
    a code guard overrides what the LLM said, not just replay a realistic response."""

    def __init__(self, response: object) -> None:
        self._response = response
        self.costs: list[Any] = []

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        return self._response


@pytest.fixture(autouse=True)
def _stub_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    client = StubClient()
    register_canned_responses(client)
    client.costs = []  # type: ignore[attr-defined]  # bare StubClient, not MeteredClient-wrapped
    monkeypatch.setattr(data_team, "get_llm", lambda role: client)


def test_output_keys_are_a_subset_of_both_schemas() -> None:
    parent_hints = get_type_hints(FoundryState)
    sub_hints = get_type_hints(DataTeamState)
    assert set(DATA_TEAM_OUTPUT_KEYS) <= set(parent_hints)
    assert set(DATA_TEAM_OUTPUT_KEYS) <= set(sub_hints)
    assert set(DATA_TEAM_INPUT_KEYS) <= set(parent_hints)


def test_profiler_measurements_come_from_raw_profile_not_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw = _raw_profile()
    monkeypatch.setattr(data_team.profiler_tool, "profile", lambda dataset, **kw: raw)

    # A deliberately wrong "LLM": disagrees on task_type and claims nothing is a leak, even
    # though customer_id is row-unique.
    fake_assessment = ProfileAssessment(
        task_type="regression", potential_leak_columns=[], notes=""
    )

    class _SwitchingFakeLLM:
        costs: list[Any] = []

        def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
            if schema is ProfileAssessment:
                return fake_assessment
            return LeakageReport(findings=[])

    monkeypatch.setattr(data_team, "get_llm", lambda role: _SwitchingFakeLLM())

    update = data_team.profiler(_empty_data_team_state())
    profile = cast(DataProfile, update["data_profile"])

    # Measurements always come from RawProfile, never the LLM:
    assert profile.n_rows == raw.n_rows
    assert profile.n_cols == raw.n_cols
    by_name = {col.name: col for col in profile.columns}
    assert by_name["customer_id"].n_unique == 1200

    # But the LLM's (deliberately wrong) judgment is what decides task_type / is_potential_leak:
    assert profile.task_type == "regression"
    assert by_name["customer_id"].is_potential_leak is False


def test_cleaner_never_drops_the_target_column(monkeypatch: pytest.MonkeyPatch) -> None:
    data_profile = DataProfile(
        n_rows=10,
        n_cols=1,
        target_column="churned",
        task_type="binary_classification",
        columns=[
            ColumnProfile(
                name="churned",
                dtype="int64",
                n_missing=0,
                pct_missing=0.0,
                n_unique=2,
                is_potential_leak=False,
            )
        ],
    )
    bad_plan = CleaningPlan(
        drop_columns=["churned"],
        numeric_impute="median",
        categorical_impute="most_frequent",
        rationale="oops, this would drop the target",
    )
    monkeypatch.setattr(data_team, "get_llm", lambda role: _FakeLLM(bad_plan))

    update = cleaner(_empty_data_team_state(data_profile=data_profile))
    assert "churned" not in cast(CleaningPlan, update["cleaning_plan"]).drop_columns


def test_cleaner_force_drops_high_severity_leakage_findings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_profile = DataProfile(
        n_rows=10,
        n_cols=2,
        target_column="churned",
        task_type="binary_classification",
        columns=[
            ColumnProfile(
                name="churned",
                dtype="int64",
                n_missing=0,
                pct_missing=0.0,
                n_unique=2,
                is_potential_leak=False,
            ),
            ColumnProfile(
                name="leaky_col",
                dtype="float64",
                n_missing=0,
                pct_missing=0.0,
                n_unique=10,
                is_potential_leak=False,
            ),
        ],
    )
    empty_plan = CleaningPlan(
        drop_columns=[],
        numeric_impute="median",
        categorical_impute="most_frequent",
        rationale="nothing to drop",
    )
    monkeypatch.setattr(data_team, "get_llm", lambda role: _FakeLLM(empty_plan))

    update = cleaner(
        _empty_data_team_state(
            data_profile=data_profile,
            leakage_findings=[
                LeakageFinding(column="leaky_col", reason="target proxy", severity="high")
            ],
        )
    )
    assert "leaky_col" in cast(CleaningPlan, update["cleaning_plan"]).drop_columns


def test_splitter_clamps_n_splits_and_forces_stratified_for_classification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_profile = DataProfile(
        n_rows=10000,
        n_cols=1,
        target_column="churned",
        task_type="binary_classification",
        columns=[
            ColumnProfile(
                name="churned", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=2
            )
        ],
    )
    oversized = CVStrategy(kind="kfold", n_splits=999, rationale="too many splits")
    monkeypatch.setattr(data_team, "get_llm", lambda role: _FakeLLM(oversized))

    update = splitter(_empty_data_team_state(data_profile=data_profile))
    strategy = cast(CVStrategy, update["cv_strategy"])
    assert strategy.kind == "stratified_kfold"
    assert 2 <= strategy.n_splits <= 10


def test_data_team_node_populates_all_output_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(data_team.profiler_tool, "profile", lambda dataset, **kw: _raw_profile())

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
    command = data_team_node(state)
    assert command.goto == "principal"
    assert isinstance(command.update, dict)
    for key in DATA_TEAM_OUTPUT_KEYS:
        assert key in command.update
    assert cast(DataProfile, command.update["data_profile"]).n_rows == 1200
