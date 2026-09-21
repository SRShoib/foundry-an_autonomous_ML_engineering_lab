"""Request/response models for app/main.py's HTTP surface. Deliberately separate from
foundry/models.py: these describe the API boundary, not the graph's own structured state — e.g.
RunStatus is a projection of FoundryState plus RunManager's own liveness tracking, never itself
checkpointed."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from foundry.models import LeaderboardEntry

RunStatusKind = Literal["running", "awaiting_approval", "completed", "failed"]


class StartRunRequest(BaseModel):
    task: str = Field(description="bundled dataset registry key, e.g. 'churn'")
    goal: str | None = None
    budget_usd: float = 20.0


class StartRunResponse(BaseModel):
    thread_id: str
    status: RunStatusKind


class ResumeRequest(BaseModel):
    approved: bool
    note: str = ""


class PendingApproval(BaseModel):
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


class RunStatus(BaseModel):
    thread_id: str
    status: RunStatusKind
    stop_reason: str | None = None
    spent_usd: float = 0.0
    budget_usd: float = 0.0
    leaderboard: list[LeaderboardEntry] = Field(default_factory=list)
    pending_approval: PendingApproval | None = None
    report_md: str | None = None
    error: str | None = None
