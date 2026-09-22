"""Tests for foundry/gates.py (M6). budget_approval_request is a pure predicate/payload builder
— no graph, no checkpointer, no real interrupt() needed, so it's tested directly here rather than
through foundry/teams/principal.py (whose own tests, tests/test_principal.py, cover the gate's
integration into the principal loop). ask() is tested against a monkeypatched
langgraph.types.interrupt to verify its own contract (JSON-safe payload out, validated
HumanResponse in) without needing a compiled graph. final_gate is tested against a stubbed
gates.ask, the same pattern tests/test_principal.py uses for the budget gate — a real interrupt()
call has no Pregel task context to raise into outside a running graph."""

from __future__ import annotations

from typing import Any

import pytest

from foundry import gates as gates_module
from foundry.gates import ask, budget_approval_request, final_gate
from foundry.graph import initial_state
from foundry.models import (
    ApprovalRequest,
    ExperimentResult,
    ExperimentSpec,
    HumanDecision,
    HumanResponse,
    LeaderboardEntry,
    RedTeamFinding,
)
from foundry.state import FoundryState


def _state(**overrides: Any) -> FoundryState:
    state = initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0)
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


def _capturing_ask(
    response: HumanResponse,
) -> tuple[Any, list[ApprovalRequest]]:
    captured: list[ApprovalRequest] = []

    def _ask(request: ApprovalRequest) -> HumanResponse:
        captured.append(request)
        return response

    return _ask, captured


# --- ask() ------------------------------------------------------------------------------------


def test_ask_passes_a_plain_json_dict_to_interrupt_and_validates_the_reply(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def _fake_interrupt(payload: dict[str, Any]) -> dict[str, Any]:
        captured.update(payload)
        return {"approved": True, "note": "ok"}

    monkeypatch.setattr(gates_module, "interrupt", _fake_interrupt)
    request = ApprovalRequest(gate="final", reason="sign-off", spent_usd=2.5, budget_usd=20.0)

    response = ask(request)

    assert captured == request.model_dump(mode="json")
    assert isinstance(response, HumanResponse)
    assert response.approved is True
    assert response.note == "ok"


# --- budget_approval_request --------------------------------------------------------------------


def test_budget_approval_request_returns_none_when_nothing_is_over_threshold() -> None:
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=0.05,
    )
    state = _state(budget_usd=20.0)
    assert budget_approval_request(state, [spec], spent_usd=1.0) is None


def test_budget_approval_request_fires_on_total_spend_threshold() -> None:
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=1.0,
    )
    state = _state(budget_usd=20.0)
    request = budget_approval_request(state, [spec], spent_usd=15.5)
    assert request is not None
    assert request.gate == "budget"
    assert "80%" in request.reason


def test_budget_approval_request_fires_on_per_run_cap() -> None:
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="gradient_boosting", hyperparams={},
        rationale="r", est_cost_usd=5.0,
    )
    state = _state(budget_usd=20.0)
    request = budget_approval_request(state, [spec], spent_usd=1.0)
    assert request is not None
    assert "per-run cap" in request.reason
    assert request.projected_usd == pytest.approx(5.0)


def test_budget_approval_request_floor_beats_a_low_balled_estimate() -> None:
    """The code floor (mean completed cost) can push a projection over the per-run cap even when
    the LLM's own est_cost_usd stays under it — foundry/tools/cost.py's project_run_usd, the
    same "code owns the floor" asymmetry as foundry/teams/red_team.py's _apply_floor."""
    spec = ExperimentSpec(
        experiment_id="exp-002", model_family="mlp", hyperparams={}, rationale="r",
        est_cost_usd=0.01,
    )
    completed = [
        ExperimentResult(experiment_id="exp-001", status="success", cost_usd=3.0, duration_s=1.0)
    ]
    state = _state(budget_usd=20.0, experiments=completed)
    request = budget_approval_request(state, [spec], spent_usd=3.0)
    assert request is not None
    assert "per-run cap" in request.reason
    assert request.projected_usd == pytest.approx(3.0)  # floored at the completed mean, not 0.01
    # M9d: the gate dialog's "pending" row must show the FLOORED number, not the spec's own
    # (low-balled) estimate — design-plan.md §6's "exp-005 lightgbm $2.10" rows.
    assert len(request.pending_specs) == 1
    assert request.pending_specs[0].experiment_id == "exp-002"
    assert request.pending_specs[0].model_family == "mlp"
    assert request.pending_specs[0].projected_cost_usd == pytest.approx(3.0)


