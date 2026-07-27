"""Tests for foundry/teams/principal.py. Every code guard runs before any LLM call — proven
here by handing the "LLM" a client that raises if invoked at all, for every guard that should
short-circuit without ever consulting a model."""

from __future__ import annotations

from typing import Any, cast

import pytest
from langgraph.types import Command, Send

from foundry.config import settings
from foundry.models import (
    ApprovalRequest,
    CleaningPlan,
    CostEntry,
    DataProfile,
    ExperimentResult,
    ExperimentSpec,
    HumanDecision,
    HumanResponse,
    LeakageFinding,
    PrincipalDirective,
    RedTeamFinding,
)
from foundry.state import FoundryState
from foundry.teams import principal as principal_module

_PROFILE = DataProfile(
    n_rows=10, n_cols=1, target_column="churned", task_type="binary_classification", columns=[]
)


class _AssertNotCalledLLM:
    costs: list[CostEntry] = []

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        raise AssertionError("LLM should not be consulted once a code guard has fired")


class _FixedDirectiveLLM:
    def __init__(self, directive: PrincipalDirective) -> None:
        self._directive = directive
        self.costs: list[CostEntry] = []

    def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
        return self._directive


class _RecordingAsk:
    """Stands in for foundry.gates.ask (M6) — principal() must never call the real interrupt()
    directly in a unit test (there is no Pregel task context to raise into), so every budget-gate
    test replaces foundry.teams.principal's `gates` module attribute the same way existing tests
    replace `get_llm`."""

    def __init__(self, response: HumanResponse) -> None:
        self.response = response
        self.requests: list[ApprovalRequest] = []

    def __call__(self, request: ApprovalRequest) -> HumanResponse:
        self.requests.append(request)
        return self.response


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


def test_routes_to_data_team_when_no_profile_yet(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    command = principal_module.principal(_state())
    assert command.goto == "data_team"
    assert _update(command)["next_team"] == "data_team"


def test_max_iterations_guard_stops_without_consulting_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    state = _state(data_profile=_PROFILE, iteration_count=settings.principal_max_iterations)
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "max_iterations"


def test_budget_exhausted_guard_stops_without_consulting_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    # spent_usd is derived from costs (see foundry/teams/principal.py), never trusted directly —
    # the stale spent_usd=0.0 below must be ignored in favor of summing costs to 25.0.
    costs = [CostEntry(agent_role="worker", model="m", kind="sandbox", usd=25.0)]
    state = _state(data_profile=_PROFILE, spent_usd=0.0, budget_usd=20.0, costs=costs)
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "budget_exhausted"


def test_target_met_guard_stops_before_consulting_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    result = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.95}, cost_usd=0.1,
        duration_s=1.0,
    )
    # Already audited and cleared — see test_audit_gate_routes_to_red_team_before_target_met for
    # the un-audited case, which must NOT stop here.
    state = _state(
        data_profile=_PROFILE, experiments=[result], audited_experiments=["exp-001"]
    )
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "target_met"


