"""Tests for foundry/teams/reporter.py. Every number in the rendered report/card comes from
ExperimentResult/LeaderboardEntry/CostEntry (code-authored) — render_report/render_model_card
are tested directly against a fixed ReportNarrative, with no LLM involved except in the one
node-level test. rank_experiments itself lives in foundry/leaderboard.py and is tested there;
reporter now reads state["leaderboard"] rather than computing it (foundry/teams/principal.py
owns that computation as of M4)."""

from __future__ import annotations

from typing import Any, Literal, cast

import pytest

from foundry.leaderboard import rank_experiments
from foundry.models import (
    CostEntry,
    CVStrategy,
    ExperimentResult,
    RedTeamFinding,
    ReportNarrative,
)
from foundry.state import FoundryState
from foundry.teams import reporter as reporter_module
from foundry.teams.reporter import cost_by_agent, render_model_card, render_report


def _state(**overrides: Any) -> FoundryState:
    state: FoundryState = {
        "goal": "predict churn",
        "dataset_ref": "churn",
        "budget_usd": 20.0,
        "spent_usd": 0.5,
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": None,
        "cv_strategy": CVStrategy(
            kind="stratified_kfold", n_splits=5, rationale="balanced classes"
        ),
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
        "iteration_count": 6,
        "next_team": None,
        "stop_reason": "diminishing_returns",
    }
    state.update(overrides)  # type: ignore[typeddict-item]
    return state


def _result(
    experiment_id: str,
    roc_auc: float,
    status: Literal["success", "failed"] = "success",
) -> ExperimentResult:
    return ExperimentResult(
        experiment_id=experiment_id,
        status=status,
        metrics={"roc_auc": roc_auc} if status == "success" else {},
        cost_usd=0.1,
        duration_s=1.0,
        attempts=1,
        error=None if status == "success" else "boom",
    )


def _cost(
    agent_role: Literal["principal", "red_team", "worker", "sandbox"], usd: float
) -> CostEntry:
    return CostEntry(agent_role=agent_role, model="m", kind="llm", usd=usd)


def test_render_report_contains_every_experiment_and_its_code_computed_metric() -> None:
    results = [_result("exp-001", 0.8520), _result("exp-002", 0.8251)]
    board = rank_experiments(results, "roc_auc")
    narrative = ReportNarrative(summary="a run happened", recommendation="promote exp-001")
    state = _state(experiments=results, leaderboard=board)

    report = render_report(state, narrative, board, spent_usd=1.23)
    assert "exp-001" in report
    assert "exp-002" in report
    assert "0.8520" in report
    assert "0.8251" in report
    assert "diminishing_returns" in report
    assert "1.2300" in report


def test_render_report_cites_mlflow_run_ids() -> None:
    result = _result("exp-001", 0.9).model_copy(update={"mlflow_run_id": "run-abc123"})
    board = rank_experiments([result], "roc_auc")
    narrative = ReportNarrative(summary="s", recommendation="r")
    report = render_report(_state(experiments=[result]), narrative, board, spent_usd=0.1)
    assert "run-abc123" in report


def test_render_report_lists_errors_when_present() -> None:
    narrative = ReportNarrative(summary="s", recommendation="r")
    state = _state(errors=["profiler: sandbox profiling failed: boom"])
    report = render_report(state, narrative, [], spent_usd=0.0)
    assert "sandbox profiling failed" in report


def test_cost_by_agent_sums_per_role() -> None:
    totals = cost_by_agent([_cost("worker", 0.01), _cost("worker", 0.02), _cost("principal", 0.5)])
    assert totals == {"worker": 0.03, "principal": 0.5}


def test_render_report_includes_cost_by_agent_section() -> None:
    narrative = ReportNarrative(summary="s", recommendation="r")
    state = _state(costs=[_cost("worker", 0.03), _cost("principal", 0.5)])
    report = render_report(state, narrative, [], spent_usd=0.53)
    assert "## Cost by agent" in report
    assert "worker" in report
    assert "principal" in report