def test_budget_approval_request_pending_specs_are_sorted_and_paired_by_id() -> None:
    specs = [
        ExperimentSpec(
            experiment_id="exp-006", model_family="xgboost", hyperparams={}, rationale="r",
            est_cost_usd=2.46,
        ),
        ExperimentSpec(
            experiment_id="exp-005", model_family="lightgbm", hyperparams={}, rationale="r",
            est_cost_usd=2.10,
        ),
    ]
    state = _state(budget_usd=1.0)  # tiny cap: both specs' own estimates already trip it
    request = budget_approval_request(state, specs, spent_usd=0.0)
    assert request is not None
    assert [s.experiment_id for s in request.pending_specs] == ["exp-005", "exp-006"]
    assert [s.model_family for s in request.pending_specs] == ["lightgbm", "xgboost"]
    assert [s.projected_cost_usd for s in request.pending_specs] == [
        pytest.approx(2.10), pytest.approx(2.46),
    ]


def test_budget_approval_request_returns_none_once_already_asked() -> None:
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="gradient_boosting", hyperparams={},
        rationale="r", est_cost_usd=5.0,
    )
    state = _state(
        budget_usd=20.0, human_decisions=[HumanDecision(gate="budget", approved=True)]
    )
    assert budget_approval_request(state, [spec], spent_usd=1.0) is None


# --- final_gate -------------------------------------------------------------------------------


def test_final_gate_approved_appends_signoff_and_records_the_decision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        gates_module, "ask", lambda request: HumanResponse(approved=True, note="ship it")
    )
    state = _state(report_md="# report", stop_reason="target_met")

    update = final_gate(state)

    decisions = update["human_decisions"]
    assert len(decisions) == 1
    assert decisions[0].gate == "final"
    assert decisions[0].approved is True
    assert decisions[0].note == "ship it"
    assert update["report_md"].startswith("# report")
    assert "## Sign-off" in update["report_md"]
    assert "**APPROVED**" in update["report_md"]
    assert "ship it" in update["report_md"]


def test_final_gate_declined_marks_the_report_declined(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        gates_module, "ask", lambda request: HumanResponse(approved=False, note="not ready")
    )
    state = _state(report_md="# report", stop_reason="diminishing_returns")

    update = final_gate(state)

    assert update["human_decisions"][0].approved is False
    assert "**DECLINED**" in update["report_md"]
    assert "not ready" in update["report_md"]


def test_final_gate_request_carries_the_winning_experiment(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_ask, captured = _capturing_ask(HumanResponse(approved=True))
    monkeypatch.setattr(gates_module, "ask", fake_ask)
    board = [
        LeaderboardEntry(
            experiment_id="exp-007", mlflow_run_id="run-1", primary_metric_name="roc_auc",
            primary_metric_value=0.87, rank=1,
        )
    ]
    finding = RedTeamFinding(
        experiment_id="exp-999", category="leakage", verdict="invalidated", explanation="e",
        recommendation="r",
    )
    state = _state(
        leaderboard=board, invalidations=[finding], report_md="# r", stop_reason="target_met"
    )

    final_gate(state)

    assert len(captured) == 1
    request = captured[0]
    assert request.gate == "final"
    assert request.best_experiment_id == "exp-007"
    assert request.best_metric_name == "roc_auc"
    assert request.best_metric_value == pytest.approx(0.87)
    assert request.n_invalidated == 1


def test_final_gate_with_no_cleared_experiments_has_no_winning_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_ask, captured = _capturing_ask(HumanResponse(approved=False))
    monkeypatch.setattr(gates_module, "ask", fake_ask)
    state = _state(leaderboard=[], report_md="", stop_reason="diminishing_returns")

    final_gate(state)

    assert captured[0].best_experiment_id is None
