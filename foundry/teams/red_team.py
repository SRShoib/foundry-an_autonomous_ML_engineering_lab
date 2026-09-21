"""red_team subgraph (SPEC: "adversarial auditor of every leaderboard candidate: data leakage,
train/test contamination, improper CV, validation overfitting, seed-hacking. Can mark an
experiment INVALIDATED with a written finding; principal must route remediation or drop it").

Structured as a real subgraph — mirroring foundry/teams/data_team.py's wrapper pattern exactly
(private RedTeamState, RED_TEAM_OUTPUT_KEYS, an lru_cache'd compiled graph, the wrapper node
building its output dict as a comprehension over the declared output keys) — because, like
data_team, it is genuinely two sequential steps with different concerns: `evidence_collector`
measures (code, sandboxed, no LLM — CLAUDE.md: "Metrics computed by code, never estimated by an
LLM"), `adjudicator` judges (one LLM call per pending candidate).

One audit() sandbox run per red_team pass, not one per candidate: the measured evidence (which
columns still correlate with the target after cleaning, how many exact-duplicate rows exist)
depends only on the dataset + CleaningPlan, not on which experiment is being judged, so
`evidence_collector` runs it once and `adjudicator` reuses the same AuditReport for every
candidate in `state["pending"]`.

Code owns the floor, never the ceiling: `_apply_floor` can push a permissive LLM verdict from
"valid" to "invalidated" when hard evidence crosses foundry/config.py's thresholds, but never the
reverse — the red_team LLM retains real invalidation authority for judgment calls the audit
evidence doesn't itself prove (SPEC: "can mark an experiment INVALIDATED", full stop, not "only
when a threshold fires"). This is the same asymmetry foundry/teams/data_team.py's cleaner applies
to CleaningPlan.drop_columns and foundry/teams/principal.py's PrincipalDirective.stop_reason
Literal applies to the stop conditions: a model can propose leniency, never buy its way past a
hard guard.

Remediation writes back into the SAME lever the data team already understands: a code-floor
"leakage" invalidation with an identified offending column becomes a high-severity LeakageFinding,
appended to state["leakage_findings"] (an add-reducer as of M5 — see foundry/state.py) — which
foundry/teams/data_team.py's cleaner already force-drops regardless of what its own LLM proposes
(foundry/teams/data_team.py:137). foundry/teams/principal.py routes back to data_team when such a
finding exists and isn't yet in cleaning_plan.drop_columns; the re-run drops it, the next
experiment trains clean, and the red team clears it on the next pass — no separate remediation
node or counter needed, the loop is self-terminating because the re-run makes the route condition
false. A "contamination" invalidation (duplicate rows) has no such column to drop; SPEC's
"or drop it" is the whole remedy there — it stays excluded from ranking (foundry/leaderboard.py)
permanently.

state["audited_experiments"] (an add-reducer of experiment_ids) is what lets the principal tell
"already audited and cleared" apart from "never audited" without re-deriving it from
state["invalidations"] every turn, and is what stops the same successful experiment from being
re-billed to the red_team LLM on every subsequent principal turn.
"""

from __future__ import annotations

import operator
from collections.abc import Sequence
from functools import lru_cache
from typing import Annotated, Literal

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command
from pydantic import BaseModel
from typing_extensions import TypedDict

from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import (
    CleaningPlan,
    CostEntry,
    CVStrategy,
    ExperimentResult,
    LeakageFinding,
    RedTeamFinding,
    RedTeamVerdict,
)
from foundry.prompting import with_context
from foundry.state import FoundryState
from foundry.tools import audit as audit_tool
from foundry.tools.audit import AuditReport

# Metrics known to be bounded in [0, 1] — a near-perfect CV score is implausible on real, noisy
# tabular data regardless of what the audit evidence shows (foundry/config.py's
# audit_suspicious_metric_ceiling). rmse has no natural upper bound, so it is deliberately excluded
# rather than guessed at.
_BOUNDED_UNIT_METRICS = frozenset({"roc_auc", "accuracy", "f1"})

