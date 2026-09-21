"""Structured types shared across the graph. Every LLM output is one of these, validated by
Pydantic and retried on parse failure (see foundry/llm.py) rather than trusted as free-form text.

The module is split into two groups, marked below:

- LLM-authored: passed to LLMClient.structured(...) and registered with the stub's canned-
  response registry. These are opinions an agent forms — an assessment, a plan, a verdict, a
  code string. list-shaped outputs get a thin wrapper (LeakageReport, ExperimentPlan) since
  structured() returns exactly one BaseModel instance.
- Code-authored: constructed only by tools or graph code, never by an LLM. This includes not
  just raw measurements (SandboxResult, ExperimentResult) but types assembled BY graph code
  FROM an LLM's judgment — e.g. DataProfile is built by foundry/teams/data_team.py out of
  RawProfile (measured) plus ProfileAssessment (judged), but is never itself the schema passed
  to structured(). SPEC's "metrics computed by code, never estimated by an LLM" guardrail.
  Wiring an LLM to one of these via LLMClient.structured(...) fails: the stub registry only
  covers the LLM-authored group.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from foundry.config import settings

# --------------------------------------------------------------------------------------------
# LLM-authored
# --------------------------------------------------------------------------------------------


class LeakageFinding(BaseModel):
    column: str
    reason: str
    severity: Literal["low", "medium", "high"]


class ProfileAssessment(BaseModel):
    """The LLM's judgment about a code-measured RawProfile (foundry/tools/profiler.py):
    task type, and which columns are worth flagging as identifiers/leaks. Never carries
    measurements — n_rows, n_missing, etc. come from RawProfile, not from this model."""

    task_type: Literal["binary_classification", "multiclass_classification", "regression"]
    potential_leak_columns: list[str] = Field(default_factory=list)
    notes: str = ""


class LeakageReport(BaseModel):
    """Wrapper around list[LeakageFinding] — LLMClient.structured() returns exactly one
    BaseModel instance, so a list-shaped LLM output needs a wrapper type (see also
    ExperimentPlan below)."""

    findings: list[LeakageFinding] = Field(default_factory=list)


class CleaningPlan(BaseModel):
    drop_columns: list[str] = Field(default_factory=list)
    numeric_impute: Literal["median", "mean", "most_frequent"] = "median"
    categorical_impute: Literal["most_frequent", "constant"] = "most_frequent"
    rationale: str = ""


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


class ExperimentPlan(BaseModel):
    """Wrapper around list[ExperimentSpec] — see LeakageReport."""

    specs: list[ExperimentSpec] = Field(default_factory=list)


class TrainingCode(BaseModel):
    """The experiment runner's self-debug loop (foundry/teams/experiment_runner.py): the LLM's
    only output is this code string. Metrics never travel through the model — they are parsed
    from the sandbox's stdout by foundry/tools/metrics.py, a pure function over code output."""

    code: str
    reasoning: str = ""


class PrincipalDirective(BaseModel):
    """The principal's LLM-authored judgment call (foundry/teams/principal.py). stop_reason's
    Literal deliberately excludes "budget_exhausted" and "max_iterations" — those are measured
    in code before the LLM is ever consulted, never something an LLM decides."""

    should_continue: bool
    stop_reason: Literal["target_met", "diminishing_returns"] | None = None
    rationale: str = ""
    focus: str = ""


class ReportNarrative(BaseModel):
    """The reporter's LLM-authored prose (foundry/teams/reporter.py). Deliberately has no
    float/int fields: every number in the rendered report comes from ExperimentResult /
    LeaderboardEntry (code-authored), never from this model, so a report number can never be
    LLM-invented — enforced structurally, see tests/test_reporter.py."""

    summary: str
    recommendation: str


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


class ColumnProfile(BaseModel):
    """Assembled by foundry/teams/data_team.py from RawColumnStats (measured) plus the LLM's
    ProfileAssessment (which columns are potential leaks) — never returned directly by
    llm.structured(), so it is never registered in StubClient's schema registry."""

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
    attempts: int = 1  # self-debug attempts consumed (SPEC: "runner self-debug max k=3")
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


class CostEntry(BaseModel):
    """One priced unit of work (M4: "per-agent cost logging"). Never LLM-authored — built by
    foundry/llm.py from real AIMessage.usage_metadata (or the stub's flat rate) and by
    foundry/teams/experiment_runner.py from sandbox duration. spent_usd is the sum of these,
    recomputed by the principal each turn rather than incrementally written by parallel Send
    branches (see foundry/teams/principal.py) — the state field this rolls up into,
    FoundryState.costs, is an add-reducer specifically so concurrent runners can each contribute
    without a lost-update race."""

    agent_role: Literal["principal", "red_team", "worker", "sandbox"]
    model: str
    kind: Literal["llm", "sandbox"]
    input_tokens: int = 0
    output_tokens: int = 0
    usd: float
