"""Tests for foundry/teams/red_team.py. audit_tool.audit is monkeypatched everywhere so these
never touch Docker — the real sandbox integration is proven in tests/test_audit.py under
@pytest.mark.docker. The headline test is `test_adjudicator_...hostile_always_valid_llm`: it
hands the adjudicator an LLM that always says "valid" and proves the code floor invalidates
anyway — the milestone's core guarantee that a model can never talk a leaky experiment past the
gate.
"""

from __future__ import annotations

from typing import Any, cast, get_type_hints

import pytest

from foundry.models import ExperimentResult, LeakageFinding, RedTeamFinding, RedTeamVerdict
from foundry.state import FoundryState
from foundry.teams import red_team
from foundry.teams.red_team import (
    RED_TEAM_INPUT_KEYS,
    RED_TEAM_OUTPUT_KEYS,
    RedTeamState,
    _apply_floor,
    _worst_column,
    adjudicator,
    evidence_collector,
    pending_candidates,
    red_team_node,
)
from foundry.tools.audit import AuditColumnStat, AuditError, AuditReport


class _FixedVerdictLLM:
    def __init__(self, verdict: RedTeamVerdict) -> None:
        self._verdict = verdict
        self.costs: list[Any] = []

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        return self._verdict


def _always_valid() -> _FixedVerdictLLM:
    """A hostile/permissive LLM: always says "valid", regardless of the evidence it's shown."""
    return _FixedVerdictLLM(
        RedTeamVerdict(
            verdict="valid",
            category="validation_overfitting",
            explanation="looks fine to me",
            recommendation="no action needed",
        )
    )


def _result(experiment_id: str, roc_auc: float = 0.8, status: str = "success") -> ExperimentResult:
    return ExperimentResult(
        experiment_id=experiment_id,
        status=status,  # type: ignore[arg-type]
        metrics={"roc_auc": roc_auc} if status == "success" else {},
        cost_usd=0.1,
        duration_s=1.0,
    )


def _red_team_state(**overrides: Any) -> RedTeamState:
    state: RedTeamState = {
        "dataset_ref": "churn_leaky",
        "cleaning_plan": None,
        "cv_strategy": None,
        "pending": [],
        "audit_report": None,
        "invalidations": [],
        "audited_experiments": [],
        "leakage_findings": [],
        "errors": [],
        "costs": [],
    }
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


def _clean_report() -> AuditReport:
    return AuditReport(
        dataset_name="churn.csv",
        n_rows=1200,
        n_cols=2,
        target_column="churned",
        columns=[
            AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.3),
            AuditColumnStat(name="contract_type", is_numeric=False, target_auc=0.4),
        ],
        duplicate_row_count=0,
        duplicate_row_rate=0.0,
    )


def _leaky_report() -> AuditReport:
    return AuditReport(
        dataset_name="churn_leaky.csv",
        n_rows=300,
        n_cols=2,
        target_column="churned",
        columns=[
            AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.3),
            AuditColumnStat(name="retention_call_outcome", is_numeric=False, target_auc=0.9962),
        ],
        duplicate_row_count=0,
        duplicate_row_rate=0.0,
    )


# --- pending_candidates -----------------------------------------------------------------------


def test_pending_candidates_filters_to_successful_and_unaudited() -> None:
    results = [
        _result("exp-001", 0.8),
        _result("exp-002", status="failed"),
        _result("exp-003", 0.7),
    ]
    pending = pending_candidates(results, frozenset({"exp-003"}))
    assert [r.experiment_id for r in pending] == ["exp-001"]


# --- _worst_column -----------------------------------------------------------------------------


def test_worst_column_picks_the_highest_measured_auc() -> None:
    name, auc = _worst_column(_leaky_report())
    assert name == "retention_call_outcome"
    assert auc == pytest.approx(0.9962)