def test_render_model_card_names_the_winning_family_and_cv_protocol() -> None:
    results = [_result("exp-001", 0.8520)]
    board = rank_experiments(results, "roc_auc")
    narrative = ReportNarrative(summary="s", recommendation="promote it")
    state = _state(experiments=results)

    card = render_model_card(state, narrative, board[0])
    assert "exp-001" in card
    assert "0.8520" in card
    assert "stratified_kfold" in card
    assert "balanced classes" in card


def test_render_model_card_handles_no_successful_experiment() -> None:
    narrative = ReportNarrative(summary="s", recommendation="investigate")
    card = render_model_card(_state(), narrative, None)
    assert "No successful experiment" in card


def test_reporter_node_returns_report_and_model_card_citing_state_leaderboard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FixedLLM:
        costs: list[CostEntry] = []

        def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
            return ReportNarrative(summary="ran things", recommendation="ship exp-001")

    monkeypatch.setattr(reporter_module, "get_llm", lambda role: _FixedLLM())
    results = [_result("exp-001", 0.85)]
    board = rank_experiments(results, "roc_auc")
    update = reporter_module.reporter(_state(experiments=results, leaderboard=board))
    assert update["report_md"]
    assert update["model_card_md"]
    assert "exp-001" in cast(str, update["report_md"])
    assert "leaderboard" not in update  # principal owns leaderboard; reporter only reads it


def test_reporter_tops_up_spent_usd_with_its_own_llm_cost(monkeypatch: pytest.MonkeyPatch) -> None:
    """reporter runs strictly after principal's last turn, so its own LLM call's cost is not
    yet in state["costs"] — it must fold that cost into the spent_usd it returns, since nothing
    downstream will ever recompute spent_usd again."""

    class _FixedLLM:
        def __init__(self) -> None:
            self.costs = [_cost("worker", 0.02)]

        def structured(self, prompt: str, schema: type, *, system: str | None = None) -> Any:
            return ReportNarrative(summary="s", recommendation="r")

    monkeypatch.setattr(reporter_module, "get_llm", lambda role: _FixedLLM())
    state = _state(costs=[_cost("worker", 0.10)])
    update = reporter_module.reporter(state)
    assert update["spent_usd"] == pytest.approx(0.12)
    assert "0.1200" in cast(str, update["report_md"])


def _finding(
    experiment_id: str, verdict: Literal["valid", "invalidated"] = "invalidated"
) -> RedTeamFinding:
    return RedTeamFinding(
        experiment_id=experiment_id,
        category="leakage",
        verdict=verdict,
        explanation="target-association AUC clears the threshold",
        recommendation="drop the column and retrain",
    )


def test_render_report_lists_red_team_findings_when_present() -> None:
    narrative = ReportNarrative(summary="s", recommendation="r")
    state = _state(invalidations=[_finding("exp-001")])
    report = render_report(state, narrative, [], spent_usd=0.0)
    assert "## Red team findings" in report
    assert "exp-001" in report
    assert "invalidated" in report


def test_render_report_omits_red_team_section_when_no_findings() -> None:
    narrative = ReportNarrative(summary="s", recommendation="r")
    report = render_report(_state(), narrative, [], spent_usd=0.0)
    assert "## Red team findings" not in report


def test_render_model_card_notes_the_winner_is_red_team_cleared() -> None:
    results = [_result("exp-001", 0.8520)]
    board = rank_experiments(results, "roc_auc")
    narrative = ReportNarrative(summary="s", recommendation="promote it")
    state = _state(experiments=results)

    card = render_model_card(state, narrative, board[0])
    assert "Red team" in card
    assert "cleared" in card


def test_render_model_card_distinguishes_all_invalidated_from_no_success() -> None:
    narrative = ReportNarrative(summary="s", recommendation="investigate")
    state = _state(invalidations=[_finding("exp-001")])
    card = render_model_card(state, narrative, None)
    assert "invalidated" in card
    assert "No successful experiment produced a model." not in card
