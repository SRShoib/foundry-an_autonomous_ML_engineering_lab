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

from pydantic import BaseModel, ConfigDict, Field

from foundry.config import settings

# M9b: the API serializes every field of a response model, defaults included, so the OpenAPI schema
# for a model it RETURNS must mark them required — otherwise the operator console's generated
# TypeScript types call always-present fields optional and every component guards against an
# `undefined` that cannot happen. Applied only to models the API returns: a request body's
# defaults genuinely are optional, and validation-mode schemas (LLM structured output) are
# unaffected. tests/test_openapi.py asserts no response schema is left with optional fields.
WIRE_CONFIG = ConfigDict(json_schema_serialization_defaults_required=True)


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


_ModelFamily = Literal[
    "logistic_regression", "random_forest", "gradient_boosting", "xgboost", "lightgbm", "mlp"
]


class ApproachMemo(BaseModel):
    """The literature scout's LLM-authored judgment (foundry/teams/modeling_team.py, M7) over
    what foundry/tools/memory.py's search() returned for this dataset. recommended_families/
    avoid_families reuse ExperimentSpec.model_family's own Literal so a scout can never recommend
    a family experiment_planner isn't allowed to plan in the first place; the code guard in
    literature_scout still re-filters both against SUPPORTED_MODEL_FAMILIES (installed in the
    sandbox image) before trusting them, the same "LLM proposes, code disposes" split
    experiment_planner already applies to ExperimentPlan.specs."""

    summary: str
    recommended_families: list[_ModelFamily] = Field(default_factory=list)
    avoid_families: list[_ModelFamily] = Field(default_factory=list)
    cautions: str = ""


class LessonDraft(BaseModel):
    """The lesson-writer's LLM-authored prose (foundry/teams/lessons.py, M7). Deliberately has no
    numeric fields — the same structural guarantee ReportNarrative and RedTeamVerdict already
    carry — so a persisted Lesson's best_model_family/best_metric_value (see Lesson below) can
    only ever come from foundry/leaderboard.py's own computation, never from the model's telling
    of it."""

    text: str


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


RedTeamCategory = Literal[
    "leakage",
    "contamination",
    "improper_cv",
    "validation_overfitting",
    "seed_hacking",
]


class RedTeamVerdict(BaseModel):
    """The red team's LLM-authored judgment (foundry/teams/red_team.py) over one
    AuditReport-backed candidate. Deliberately carries no numeric fields — same rule as
    ReportNarrative — so a verdict can never smuggle a metric the audit tool didn't itself
    measure. foundry/teams/red_team.py's code floor can force verdict="invalidated" past what
    this model returns, but never the reverse: the LLM can invalidate on judgment alone even
    when no code threshold fired (SPEC: "adversarial auditor... can mark an experiment
    INVALIDATED"), it just cannot talk its way past one that did."""

    verdict: Literal["valid", "invalidated"]
    category: RedTeamCategory
    explanation: str
    recommendation: str


class AuditEvidence(BaseModel):
    """M9d: the code-measured numbers behind one RedTeamFinding, carried as real fields rather
    than embedded in `explanation` prose — CLAUDE.md's "metrics computed by code, never estimated
    by an LLM" applies to what the operator console renders too. Built from the same
    foundry/tools/audit.py AuditReport (via foundry/teams/red_team.py's RedTeamContext) that
    `_apply_floor` already reads; attached to every finding a pass produces, `valid` verdicts
    included, since the measurement is what justifies a clearing verdict too. `worst_column` /
    `worst_column_target_auc` are None only when the audit found no column with a measurable
    target association (foundry/tools/audit.py: a non-numeric multiclass target has no median
    split, so every column's target_auc stays None)."""

    model_config = WIRE_CONFIG

    worst_column: str | None = None
    worst_column_target_auc: float | None = None
    duplicate_row_rate: float
    reported_metric_name: str
    reported_metric_value: float


class RedTeamFinding(BaseModel):
    """Code-assembled record (foundry/teams/red_team.py) of one RedTeamVerdict plus the
    experiment_id it was rendered against — the unit foundry/state.py's `invalidations`
    add-reducer accumulates, and what foundry/leaderboard.py filters leaderboard candidates by."""

    model_config = WIRE_CONFIG


    experiment_id: str
    category: RedTeamCategory
    verdict: Literal["valid", "invalidated"]
    explanation: str
    recommendation: str
    # M9d: default None so a pre-M9d checkpoint (msgpack-allowlisted, see foundry/graph.py) still
    # deserializes.
    evidence: AuditEvidence | None = None


# --------------------------------------------------------------------------------------------
# Code-authored — never produced by an LLM
# --------------------------------------------------------------------------------------------


class ColumnProfile(BaseModel):
    """Assembled by foundry/teams/data_team.py from RawColumnStats (measured) plus the LLM's
    ProfileAssessment (which columns are potential leaks) — never returned directly by
    llm.structured(), so it is never registered in StubClient's schema registry."""

    model_config = WIRE_CONFIG


    name: str
    dtype: str
    n_missing: int
    pct_missing: float
    n_unique: int
    is_potential_leak: bool = False


class DataProfile(BaseModel):
    model_config = WIRE_CONFIG
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


