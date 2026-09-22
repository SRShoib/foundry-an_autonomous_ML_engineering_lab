"""Request/response models for app/main.py's HTTP surface. Deliberately separate from
foundry/models.py: these describe the API boundary, not the graph's own structured state — e.g.
RunStatus is a projection of FoundryState plus RunManager's own liveness tracking, never itself
checkpointed."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from foundry.datasets import DatasetSpec
from foundry.models import (
    WIRE_CONFIG,
    DataProfile,
    ExperimentResult,
    LeaderboardEntry,
    PendingSpecCost,
    RedTeamFinding,
)

RunStatusKind = Literal["running", "awaiting_approval", "completed", "failed"]


class StartRunRequest(BaseModel):
    task: str = Field(description="bundled dataset registry key, e.g. 'churn'")
    goal: str | None = None
    budget_usd: float = 20.0


class StartRunResponse(BaseModel):
    model_config = WIRE_CONFIG
    thread_id: str
    status: RunStatusKind


class ResumeRequest(BaseModel):
    approved: bool
    note: str = ""


class PendingApproval(BaseModel):
    model_config = WIRE_CONFIG
    thread_id: str
    gate: Literal["budget", "final"]
    reason: str
    spent_usd: float
    budget_usd: float
    projected_usd: float = 0.0
    best_experiment_id: str | None = None
    best_metric_name: str | None = None
    best_metric_value: float | None = None
    n_invalidated: int = 0
    # M9d: mirrors ApprovalRequest.pending_specs field-for-field — app/runs.py constructs this
    # via PendingApproval(thread_id=thread_id, **payload) straight off the interrupt() value.
    pending_specs: list[PendingSpecCost] = Field(default_factory=list)


class RunStatus(BaseModel):
    model_config = WIRE_CONFIG
    thread_id: str
    status: RunStatusKind
    stop_reason: str | None = None
    spent_usd: float = 0.0
    budget_usd: float = 0.0
    leaderboard: list[LeaderboardEntry] = Field(default_factory=list)
    pending_approval: PendingApproval | None = None
    report_md: str | None = None
    error: str | None = None
    # M9b — what the operator console renders beyond the leaderboard.
    experiments: list[ExperimentResult] = Field(default_factory=list)
    # The FULL audit trail: FoundryState.invalidations holds a `valid` verdict for every audited
    # experiment too, not only the invalidated ones. Consumers must filter on
    # verdict == "invalidated" to count or flag invalidations (PendingApproval.n_invalidated does).
    invalidations: list[RedTeamFinding] = Field(default_factory=list)
    model_card_md: str | None = None
    data_profile: DataProfile | None = None
    cost_by_agent: dict[str, float] = Field(default_factory=dict)
    # M9e: the runs-home table's dataset/goal/updated columns (docs/design-plan.md §6). goal and
    # dataset_ref are already in FoundryState and simply weren't projected before; updated_at is
    # the checkpointer's own StateSnapshot.created_at — the LAST checkpoint's timestamp, i.e. most
    # recent activity, NOT when the run started (recovering a true start time would mean scanning
    # every checkpoint for the thread). Named accordingly rather than as `created_at`.
    goal: str | None = None
    dataset_ref: str | None = None
    updated_at: str | None = None


class DatasetOption(BaseModel):
    """M9e: what the console's start-a-run panel needs to populate its dataset select
    (docs/design-plan.md §6) — deliberately NOT DatasetSpec itself, which carries `path`, a host
    filesystem path the API must never publish."""

    model_config = WIRE_CONFIG
    key: str
    name: str
    task_type: Literal["binary_classification", "multiclass_classification", "regression"]
    primary_metric: Literal["roc_auc", "accuracy", "f1", "rmse"]
    description: str

    @classmethod
    def from_spec(cls, key: str, spec: DatasetSpec) -> DatasetOption:
        return cls(
            key=key,
            name=spec.name,
            task_type=spec.task_type,
            primary_metric=spec.primary_metric,
            description=spec.description,
        )