def test_worst_column_returns_none_when_nothing_measured() -> None:
    report = AuditReport(
        dataset_name="d", n_rows=10, n_cols=1, target_column="y",
        columns=[AuditColumnStat(name="a", is_numeric=True, target_auc=None)],
        duplicate_row_count=0, duplicate_row_rate=0.0,
    )
    assert _worst_column(report) == (None, None)


# --- _apply_floor: the code floor itself --------------------------------------------------------


def _verdict(verdict: str = "valid", category: str = "validation_overfitting") -> RedTeamVerdict:
    return RedTeamVerdict(
        verdict=verdict, category=category, explanation="e", recommendation="r"  # type: ignore[arg-type]
    )


def test_apply_floor_leaves_an_already_invalidated_verdict_untouched() -> None:
    original = _verdict(verdict="invalidated", category="seed_hacking")
    result = _apply_floor(
        original, leak=True, leak_column="x", leak_auc=0.99, contamination=True,
        metric_implausible=True,
    )
    assert result == original


def test_apply_floor_forces_invalidation_on_leak_evidence_regardless_of_the_llm() -> None:
    result = _apply_floor(
        _verdict(), leak=True, leak_column="retention_call_outcome", leak_auc=0.9962,
        contamination=False, metric_implausible=False,
    )
    assert result.verdict == "invalidated"
    assert result.category == "leakage"
    assert "retention_call_outcome" in result.recommendation


def test_apply_floor_forces_invalidation_on_contamination_evidence() -> None:
    result = _apply_floor(
        _verdict(), leak=False, leak_column=None, leak_auc=None, contamination=True,
        metric_implausible=False,
    )
    assert result.verdict == "invalidated"
    assert result.category == "contamination"


def test_apply_floor_forces_invalidation_on_an_implausible_metric() -> None:
    result = _apply_floor(
        _verdict(), leak=False, leak_column=None, leak_auc=None, contamination=False,
        metric_implausible=True,
    )
    assert result.verdict == "invalidated"
    assert result.category == "validation_overfitting"


def test_apply_floor_leaves_a_valid_verdict_alone_when_no_evidence_fires() -> None:
    original = _verdict()
    result = _apply_floor(
        original, leak=False, leak_column=None, leak_auc=None, contamination=False,
        metric_implausible=False,
    )
    assert result == original


# --- evidence_collector --------------------------------------------------------------------------


def test_evidence_collector_skips_the_sandbox_when_nothing_is_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*args: Any, **kwargs: Any) -> AuditReport:
        raise AssertionError("audit should not run when there is nothing to audit")

    monkeypatch.setattr(red_team.audit_tool, "audit", _boom)
    update = evidence_collector(_red_team_state(pending=[]))
    assert update == {"audit_report": None}


def test_evidence_collector_records_an_error_when_the_sandbox_audit_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _raise(*args: Any, **kwargs: Any) -> AuditReport:
        raise AuditError("sandbox exploded")

    monkeypatch.setattr(red_team.audit_tool, "audit", _raise)
    update = evidence_collector(_red_team_state(pending=[_result("exp-001")]))
    assert update["audit_report"] is None
    assert "sandbox audit failed" in update["errors"][0]  # type: ignore[index]


def test_evidence_collector_returns_the_report_when_something_is_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report = _clean_report()
    monkeypatch.setattr(red_team.audit_tool, "audit", lambda dataset, cleaning_plan, **kw: report)
    update = evidence_collector(_red_team_state(pending=[_result("exp-001")]))
    assert update == {"audit_report": report}


# --- adjudicator: the milestone's headline guarantee ---------------------------------------------