def test_audit_gate_routes_to_red_team_before_target_met(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The milestone's core ordering guarantee: an un-audited result that WOULD satisfy
    target_met must be routed to red_team first, never straight to reporter — otherwise a leaky
    0.99 could end the run before anyone checked it."""
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    result = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.99}, cost_usd=0.1,
        duration_s=1.0,
    )
    state = _state(data_profile=_PROFILE, experiments=[result])
    command = principal_module.principal(state)
    assert command.goto == "red_team"
    assert _update(command)["next_team"] == "red_team"


def test_diminishing_returns_guard_on_experiment_count_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    results = [
        ExperimentResult(
            experiment_id=f"exp-{i:03d}", status="success", metrics={"roc_auc": 0.5},
            cost_usd=0.1, duration_s=1.0,
        )
        for i in range(settings.max_experiments_total)
    ]
    state = _state(
        data_profile=_PROFILE,
        experiments=results,
        audited_experiments=[r.experiment_id for r in results],
    )
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "diminishing_returns"


def test_llm_directive_can_stop_the_loop_before_any_code_cap_is_hit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(
        should_continue=False, stop_reason="diminishing_returns", rationale="enough"
    )
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    command = principal_module.principal(_state(data_profile=_PROFILE))
    assert command.goto == "reporter"
    assert _update(command)["stop_reason"] == "diminishing_returns"


def test_routes_to_experiment_runner_via_send_when_a_spec_is_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=0.01,
    )
    state = _state(data_profile=_PROFILE, experiment_plan=[spec])
    command = principal_module.principal(state)
    assert isinstance(command.goto, list)
    assert len(command.goto) == 1
    assert isinstance(command.goto[0], Send)
    assert command.goto[0].node == "experiment_runner"
    assert command.goto[0].arg["spec"] == spec
    assert command.goto[0].arg["batch_index"] == 0
    assert _update(command)["next_team"] == "modeling_team"


def test_fans_out_one_send_per_pending_spec(monkeypatch: pytest.MonkeyPatch) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    specs = [
        ExperimentSpec(
            experiment_id=f"exp-{i:03d}", model_family="logistic_regression", hyperparams={},
            rationale="r", est_cost_usd=0.01,
        )
        for i in range(3)
    ]
    state = _state(data_profile=_PROFILE, experiment_plan=specs)
    command = principal_module.principal(state)
    assert isinstance(command.goto, list)
    assert len(command.goto) == 3
    assert all(isinstance(send, Send) for send in command.goto)
    sends = cast("list[Send]", command.goto)
    assert all(send.node == "experiment_runner" for send in sends)
    assert [send.arg["spec"].experiment_id for send in sends] == [
        "exp-000", "exp-001", "exp-002",
    ]
    assert [send.arg["batch_index"] for send in sends] == [0, 1, 2]


def test_send_payload_carries_cleaning_plan_and_cv_strategy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from foundry.models import CleaningPlan, CVStrategy

    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=0.01,
    )
    cleaning_plan = CleaningPlan(drop_columns=["customer_id"], rationale="r")
    cv_strategy = CVStrategy(kind="stratified_kfold", n_splits=5, rationale="r")
    state = _state(
        data_profile=_PROFILE,
        experiment_plan=[spec],
        cleaning_plan=cleaning_plan,
        cv_strategy=cv_strategy,
    )
    command = principal_module.principal(state)
    assert isinstance(command.goto, list)
    assert isinstance(command.goto[0], Send)
    payload = cast("Send", command.goto[0]).arg
    assert payload["cleaning_plan"] == cleaning_plan
    assert payload["cv_strategy"] == cv_strategy
    assert payload["dataset_ref"] == "churn"
    assert payload["prior_experiments"] == 0


def test_routes_to_modeling_team_when_plan_is_exhausted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=0.01,
    )
    result = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.5}, cost_usd=0.1,
        duration_s=1.0,
    )
    state = _state(
        data_profile=_PROFILE,
        experiment_plan=[spec],
        experiments=[result],
        audited_experiments=["exp-001"],
    )
    command = principal_module.principal(state)
    assert command.goto == "modeling_team"


def test_spent_usd_is_derived_from_costs_not_stale_state_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression test for the lost-update race M4's Send fan-out would otherwise introduce:
    parallel experiment_runner branches never write state["spent_usd"] directly (see
    foundry/teams/experiment_runner.py) — principal is the sole writer, deriving it fresh from
    state["costs"] (an add-reducer, safe under concurrency) every turn."""
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    costs = [CostEntry(agent_role="worker", model="m", kind="sandbox", usd=25.0)]
    state = _state(data_profile=_PROFILE, spent_usd=0.0, budget_usd=20.0, costs=costs)
    command = principal_module.principal(state)
    assert command.goto == "reporter"
    update = _update(command)
    assert update["stop_reason"] == "budget_exhausted"
    assert update["spent_usd"] == pytest.approx(25.0)


def test_leaderboard_is_recomputed_every_turn_not_only_at_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    result = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.5}, cost_usd=0.1,
        duration_s=1.0,
    )
    state = _state(
        data_profile=_PROFILE, experiments=[result], audited_experiments=["exp-001"]
    )
    command = principal_module.principal(state)
    assert command.goto == "modeling_team"
    board = _update(command)["leaderboard"]
    assert len(board) == 1
    assert board[0].experiment_id == "exp-001"