RED_TEAM_INPUT_KEYS: tuple[str, ...] = ("dataset_ref", "cleaning_plan", "cv_strategy")
RED_TEAM_OUTPUT_KEYS: tuple[str, ...] = (
    "invalidations",
    "audited_experiments",
    "leakage_findings",
    "errors",
    "costs",
)


class RedTeamState(TypedDict):
    dataset_ref: str
    cleaning_plan: CleaningPlan | None
    cv_strategy: CVStrategy | None
    pending: list[ExperimentResult]
    audit_report: AuditReport | None
    invalidations: Annotated[list[RedTeamFinding], operator.add]
    audited_experiments: Annotated[list[str], operator.add]
    leakage_findings: Annotated[list[LeakageFinding], operator.add]
    errors: Annotated[list[str], operator.add]
    costs: Annotated[list[CostEntry], operator.add]


class RedTeamContext(BaseModel):
    experiment_id: str
    primary_metric: str
    primary_metric_value: float
    metrics: dict[str, float]
    cv_kind: str
    cv_n_splits: int
    task_type: str
    n_rows: int
    duplicate_row_rate: float
    worst_column_name: str | None = None
    worst_column_target_auc: float | None = None


def pending_candidates(
    experiments: Sequence[ExperimentResult], audited_ids: frozenset[str]
) -> list[ExperimentResult]:
    """Successful experiments the red team has not yet rendered a verdict for — the audit gate
    foundry/teams/principal.py checks before it will ever trust a leaderboard candidate."""
    return [
        result
        for result in experiments
        if result.status == "success" and result.experiment_id not in audited_ids
    ]


def _worst_column(report: AuditReport) -> tuple[str | None, float | None]:
    candidates = [
        (col.name, col.target_auc) for col in report.columns if col.target_auc is not None
    ]
    if not candidates:
        return None, None
    return max(candidates, key=lambda pair: pair[1])


def _metric_implausible(metric: str, value: float) -> bool:
    return metric in _BOUNDED_UNIT_METRICS and value >= settings.audit_suspicious_metric_ceiling


def _apply_floor(
    verdict: RedTeamVerdict,
    *,
    leak: bool,
    leak_column: str | None,
    leak_auc: float | None,
    contamination: bool,
    metric_implausible: bool,
) -> RedTeamVerdict:
    if verdict.verdict == "invalidated":
        return verdict
    if leak:
        return verdict.model_copy(
            update={
                "verdict": "invalidated",
                "category": "leakage",
                "explanation": (
                    f"{verdict.explanation} Code floor override: column {leak_column!r} "
                    f"measures target-association AUC {leak_auc:.3f}, at or above "
                    f"foundry's audit_leak_auc_threshold, regardless of the model's own read."
                ),
                "recommendation": f"Drop column {leak_column!r} and retrain.",
            }
        )
    if contamination:
        return verdict.model_copy(
            update={
                "verdict": "invalidated",
                "category": "contamination",
                "explanation": (
                    f"{verdict.explanation} Code floor override: the audited data's exact-"
                    "duplicate-row rate is at or above foundry's audit_duplicate_row_rate, "
                    "regardless of the model's own read."
                ),
            }
        )
    if metric_implausible:
        return verdict.model_copy(
            update={
                "verdict": "invalidated",
                "category": "validation_overfitting",
                "explanation": (
                    f"{verdict.explanation} Code floor override: the reported metric is at or "
                    "above foundry's audit_suspicious_metric_ceiling for a metric bounded in "
                    "[0, 1], regardless of the model's own read."
                ),
            }
        )
    return verdict


def evidence_collector(state: RedTeamState) -> dict[str, object]:
    if not state["pending"]:
        return {"audit_report": None}
    dataset = get_dataset(state["dataset_ref"])
    try:
        report = audit_tool.audit(dataset, state["cleaning_plan"])
    except audit_tool.AuditError as exc:
        return {
            "errors": [f"red_team.evidence_collector: sandbox audit failed: {exc}"],
            "audit_report": None,
        }
    return {"audit_report": report}