def test_adjudicator_invalidates_the_leak_even_with_a_hostile_always_valid_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The booby trap. audit evidence measures a categorical leak column at 0.9962 target-
    association AUC — clearing audit_leak_auc_threshold — and the "LLM" always says valid. The
    code floor must invalidate anyway."""
    monkeypatch.setattr(red_team, "get_llm", lambda role: _always_valid())
    pending = [_result("exp-001", roc_auc=0.99)]
    state = _red_team_state(pending=pending, audit_report=_leaky_report())

    update = adjudicator(state)

    findings = cast("list[RedTeamFinding]", update["invalidations"])
    assert len(findings) == 1
    assert findings[0].experiment_id == "exp-001"
    assert findings[0].verdict == "invalidated"
    assert findings[0].category == "leakage"
    assert update["audited_experiments"] == ["exp-001"]

    leak_findings = cast("list[LeakageFinding]", update["leakage_findings"])
    assert len(leak_findings) == 1
    assert leak_findings[0].column == "retention_call_outcome"
    assert leak_findings[0].severity == "high"


def test_adjudicator_does_not_invalidate_clean_evidence_even_with_a_permissive_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No false positives: clean audit evidence + a plausible metric must stay valid."""
    monkeypatch.setattr(red_team, "get_llm", lambda role: _always_valid())
    pending = [_result("exp-001", roc_auc=0.85)]
    state = _red_team_state(
        dataset_ref="churn", pending=pending, audit_report=_clean_report()
    )

    update = adjudicator(state)

    findings = cast("list[RedTeamFinding]", update["invalidations"])
    assert len(findings) == 1
    assert findings[0].verdict == "valid"
    assert "leakage_findings" not in update
    assert update["audited_experiments"] == ["exp-001"]


def test_adjudicator_returns_empty_update_when_nothing_pending() -> None:
    assert adjudicator(_red_team_state(pending=[])) == {}


# --- red_team_node wrapper -----------------------------------------------------------------------


def test_output_keys_are_a_subset_of_both_schemas() -> None:
    parent_hints = get_type_hints(FoundryState)
    sub_hints = get_type_hints(RedTeamState)
    assert set(RED_TEAM_OUTPUT_KEYS) <= set(parent_hints)
    assert set(RED_TEAM_OUTPUT_KEYS) <= set(sub_hints)
    assert set(RED_TEAM_INPUT_KEYS) <= set(parent_hints)


def _foundry_state(**overrides: Any) -> FoundryState:
    state: FoundryState = {
        "goal": "predict churn",
        "dataset_ref": "churn_leaky",
        "budget_usd": 20.0,
        "spent_usd": 0.0,
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": None,
        "cv_strategy": None,
        "approach_memo": None,
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


def test_red_team_node_populates_all_output_keys_and_reaches_the_hostile_llm_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        red_team.audit_tool, "audit", lambda dataset, cleaning_plan, **kw: _leaky_report()
    )
    monkeypatch.setattr(red_team, "get_llm", lambda role: _always_valid())

    result = _result("exp-001", roc_auc=0.99)
    state = _foundry_state(experiments=[result])

    command = red_team_node(state)
    assert command.goto == "principal"
    assert isinstance(command.update, dict)
    update = command.update
    for key in RED_TEAM_OUTPUT_KEYS:
        assert key in update

    assert update["audited_experiments"] == ["exp-001"]
    findings = cast("list[RedTeamFinding]", update["invalidations"])
    assert findings[0].verdict == "invalidated"


def test_red_team_node_only_audits_experiments_not_already_audited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*args: Any, **kwargs: Any) -> AuditReport:
        raise AssertionError("audit should not run when everything is already audited")

    def _boom_llm(role: str) -> Any:
        raise AssertionError("the red_team LLM should not be consulted for an audited experiment")

    monkeypatch.setattr(red_team.audit_tool, "audit", _boom)
    monkeypatch.setattr(red_team, "get_llm", _boom_llm)

    result = _result("exp-001", roc_auc=0.8)
    state = _foundry_state(experiments=[result], audited_experiments=["exp-001"])

    command = red_team_node(state)
    assert isinstance(command.update, dict)
    assert command.update["invalidations"] == []
    assert command.update["audited_experiments"] == []
