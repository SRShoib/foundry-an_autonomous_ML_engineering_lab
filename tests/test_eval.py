"""Tests for foundry/eval/{harness,monolith,ablations,report}.py — SPEC M8's eval harness and its
four named ablations. Runs entirely Docker-free by faking the sandbox/profiler/audit/tracker
boundary exactly the way tests/test_graph.py already does for the core graph (the fixtures below
mirror that file's churn/churn_leaky shapes rather than importing them, keeping this file
self-contained the same way every other test module in this repo is)."""

from __future__ import annotations

from typing import Any

import pytest

from foundry.config import settings
from foundry.eval import ablations, report
from foundry.eval import monolith as monolith_module
from foundry.eval.harness import run_task
from foundry.eval.monolith import run_monolith
from foundry.llm import MeteredClient, StubClient
from foundry.models import SandboxResult
from foundry.stubs import register_canned_responses
from foundry.teams import data_team as data_team_module
from foundry.teams import experiment_runner as runner_module
from foundry.teams import lessons as lessons_module
from foundry.teams import modeling_team as modeling_team_module
from foundry.teams import principal as principal_module
from foundry.teams import red_team as red_team_module
from foundry.teams import reporter as reporter_module
from foundry.tools.audit import AuditColumnStat, AuditReport
from foundry.tools.profiler import RawColumnStats, RawProfile

_ALL_MODULES_WITH_GET_LLM = (
    principal_module,
    data_team_module,
    modeling_team_module,
    runner_module,
    red_team_module,
    reporter_module,
    lessons_module,
    monolith_module,
)


def _use_stub_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    client = StubClient()
    register_canned_responses(client)
    for module in _ALL_MODULES_WITH_GET_LLM:
        monkeypatch.setattr(
            module, "get_llm", lambda role, _client=client: MeteredClient(role, _client, model=None)
        )


# --- churn fixture (clean/honest) -------------------------------------------------------------

_RAW_PROFILE = RawProfile(
    dataset_name="churn.csv",
    n_rows=1200,
    n_cols=3,
    target_column="churned",
    target_positive_rate=0.28,
    columns=[
        RawColumnStats(
            name="customer_id", dtype="object", n_missing=0, pct_missing=0.0, n_unique=1200,
            is_numeric=False, sample_values=["a"],
        ),
        RawColumnStats(
            name="tenure_months", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=72,
            is_numeric=True, sample_values=["1"],
        ),
        RawColumnStats(
            name="churned", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=2,
            is_numeric=True, sample_values=["0", "1"],
        ),
    ],
)
_SANDBOX_SUCCESS = SandboxResult(
    stdout='FOUNDRY_METRICS {"roc_auc": 0.9}', stderr="", exit_code=0, duration_s=0.1,
    timed_out=False,
)
_CLEAN_AUDIT_REPORT = AuditReport(
    dataset_name="churn.csv", n_rows=1200, n_cols=2, target_column="churned",
    columns=[AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.3)],
    duplicate_row_count=0, duplicate_row_rate=0.0,
)


def _fake_churn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        data_team_module.profiler_tool, "profile", lambda dataset, **kw: _RAW_PROFILE
    )
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: "run-id")
    monkeypatch.setattr(runner_module.sandbox, "run", lambda code, **kw: _SANDBOX_SUCCESS)
    monkeypatch.setattr(
        red_team_module.audit_tool,
        "audit",
        lambda dataset, cleaning_plan, **kw: _CLEAN_AUDIT_REPORT,
    )


# --- churn_leaky fixture (M5's booby trap, reused here for the red-team/monolith ablations) ----

