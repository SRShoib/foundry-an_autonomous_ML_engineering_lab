"""Top-level graph state (SPEC: State section). TypedDict, not BaseModel — LangGraph nodes
return partial updates keyed against this schema, merged via each field's reducer.

dataset_ref is a path/key only; raw data never enters state (SPEC guardrail).
Fields with a Send-fan-out or add-reducer (SPEC: "Send branches concatenate") use
Annotated[list[X], operator.add] so parallel branch writes accumulate instead of overwriting.
next_team / stop_reason are Literal because they drive the principal's routing decisions
(CLAUDE.md: "Literal types on any field that drives graph routing").
"""

from __future__ import annotations

import operator
from typing import Annotated, Literal

from typing_extensions import TypedDict

from foundry.models import (
    CleaningPlan,
    CostEntry,
    CVStrategy,
    DataProfile,
    ExperimentResult,
    ExperimentSpec,
    HumanDecision,
    LeaderboardEntry,
    LeakageFinding,
    RedTeamFinding,
)

TeamName = Literal["principal", "data_team", "modeling_team", "red_team", "reporter"]
StopReason = Literal["target_met", "budget_exhausted", "diminishing_returns", "max_iterations"]


class FoundryState(TypedDict):
    goal: str
    dataset_ref: str
    budget_usd: float
    spent_usd: float

    data_profile: DataProfile | None
    # Add-reducer (M5): a red_team remediation cycle re-runs data_team, whose profiler/cleaner
    # append a fresh batch of findings on top of the first pass's — a plain overwrite would lose
    # the very leak the first pass already caught while the second pass reconfirms it.
    leakage_findings: Annotated[list[LeakageFinding], operator.add]
    cleaning_plan: CleaningPlan | None
    cv_strategy: CVStrategy | None

    experiment_plan: list[ExperimentSpec]
    experiments: Annotated[list[ExperimentResult], operator.add]
    leaderboard: list[LeaderboardEntry]
    # Add-reducer (M5): every RedTeamFinding the red team has ever rendered (valid or
    # invalidated) — the audit trail foundry/leaderboard.py filters candidates by and
    # foundry/teams/reporter.py renders, never overwritten by a later audit pass.
    invalidations: Annotated[list[RedTeamFinding], operator.add]
    # Add-reducer (M5): experiment_ids the red team has already rendered a verdict for, distinct
    # from `invalidations`' contents so foundry/teams/principal.py can find "audited" in O(1)
    # without re-deriving it from RedTeamFinding.experiment_id every turn.
    audited_experiments: Annotated[list[str], operator.add]

    # Add-reducer (M4): parallel Send-fanned-out experiment_runner branches each contribute their
    # own entries in the same superstep — spent_usd is derived from this sum by the principal
    # rather than being written directly, which would race under concurrent branches.
    costs: Annotated[list[CostEntry], operator.add]

    lessons: Annotated[list[str], operator.add]

    report_md: str | None
    model_card_md: str | None
    human_decisions: Annotated[list[HumanDecision], operator.add]
    errors: Annotated[list[str], operator.add]
    iteration_count: int

    next_team: TeamName | None
    stop_reason: StopReason | None
