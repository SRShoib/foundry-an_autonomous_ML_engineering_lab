"""Structured types shared across the graph. Every LLM output is one of these, validated by
Pydantic and retried on parse failure (see foundry/llm.py) rather than trusted as free-form text.

The module is split into two groups, marked below:

- LLM-authored: passed to LLMClient.structured(...) and registered with the stub's canned-
  response registry. These are opinions an agent forms — a profile, a plan, a verdict.
- Code-authored: constructed only by tools or graph code, never by an LLM. In particular
  ExperimentResult carries metrics computed by the sandbox, never estimated by a model — SPEC's
  "metrics computed by code, never estimated by an LLM" guardrail. Wiring an LLM to one of these
  via LLMClient.structured(...) fails: the stub registry only covers the LLM-authored group.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from foundry.config import settings

# --------------------------------------------------------------------------------------------
# LLM-authored
# --------------------------------------------------------------------------------------------


class ColumnProfile(BaseModel):
    name: str
    dtype: str
    n_missing: int
    pct_missing: float
    n_unique: int
    is_potential_leak: bool = False


class DataProfile(BaseModel):
    n_rows: int
    n_cols: int
    target_column: str
    task_type: Literal["binary_classification", "multiclass_classification", "regression"]
    columns: list[ColumnProfile]
    notes: str = ""


class LeakageFinding(BaseModel):
    column: str
    reason: str
    severity: Literal["low", "medium", "high"]


class CVStrategy(BaseModel):
    kind: Literal["stratified_kfold", "kfold", "group_kfold", "time_series_split"]
    n_splits: int
    group_column: str | None = None
    rationale: str


class ExperimentSpec(BaseModel):
    experiment_id: str
    model_family: Literal[
        "logistic_regression",
        "random_forest",
        "gradient_boosting",
        "xgboost",
        "lightgbm",
        "mlp",
    ]
    hyperparams: dict[str, float | int | str | bool]
    rationale: str
    est_cost_usd: float


class RedTeamFinding(BaseModel):
    experiment_id: str
    category: Literal[
        "leakage",
        "contamination",
        "improper_cv",
        "validation_overfitting",
        "seed_hacking",
    ]
    verdict: Literal["valid", "invalidated"]
    explanation: str
    recommendation: str


# --------------------------------------------------------------------------------------------
# Code-authored — never produced by an LLM
# --------------------------------------------------------------------------------------------


class SandboxLimits(BaseModel):
    memory: str = Field(default_factory=lambda: settings.sandbox_memory_limit)
    cpus: float = Field(default_factory=lambda: settings.sandbox_cpu_limit)
    pids: int = Field(default_factory=lambda: settings.sandbox_pids_limit)
    timeout_seconds: int = Field(default_factory=lambda: settings.sandbox_timeout_seconds)


class SandboxResult(BaseModel):
    stdout: str
    stderr: str
    exit_code: int | None
    duration_s: float
    timed_out: bool
    artifacts: dict[str, bytes] = Field(default_factory=dict)


class ExperimentResult(BaseModel):
    experiment_id: str
    mlflow_run_id: str | None = None
    status: Literal["success", "failed", "invalidated"]
    metrics: dict[str, float] = Field(default_factory=dict)
    cost_usd: float
    duration_s: float
    error: str | None = None


class LeaderboardEntry(BaseModel):
    experiment_id: str
    mlflow_run_id: str | None
    primary_metric_name: str
    primary_metric_value: float
    rank: int


class HumanDecision(BaseModel):
    gate: Literal["budget", "final"]
    approved: bool
    note: str = ""
    timestamp: datetime = Field(default_factory=datetime.now)