class AttemptRecord(BaseModel):
    """M9d: one self-debug attempt (SPEC: "runner self-debug max k=3"), for the operator
    console's experiment drawer `attempts` tab — "attempt 1 failed, 2 failed, 3 succeeded, each
    with its error and what changed". `outcome` mirrors the three ways
    foundry/teams/experiment_runner.py's loop can end an attempt: a non-zero sandbox exit
    (`failed_execution`), an exit-0 run whose stdout has no parseable FOUNDRY_METRICS line
    (`failed_metrics`), or a clean parse (`success`)."""

    model_config = WIRE_CONFIG

    attempt: int
    outcome: Literal["success", "failed_execution", "failed_metrics"]
    code: str
    stdout: str
    stderr: str
    error: str | None = None


class ExperimentResult(BaseModel):
    model_config = WIRE_CONFIG
    experiment_id: str
    mlflow_run_id: str | None = None
    status: Literal["success", "failed"]
    metrics: dict[str, float] = Field(default_factory=dict)
    cost_usd: float
    duration_s: float
    # Self-debug attempts consumed (SPEC: "runner self-debug max k=3"). Equal to
    # len(attempt_history) for anything recorded from M9d on; kept as its own field rather than
    # derived because a pre-M9d checkpoint has this count but no history.
    attempts: int = 1
    error: str | None = None
    # M9b: what the operator console's experiment drawer shows. The LAST attempt's script and its
    # tail-truncated sandbox output (foundry/config.py's experiment_output_chars). All three
    # default to "" because ExperimentResult is msgpack-allowlisted (foundry/graph.py): a
    # checkpoint written before these fields existed must still deserialize.
    code: str = ""
    stdout: str = ""
    stderr: str = ""
    # M9d: the spec that produced this result (drawer `spec` tab) and every self-debug attempt,
    # not just the last (drawer `attempts` tab). Both default to None/[] for the same
    # pre-M9d-checkpoint reason as code/stdout/stderr above.
    spec: ExperimentSpec | None = None
    attempt_history: list[AttemptRecord] = Field(default_factory=list)


class LeaderboardEntry(BaseModel):
    model_config = WIRE_CONFIG
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


class PendingSpecCost(BaseModel):
    """M9d: one pending ExperimentSpec's identity plus its PROJECTED cost (foundry/tools/cost.py's
    project_run_usd — max(mean completed cost, the spec's own est_cost_usd), never est_cost_usd
    alone), for the budget gate's "pending exp-005 lightgbm $2.10" rows (design-plan.md §6). Not
    msgpack-allowlisted: it only ever travels inside an ApprovalRequest/PendingApproval dumped
    with model_dump(mode="json") for interrupt(), never held directly in FoundryState."""

    experiment_id: str
    model_family: str
    projected_cost_usd: float


class ApprovalRequest(BaseModel):
    """The payload foundry/gates.py hands to interrupt() (M6: "both interrupt() gates are real
    and checkpointer-backed"). Human-authored territory, not LLM-authored — never registered in
    StubClient's schema registry (see the module docstring's two-group split): this describes
    what code has already computed, for a human to read, not something a model is asked to
    produce."""

    gate: Literal["budget", "final"]
    reason: str
    spent_usd: float
    budget_usd: float
    projected_usd: float = 0.0
    best_experiment_id: str | None = None
    best_metric_name: str | None = None
    best_metric_value: float | None = None
    n_invalidated: int = 0
    report_md: str | None = None
    # M9d: the specs behind `projected_usd`, for the budget gate only — always [] for the final
    # gate, which has no pending batch to show.
    pending_specs: list[PendingSpecCost] = Field(default_factory=list)


class HumanResponse(BaseModel):
    """The resume value a human supplies via Command(resume=...) — validated at the system
    boundary (CLAUDE.md: "Only validate at system boundaries"), the FastAPI request body or the
    CLI's stdin prompt, before foundry/gates.py trusts it."""

    approved: bool
    note: str = ""


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


class Lesson(BaseModel):
    """One distilled record of a completed run (M7: "lessons... written to Store at end of
    run"), assembled by foundry/teams/lessons.py from LessonDraft.text (the LLM's prose) plus
    facts code already computed elsewhere in the run — best_model_family/best_metric_* by
    cross-referencing state["leaderboard"]'s winner against state["experiment_plan"],
    invalidated_categories/leak_columns from state["invalidations"]/state["leakage_findings"],
    stop_reason and signed_off straight from state. Never LLM-authored itself, for the same
    reason ExperimentResult and DataProfile aren't: foundry/teams/modeling_team.py's literature
    scout later reads best_model_family to recommend a family, and a model-invented number there
    would defeat the entire "metrics computed by code, never estimated by an LLM" guardrail one
    hop removed. Stored as a plain JSON dict (Lesson.model_dump(mode="json")) in the LangGraph
    Store, not via the checkpointer's msgpack serde — foundry/tools/memory.py validates it back
    with Lesson.model_validate on read, skipping any record that fails (a cross-run store may
    genuinely hold a record written by an older schema — a real system boundary, not defensive
    padding)."""

    dataset_ref: str
    task_type: str
    text: str
    best_model_family: str | None = None
    best_metric_name: str | None = None
    best_metric_value: float | None = None
    invalidated_categories: list[RedTeamCategory] = Field(default_factory=list)
    leak_columns: list[str] = Field(default_factory=list)
    stop_reason: str | None = None
    signed_off: bool | None = None
    created_at: datetime = Field(default_factory=datetime.now)