_LEAKY_RAW_PROFILE = RawProfile(
    dataset_name="churn_leaky.csv",
    n_rows=300,
    n_cols=4,
    target_column="churned",
    target_positive_rate=0.27,
    columns=[
        RawColumnStats(
            name="customer_id", dtype="object", n_missing=0, pct_missing=0.0, n_unique=300,
            is_numeric=False, sample_values=["a"],
        ),
        RawColumnStats(
            name="tenure_months", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=72,
            is_numeric=True, sample_values=["1"], target_corr=-0.1, target_auc=0.4,
        ),
        RawColumnStats(
            name="retention_call_outcome", dtype="object", n_missing=0, pct_missing=0.0,
            n_unique=3, is_numeric=False, sample_values=["saved"],
        ),
        RawColumnStats(
            name="churned", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=2,
            is_numeric=True, sample_values=["0", "1"],
        ),
    ],
)
_LEAKY_AUDIT_REPORT = AuditReport(
    dataset_name="churn_leaky.csv", n_rows=300, n_cols=2, target_column="churned",
    columns=[
        AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.4),
        AuditColumnStat(name="retention_call_outcome", is_numeric=False, target_auc=0.9962),
    ],
    duplicate_row_count=0, duplicate_row_rate=0.0,
)
_CLEAN_LEAKY_AUDIT_REPORT = AuditReport(
    dataset_name="churn_leaky.csv", n_rows=300, n_cols=1, target_column="churned",
    columns=[AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.4)],
    duplicate_row_count=0, duplicate_row_rate=0.0,
)


def _fake_leaky_audit(dataset: Any, cleaning_plan: Any, **kw: Any) -> AuditReport:
    dropped = set(cleaning_plan.drop_columns) if cleaning_plan else set()
    return _CLEAN_LEAKY_AUDIT_REPORT if "retention_call_outcome" in dropped else _LEAKY_AUDIT_REPORT


def _fake_leaky_sandbox_run(code: str, **kw: Any) -> SandboxResult:
    if "'retention_call_outcome'" in code:
        return SandboxResult(
            stdout='FOUNDRY_METRICS {"roc_auc": 0.80}', stderr="", exit_code=0, duration_s=0.1,
            timed_out=False,
        )
    return SandboxResult(
        stdout='FOUNDRY_METRICS {"roc_auc": 0.99}', stderr="", exit_code=0, duration_s=0.1,
        timed_out=False,
    )


def _fake_leaky(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        data_team_module.profiler_tool, "profile", lambda dataset, **kw: _LEAKY_RAW_PROFILE
    )
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: "run-id")
    monkeypatch.setattr(runner_module.sandbox, "run", _fake_leaky_sandbox_run)
    monkeypatch.setattr(red_team_module.audit_tool, "audit", _fake_leaky_audit)


# --- harness.run_task ---------------------------------------------------------------------------


def test_run_task_completes_the_full_graph_and_populates_task_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_stub_everywhere(monkeypatch)
    _fake_churn(monkeypatch)

    result = run_task("churn", config_label="full")

    # foundry/graph.py's only route to a non-interrupted graph.invoke() completion is
    # reporter -> final_gate -> lesson_writer -> END (its static edges) -- a populated
    # stop_reason with no error therefore structurally proves the real final_gate interrupt()
    # was hit and resumed through via a genuine Command(resume=...), not skipped, the same
    # guarantee tests/test_graph.py's _resume_through_final_gate asserts directly.
    assert result.error is None
    assert result.stop_reason is not None
    assert result.n_experiments > 0
    assert result.n_successful > 0
    assert result.cost_total_usd > 0
    assert result.primary_metric_value is not None
    assert result.calls_by_agent  # at least one real LLM call recorded per role


# --- ablations.override_settings -----------------------------------------------------------


def test_override_settings_restores_every_field_including_on_exception() -> None:
    original_flag = settings.red_team_enabled
    original_model = settings.worker_model
    with pytest.raises(RuntimeError):
        with ablations.override_settings(red_team_enabled=False, worker_model="test-model"):
            assert settings.red_team_enabled is False
            assert settings.worker_model == "test-model"
            raise RuntimeError("boom")
    assert settings.red_team_enabled == original_flag
    assert settings.worker_model == original_model


# --- red team on/off ablation (headline) ----------------------------------------------------


