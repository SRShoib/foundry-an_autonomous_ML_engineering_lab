"""Tests for foundry/state.py. Proves the SPEC "Send branches concatenate" requirement is wired
correctly on every add-reducer field, without needing the graph itself (which doesn't exist
until M3)."""

from __future__ import annotations

import operator
from typing import get_args, get_type_hints

from foundry.models import (
    CostEntry,
    ExperimentResult,
    HumanDecision,
    LeakageFinding,
    RedTeamFinding,
)
from foundry.state import FoundryState


def _reducer(field: str) -> object:
    hints = get_type_hints(FoundryState, include_extras=True)
    _, reducer = get_args(hints[field])
    return reducer


def test_experiments_field_uses_add_reducer_and_concatenates() -> None:
    reducer = _reducer("experiments")
    assert reducer is operator.add

    left = [ExperimentResult(experiment_id="a", status="success", cost_usd=0.1, duration_s=1.0)]
    right = [ExperimentResult(experiment_id="b", status="success", cost_usd=0.2, duration_s=2.0)]
    merged = reducer(left, right)  # type: ignore[operator]
    assert [r.experiment_id for r in merged] == ["a", "b"]


def test_errors_and_lessons_use_add_reducer_and_concatenate() -> None:
    for field in ("errors", "lessons"):
        reducer = _reducer(field)
        assert reducer is operator.add
        assert reducer(["x"], ["y"]) == ["x", "y"]  # type: ignore[operator]


def test_human_decisions_use_add_reducer_and_concatenate() -> None:
    reducer = _reducer("human_decisions")
    assert reducer is operator.add

    left = [HumanDecision(gate="budget", approved=True)]
    right = [HumanDecision(gate="final", approved=False)]
    merged = reducer(left, right)  # type: ignore[operator]
    assert [d.gate for d in merged] == ["budget", "final"]


def test_costs_field_uses_add_reducer_and_concatenates() -> None:
    reducer = _reducer("costs")
    assert reducer is operator.add

    left = [CostEntry(agent_role="worker", model="m", kind="llm", usd=0.01)]
    right = [CostEntry(agent_role="sandbox", model="sandbox", kind="sandbox", usd=0.02)]
    merged = reducer(left, right)  # type: ignore[operator]
    assert [c.agent_role for c in merged] == ["worker", "sandbox"]


def test_leakage_findings_field_uses_add_reducer_and_concatenates() -> None:
    """M5: a remediation re-run's fresh findings must accumulate on top of a prior pass's,
    not overwrite them — see foundry/teams/red_team.py's module docstring."""
    reducer = _reducer("leakage_findings")
    assert reducer is operator.add

    left = [LeakageFinding(column="a", reason="r", severity="low")]
    right = [LeakageFinding(column="b", reason="r", severity="high")]
    merged = reducer(left, right)  # type: ignore[operator]
    assert [f.column for f in merged] == ["a", "b"]


def test_invalidations_and_audited_experiments_use_add_reducer_and_concatenate() -> None:
    reducer = _reducer("invalidations")
    assert reducer is operator.add
    left = [
        RedTeamFinding(
            experiment_id="exp-001", category="leakage", verdict="invalidated",
            explanation="e", recommendation="r",
        )
    ]
    right = [
        RedTeamFinding(
            experiment_id="exp-002", category="leakage", verdict="valid",
            explanation="e", recommendation="r",
        )
    ]
    merged = reducer(left, right)  # type: ignore[operator]
    assert [f.experiment_id for f in merged] == ["exp-001", "exp-002"]

    reducer = _reducer("audited_experiments")
    assert reducer is operator.add
    assert reducer(["exp-001"], ["exp-002"]) == ["exp-001", "exp-002"]  # type: ignore[operator]


def test_dataset_ref_holds_a_reference_not_raw_data() -> None:
    state: FoundryState = {
        "goal": "predict churn",
        "dataset_ref": "s3://bucket/churn.csv",
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
    assert isinstance(state["dataset_ref"], str)
    assert state["next_team"] is None