def adjudicator(state: RedTeamState) -> dict[str, object]:
    pending = state["pending"]
    if not pending:
        return {}

    dataset = get_dataset(state["dataset_ref"])
    cv_strategy = state["cv_strategy"]
    report = state["audit_report"]
    llm = get_llm("red_team")

    leak_column, leak_auc = _worst_column(report) if report is not None else (None, None)
    leak = leak_auc is not None and leak_auc >= settings.audit_leak_auc_threshold
    contamination = (
        report is not None and report.duplicate_row_rate >= settings.audit_duplicate_row_rate
    )

    findings: list[RedTeamFinding] = []
    audited_ids: list[str] = []
    leak_columns_flagged: dict[str, LeakageFinding] = {}

    for result in pending:
        value = result.metrics.get(dataset.primary_metric)
        metric_implausible = value is not None and _metric_implausible(
            dataset.primary_metric, value
        )
        context = RedTeamContext(
            experiment_id=result.experiment_id,
            primary_metric=dataset.primary_metric,
            primary_metric_value=value if value is not None else 0.0,
            metrics=result.metrics,
            cv_kind=cv_strategy.kind if cv_strategy else "stratified_kfold",
            cv_n_splits=cv_strategy.n_splits if cv_strategy else 5,
            task_type=dataset.task_type,
            n_rows=report.n_rows if report is not None else 0,
            duplicate_row_rate=report.duplicate_row_rate if report is not None else 0.0,
            worst_column_name=leak_column,
            worst_column_target_auc=leak_auc,
        )
        verdict = llm.structured(
            with_context(
                "Audit this experiment for data leakage, train/test contamination, improper "
                "cross-validation, validation overfitting, or seed hacking, using the measured "
                "evidence below. Only invalidate when the evidence actually supports it.",
                context,
            ),
            RedTeamVerdict,
        )
        verdict = _apply_floor(
            verdict,
            leak=leak,
            leak_column=leak_column,
            leak_auc=leak_auc,
            contamination=contamination,
            metric_implausible=metric_implausible,
        )
        findings.append(RedTeamFinding(experiment_id=result.experiment_id, **verdict.model_dump()))
        audited_ids.append(result.experiment_id)

        if verdict.verdict == "invalidated" and verdict.category == "leakage" and leak_column:
            leak_columns_flagged[leak_column] = LeakageFinding(
                column=leak_column,
                reason=(
                    f"red team: target-association audit AUC {leak_auc:.3f} on experiment "
                    f"{result.experiment_id} — a likely target proxy that survived cleaning"
                ),
                severity="high",
            )

    update: dict[str, object] = {
        "invalidations": findings,
        "audited_experiments": audited_ids,
        "costs": llm.costs,
    }
    if leak_columns_flagged:
        update["leakage_findings"] = list(leak_columns_flagged.values())
    return update


@lru_cache(maxsize=1)
def build_red_team() -> CompiledStateGraph:
    builder = StateGraph(RedTeamState)
    builder.add_node("evidence_collector", evidence_collector)
    builder.add_node("adjudicator", adjudicator)
    builder.add_edge(START, "evidence_collector")
    builder.add_edge("evidence_collector", "adjudicator")
    builder.add_edge("adjudicator", END)
    return builder.compile(name="red_team")


def red_team_node(state: FoundryState) -> Command[Literal["principal"]]:
    audited_ids = frozenset(state["audited_experiments"])
    pending = pending_candidates(state["experiments"], audited_ids)

    sub_input: RedTeamState = {
        "dataset_ref": state["dataset_ref"],
        "cleaning_plan": state["cleaning_plan"],
        "cv_strategy": state["cv_strategy"],
        "pending": pending,
        "audit_report": None,
        "invalidations": [],
        "audited_experiments": [],
        "leakage_findings": [],
        "errors": [],
        "costs": [],
    }
    result = build_red_team().invoke(sub_input)
    update = {key: result[key] for key in RED_TEAM_OUTPUT_KEYS}
    return Command(goto="principal", update=update)