def test_red_team_ablation_headline_leaky_result_survives_only_when_red_team_is_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SPEC's red-team-on/off ablation, exercised on M5's own booby-trapped fixture: with the
    gate on, the leaky 0.99 gets invalidated and remediated down to the clean ~0.80 result; with
    settings.red_team_enabled=False, nothing ever audits it and the leaky 0.99 tops the board."""
    _use_stub_everywhere(monkeypatch)
    _fake_leaky(monkeypatch)

    full = run_task("churn_leaky", config_label="full")
    assert full.n_invalidated >= 1
    assert full.primary_metric_value == pytest.approx(0.80)

    with ablations.override_settings(red_team_enabled=False):
        off = run_task("churn_leaky", config_label="no_red_team")
    assert off.n_invalidated == 0
    assert off.primary_metric_value == pytest.approx(0.99)


# --- monolith ablation -----------------------------------------------------------------------


def test_monolith_on_leaky_fixture_reports_the_unaudited_leaky_metric(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SPEC's multi-agent-vs-monolith ablation: the monolith baseline has no cleaner and no red
    team, so drop_columns is always [] (foundry/eval/monolith.py) -- it never learns to drop
    retention_call_outcome and reports the leaky metric as its final, un-audited answer."""
    _use_stub_everywhere(monkeypatch)
    monkeypatch.setattr(monolith_module.sandbox, "run", _fake_leaky_sandbox_run)

    result = run_monolith("churn_leaky")
    assert result.approach == "monolithic"
    assert result.n_invalidated == 0
    assert result.primary_metric_value == pytest.approx(0.99)


# --- model-split vs. uniform projected cost --------------------------------------------------


def test_projected_cost_uniform_is_strictly_cheaper_than_split_for_an_identical_call_mix() -> None:
    calls = {"principal": 3, "red_team": 2, "worker": 5}
    split_roles = {
        "principal": settings.principal_model,
        "red_team": settings.red_team_model,
        "worker": settings.worker_model,
    }
    uniform_roles = dict.fromkeys(split_roles, settings.worker_model)

    split_usd = report._projected_usd(calls, split_roles)
    uniform_usd = report._projected_usd(calls, uniform_roles)

    assert split_usd is not None
    assert uniform_usd is not None
    assert uniform_usd < split_usd


# --- full 5-run matrix + report rendering ----------------------------------------------------


def test_run_task_matrix_produces_the_five_expected_configs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_stub_everywhere(monkeypatch)
    _fake_churn(monkeypatch)

    results = ablations.run_task_matrix("churn")

    assert [r.config for r in results] == [
        "full", "memory_run_2", "no_red_team", "uniform_model", "monolith",
    ]
    assert all(r.dataset_ref == "churn" for r in results)
    assert results[-1].approach == "monolithic"
    assert all(r.approach == "hierarchical" for r in results[:-1])


def test_render_all_has_one_row_per_task_in_every_table(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_stub_everywhere(monkeypatch)
    _fake_churn(monkeypatch)
    results = ablations.run_task_matrix("churn")

    rendered = report.render_all(results)
    assert rendered.count("churn") >= 4  # one appearance per table this dataset appears in
    assert "projected" in rendered.lower()


def test_write_readme_results_replaces_the_marked_region_idempotently(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _use_stub_everywhere(monkeypatch)
    _fake_churn(monkeypatch)
    results = ablations.run_task_matrix("churn")

    readme = tmp_path / "README.md"
    readme.write_text(
        "# before\n\n<!-- BEGIN EVAL RESULTS -->\nstale\n<!-- END EVAL RESULTS -->\n\n# after\n",
        encoding="utf-8",
    )

    report.write_readme_results(str(readme), results)
    first = readme.read_text(encoding="utf-8")
    assert "stale" not in first
    assert "# before" in first
    assert "# after" in first

    report.write_readme_results(str(readme), results)
    second = readme.read_text(encoding="utf-8")
    assert first == second