def test_iteration_count_always_increments(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    command = principal_module.principal(_state(iteration_count=3))
    assert _update(command)["iteration_count"] == 4


def test_invalidated_experiment_is_excluded_from_leaderboard_and_does_not_stop_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A red-team-invalidated 0.99 must not appear on the leaderboard and must not trigger
    target_met — foundry/leaderboard.py's invalidated_ids exclusion, exercised through
    principal."""
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    leaky = ExperimentResult(
        experiment_id="exp-001", status="success", metrics={"roc_auc": 0.99}, cost_usd=0.1,
        duration_s=1.0,
    )
    finding = RedTeamFinding(
        experiment_id="exp-001", category="leakage", verdict="invalidated",
        explanation="e", recommendation="r",
    )
    state = _state(
        data_profile=_PROFILE,
        experiments=[leaky],
        audited_experiments=["exp-001"],
        invalidations=[finding],
    )
    command = principal_module.principal(state)
    update = _update(command)
    assert update["leaderboard"] == []
    # No cleared candidate exists, so the run keeps looping instead of falsely stopping on the
    # invalidated 0.99's target_met — it proceeds to plan another experiment.
    assert command.goto == "modeling_team"


def test_unremediated_high_severity_leak_routes_back_to_data_team(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A high-severity LeakageFinding not yet in cleaning_plan.drop_columns (e.g. one the red
    team just wrote) routes back to data_team for remediation, even though a data_profile
    already exists."""
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    state = _state(
        data_profile=_PROFILE,
        cleaning_plan=CleaningPlan(drop_columns=[], rationale="nothing dropped yet"),
        leakage_findings=[
            LeakageFinding(column="retention_call_outcome", reason="red team", severity="high")
        ],
    )
    command = principal_module.principal(state)
    assert command.goto == "data_team"
    assert _update(command)["next_team"] == "data_team"


def test_budget_gate_fires_on_total_spend_threshold_and_records_the_decision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    recorder = _RecordingAsk(HumanResponse(approved=True, note="looks fine"))
    monkeypatch.setattr(principal_module.gates, "ask", recorder)

    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=1.0,
    )
    # spent (15.5) + projected (1.0) = 16.5, just over 80% of the 20.0 budget (16.0) — and 1.0
    # alone stays well under settings.cost_cap_usd_per_run, isolating the threshold condition.
    costs = [CostEntry(agent_role="worker", model="m", kind="sandbox", usd=15.5)]
    state = _state(data_profile=_PROFILE, experiment_plan=[spec], costs=costs, budget_usd=20.0)

    command = principal_module.principal(state)

    assert len(recorder.requests) == 1
    assert recorder.requests[0].gate == "budget"
    assert "80%" in recorder.requests[0].reason
    update = _update(command)
    assert [d.gate for d in update["human_decisions"]] == ["budget"]
    assert update["human_decisions"][0].approved is True
    assert isinstance(command.goto, list)  # approval falls through to the ordinary fan-out


def test_budget_gate_fires_on_single_run_cost_projection_above_the_per_run_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    recorder = _RecordingAsk(HumanResponse(approved=True))
    monkeypatch.setattr(principal_module.gates, "ask", recorder)

    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="gradient_boosting", hyperparams={},
        rationale="r", est_cost_usd=5.0,  # above settings.cost_cap_usd_per_run (2.0)
    )
    # spent (1.0) is nowhere near 80% of the 20.0 budget — isolates the per-run-cap condition.
    costs = [CostEntry(agent_role="worker", model="m", kind="sandbox", usd=1.0)]
    state = _state(data_profile=_PROFILE, experiment_plan=[spec], costs=costs, budget_usd=20.0)

    command = principal_module.principal(state)

    assert len(recorder.requests) == 1
    assert "per-run cap" in recorder.requests[0].reason
    assert isinstance(command.goto, list)


def test_budget_gate_denial_stops_with_human_declined_without_consulting_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _AssertNotCalledLLM())
    recorder = _RecordingAsk(HumanResponse(approved=False, note="too expensive"))
    monkeypatch.setattr(principal_module.gates, "ask", recorder)

    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=5.0,
    )
    state = _state(data_profile=_PROFILE, experiment_plan=[spec], budget_usd=20.0)

    command = principal_module.principal(state)

    assert command.goto == "reporter"
    update = _update(command)
    assert update["stop_reason"] == "human_declined"
    assert update["human_decisions"][0].approved is False
    assert update["human_decisions"][0].note == "too expensive"


def test_budget_gate_does_not_ask_twice_in_the_same_run(monkeypatch: pytest.MonkeyPatch) -> None:
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    recorder = _RecordingAsk(HumanResponse(approved=True))
    monkeypatch.setattr(principal_module.gates, "ask", recorder)

    spec = ExperimentSpec(
        experiment_id="exp-001", model_family="logistic_regression", hyperparams={},
        rationale="r", est_cost_usd=5.0,  # would trigger the per-run cap on its own
    )
    state = _state(
        data_profile=_PROFILE,
        experiment_plan=[spec],
        budget_usd=20.0,
        human_decisions=[HumanDecision(gate="budget", approved=True, note="already asked")],
    )

    command = principal_module.principal(state)

    assert recorder.requests == []  # never asked again this run
    assert isinstance(command.goto, list)  # proceeded straight to fan-out


def test_remediation_route_clears_once_the_column_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Self-terminating: once cleaning_plan.drop_columns catches up, the same high-severity
    finding no longer routes to data_team — no separate remediation counter is needed."""
    directive = PrincipalDirective(should_continue=True, rationale="keep going")
    monkeypatch.setattr(principal_module, "get_llm", lambda role: _FixedDirectiveLLM(directive))
    state = _state(
        data_profile=_PROFILE,
        cleaning_plan=CleaningPlan(
            drop_columns=["retention_call_outcome"], rationale="dropped after remediation"
        ),
        leakage_findings=[
            LeakageFinding(column="retention_call_outcome", reason="red team", severity="high")
        ],
    )
    command = principal_module.principal(state)
    assert command.goto != "data_team"
