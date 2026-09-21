"""data_team subgraph (SPEC: "profiler (stats/schema/target-leakage scan) → cleaner →
splitter"). Its own private DataTeamState, wired into the parent FoundryState via an explicit
wrapper node rather than attaching the compiled subgraph directly — LangGraph 1.2.9 silently
drops any state key the two schemas don't share in both directions (verified against the
installed source; neither pyright nor .compile() catches it), so the wrapper's output dict is
built as a comprehension over DATA_TEAM_OUTPUT_KEYS instead of hand-written, making the mapping
data rather than prose that can drift from the declared contract.
"""

from __future__ import annotations

import operator
from functools import lru_cache
from typing import Annotated, Literal

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command
from typing_extensions import TypedDict

from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import (
    CleaningPlan,
    ColumnProfile,
    CVStrategy,
    DataProfile,
    LeakageFinding,
    LeakageReport,
    ProfileAssessment,
)
from foundry.prompting import with_context
from foundry.state import FoundryState
from foundry.tools import profiler as profiler_tool

_MIN_CV_SPLITS = 2
_MAX_CV_SPLITS = 10

DATA_TEAM_INPUT_KEYS: tuple[str, ...] = ("goal", "dataset_ref")
DATA_TEAM_OUTPUT_KEYS: tuple[str, ...] = (
    "data_profile",
    "leakage_findings",
    "cleaning_plan",
    "cv_strategy",
    "errors",
)


class DataTeamState(TypedDict):
    goal: str
    dataset_ref: str
    data_profile: DataProfile | None
    leakage_findings: list[LeakageFinding]
    cleaning_plan: CleaningPlan | None
    cv_strategy: CVStrategy | None
    errors: Annotated[list[str], operator.add]


def profiler(state: DataTeamState) -> dict[str, object]:
    dataset = get_dataset(state["dataset_ref"])
    llm = get_llm("worker")

    try:
        raw = profiler_tool.profile(dataset)
    except profiler_tool.ProfileError as exc:
        return {"errors": [f"profiler: sandbox profiling failed: {exc}"]}

    assessment = llm.structured(
        with_context(
            "Assess this measured dataset profile: confirm the task type and flag any "
            "columns that look like identifiers or otherwise leak the target rather than "
            "carrying real signal.",
            raw,
        ),
        ProfileAssessment,
    )
    leak_report = llm.structured(
        with_context(
            "Given this measured profile and the columns flagged as potential leaks, write "
            "one LeakageFinding per flagged column explaining why it is not real signal.",
            raw,
        ),
        LeakageReport,
    )

    leak_columns = set(assessment.potential_leak_columns)
    columns = [
        ColumnProfile(
            name=col.name,
            dtype=col.dtype,
            n_missing=col.n_missing,
            pct_missing=col.pct_missing,
            n_unique=col.n_unique,
            is_potential_leak=col.name in leak_columns,
        )
        for col in raw.columns
    ]
    data_profile = DataProfile(
        n_rows=raw.n_rows,
        n_cols=raw.n_cols,
        target_column=dataset.target_column,
        task_type=assessment.task_type,
        columns=columns,
        notes=assessment.notes,
    )
    return {"data_profile": data_profile, "leakage_findings": leak_report.findings}


def cleaner(state: DataTeamState) -> dict[str, object]:
    data_profile = state["data_profile"]
    if data_profile is None:
        return {"errors": ["cleaner: no data_profile to clean"]}

    llm = get_llm("worker")
    plan = llm.structured(
        with_context(
            "Given this data profile, propose a cleaning plan: which columns to drop, and "
            "the imputation strategy for numeric and categorical columns.",
            data_profile,
        ),
        CleaningPlan,
    )

    # Code guards: the LLM's plan is a starting point, not the final word. Never drop the
    # target column no matter what the plan says; force-drop every column the profiler
    # flagged as a leak (or that a high-severity finding names) even if the plan missed it.
    drop = set(plan.drop_columns)
    drop.discard(data_profile.target_column)
    drop |= {col.name for col in data_profile.columns if col.is_potential_leak}
    drop |= {f.column for f in state["leakage_findings"] if f.severity == "high"}

    plan = plan.model_copy(update={"drop_columns": sorted(drop)})
    return {"cleaning_plan": plan}


def splitter(state: DataTeamState) -> dict[str, object]:
    data_profile = state["data_profile"]
    if data_profile is None:
        return {"errors": ["splitter: no data_profile to split on"]}

    llm = get_llm("worker")
    strategy = llm.structured(
        with_context(
            "Given this data profile, propose a cross-validation strategy: kind, number of "
            "splits, and rationale.",
            data_profile,
        ),
        CVStrategy,
    )

    # Code guards: clamp n_splits to a sane range, and never accept an unstratified split for
    # a classification task regardless of what the LLM proposed.
    n_splits = max(_MIN_CV_SPLITS, min(_MAX_CV_SPLITS, strategy.n_splits))
    kind = strategy.kind
    if data_profile.task_type in ("binary_classification", "multiclass_classification"):
        kind = "stratified_kfold"

    strategy = strategy.model_copy(update={"kind": kind, "n_splits": n_splits})
    return {"cv_strategy": strategy}


@lru_cache(maxsize=1)
def build_data_team() -> CompiledStateGraph:
    builder = StateGraph(DataTeamState)
    builder.add_node("profiler", profiler)
    builder.add_node("cleaner", cleaner)
    builder.add_node("splitter", splitter)
    builder.add_edge(START, "profiler")
    builder.add_edge("profiler", "cleaner")
    builder.add_edge("cleaner", "splitter")
    builder.add_edge("splitter", END)
    return builder.compile(name="data_team")


def data_team_node(state: FoundryState) -> Command[Literal["principal"]]:
    sub_input: DataTeamState = {
        "goal": state["goal"],
        "dataset_ref": state["dataset_ref"],
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": None,
        "cv_strategy": None,
        "errors": [],  # deliberately empty, not state["errors"] — both schemas use
        # operator.add, so seeding the parent's list here would duplicate every prior error
    }
    result = build_data_team().invoke(sub_input)
    update = {key: result[key] for key in DATA_TEAM_OUTPUT_KEYS}
    return Command(goto="principal", update=update)
