"""modeling_team subgraph (SPEC: "literature scout (web search + memory store → approach memos)
→ experiment planner (N ExperimentSpecs)"). M7 turns this from a flat single node into a real
subgraph — mirroring foundry/teams/data_team.py exactly (private ModelingTeamState,
MODELING_TEAM_OUTPUT_KEYS, an lru_cache'd compiled graph, the wrapper node building its output
dict as a comprehension over the declared output keys) — for the same reason data_team is one:
genuinely two sequential steps with different concerns. `literature_scout` reads
foundry/tools/memory.py's cross-thread Store (this milestone's memory-only scope — SPEC also
names web_search as a scout tool, but no milestone assigns it and M7's own line is memory-only;
left for a later milestone) and proposes which model families to try first. `experiment_planner`
turns that plus the dataset profile into ExperimentSpecs, unchanged from M4/M5 except that its
PlanContext now carries the scout's recommendation.

Send fan-out (SPEC: "experiment planner (N ExperimentSpecs) → Send fan-out of experiment
runners") still belongs to foundry/teams/principal.py, the graph's single routing authority: once
this subgraph appends a batch of pending specs and returns to principal, principal decides how
many run in parallel. Nothing about the scout's addition changes that split.

literature_scout runs at most once per run, not once per planning pass: state["approach_memo"] is
a plain (non-reducer) FoundryState channel that, once set, is never reset — every planning pass
after the first therefore starts with `state["approach_memo"] is not None` already true and skips
straight to a no-op `{}` return, forwarding the existing memo instead of re-billing the LLM. This
is correct, not just cheap: the memo's only input (foundry/tools/memory.py's search() over PAST
runs' lessons) cannot change mid-run — lessons are only ever written once, at the very end of a
run, by foundry/teams/lessons.py's lesson_writer, strictly after this run's own planning is done.

Code owns the things that must never depend on the LLM getting it right, same as before M7: which
model families are actually installed in the sandbox image, how many specs one planning pass may
add, and experiment_id assignment — plus, as of M7, that a family the scout said to avoid can
never be scheduled regardless of what the planner's LLM proposes, the same "LLM proposes, code
disposes" split already applied to unsupported families and to ApproachMemo.recommended_families/
avoid_families themselves (both reuse ExperimentSpec.model_family's Literal, but literature_scout
still re-filters them against SUPPORTED_MODEL_FAMILIES before trusting them)."""

from __future__ import annotations

import operator
from functools import lru_cache
from typing import Annotated, Literal

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command
from pydantic import BaseModel, Field
from typing_extensions import TypedDict

from foundry import leaderboard
from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import (
    ApproachMemo,
    CostEntry,
    DataProfile,
    ExperimentPlan,
    ExperimentResult,
    ExperimentSpec,
    Lesson,
    RedTeamFinding,
)
from foundry.prompting import with_context
from foundry.state import FoundryState
from foundry.teams.experiment_runner import SUPPORTED_MODEL_FAMILIES
from foundry.tools import memory

_FALLBACK_SPEC = ExperimentSpec(
    experiment_id="fallback",
    model_family="logistic_regression",
    hyperparams={},
    rationale="Fallback baseline: no valid LLM-proposed spec survived filtering.",
    est_cost_usd=0.01,
)

MODELING_TEAM_INPUT_KEYS: tuple[str, ...] = (
    "goal",
    "dataset_ref",
    "data_profile",
    "experiment_plan",
    "experiments",
    "invalidations",
    "approach_memo",
)
MODELING_TEAM_OUTPUT_KEYS: tuple[str, ...] = (
    "approach_memo",
    "experiment_plan",
    "errors",
    "costs",
)


class ModelingTeamState(TypedDict):
    goal: str
    dataset_ref: str
    data_profile: DataProfile | None
    experiment_plan: list[ExperimentSpec]
    experiments: list[ExperimentResult]
    invalidations: list[RedTeamFinding]
    approach_memo: ApproachMemo | None
    errors: Annotated[list[str], operator.add]
    costs: Annotated[list[CostEntry], operator.add]


class ScoutContext(BaseModel):
    goal: str
    task_type: str
    dataset_description: str
    prior_model_families: list[str]
    past_lessons: list[str] = Field(default_factory=list)
    past_best_family: str | None = None


class PlanContext(BaseModel):
    goal: str
    task_type: str
    primary_metric: str
    n_rows: int
    n_cols: int
    prior_experiments: int
    prior_model_families: list[str]
    best_metric_so_far: float | None = None
    # M5: what the red team has invalidated so far, so a replacement spec is planned in light of
    # the invalidation (e.g. "don't repeat the family that just seed-hacked its way to 0.99")
    # rather than by accident. Empty on every dataset the red team hasn't flagged anything on.
    recent_invalidations: list[str] = Field(default_factory=list)
    # M7: the literature scout's ApproachMemo, threaded through so the planner's LLM sees the
    # same recommendation the code guard below enforces — never the planner's only defense
    # against an avoided family, just its first line of information.
    recommended_families: list[str] = Field(default_factory=list)
    avoid_families: list[str] = Field(default_factory=list)
    cautions: str = ""


def _prior_families(state: ModelingTeamState) -> list[str]:
    done_ids = {result.experiment_id for result in state["experiments"]}
    return [
        spec.model_family for spec in state["experiment_plan"] if spec.experiment_id in done_ids
    ]


def _best_past_family(lessons: list[Lesson], primary_metric: str) -> str | None:
    """Direction-aware (foundry/leaderboard.py's metric_direction) pick across every past Lesson
    for this dataset that reports the SAME primary metric this run cares about and was signed off
    on — a declined run's winner is not something to recommend repeating. Purely code: the scout's
    LLM only ever sees the resulting family name via ScoutContext.past_best_family, never a raw
    number it could restate wrong."""
    candidates = [
        lesson
        for lesson in lessons
        if lesson.best_model_family
        and lesson.best_metric_name == primary_metric
        and lesson.best_metric_value is not None
        and lesson.signed_off is not False
    ]
    if not candidates:
        return None
    pick = min if leaderboard.metric_direction(primary_metric) == "lower_is_better" else max
    return pick(candidates, key=lambda lesson: lesson.best_metric_value).best_model_family  # type: ignore[return-value,arg-type]


def literature_scout(state: ModelingTeamState) -> dict[str, object]:
    if state["approach_memo"] is not None:
        return {}  # already scouted this run — see module docstring

    dataset = get_dataset(state["dataset_ref"])
    llm = get_llm("worker")

    past_lessons = memory.search(state["dataset_ref"])
    context = ScoutContext(
        goal=state["goal"],
        task_type=dataset.task_type,
        dataset_description=dataset.description,
        prior_model_families=_prior_families(state),
        past_lessons=[lesson.text for lesson in past_lessons],
        past_best_family=_best_past_family(past_lessons, dataset.primary_metric),
    )
    memo = llm.structured(
        with_context(
            "Given this dataset and any lessons from prior runs, recommend which model "
            "families to try first (recommended_families) and which to avoid "
            "(avoid_families), with a short rationale.",
            context,
        ),
        ApproachMemo,
    )

    proposed = set(memo.recommended_families) | set(memo.avoid_families)
    unsupported = proposed - SUPPORTED_MODEL_FAMILIES
    errors: list[str] = []
    if unsupported:
        errors.append(
            f"literature_scout: dropped unsupported model families: {sorted(unsupported)}"
        )
    memo = memo.model_copy(
        update={
            "recommended_families": [
                f for f in memo.recommended_families if f in SUPPORTED_MODEL_FAMILIES
            ],
            "avoid_families": [f for f in memo.avoid_families if f in SUPPORTED_MODEL_FAMILIES],
        }
    )

    update: dict[str, object] = {"approach_memo": memo, "costs": llm.costs}
    if errors:
        update["errors"] = errors
    return update


def experiment_planner(state: ModelingTeamState) -> dict[str, object]:
    data_profile = state["data_profile"]
    dataset = get_dataset(state["dataset_ref"])
    llm = get_llm("worker")

    prior_families = _prior_families(state)
    invalidated = [f for f in state["invalidations"] if f.verdict == "invalidated"]
    invalidated_ids = frozenset(f.experiment_id for f in invalidated)
    best = leaderboard.best_result(state["experiments"], dataset.primary_metric, invalidated_ids)
    memo = state["approach_memo"]
    context = PlanContext(
        goal=state["goal"],
        task_type=data_profile.task_type if data_profile else dataset.task_type,
        primary_metric=dataset.primary_metric,
        n_rows=data_profile.n_rows if data_profile else 0,
        n_cols=data_profile.n_cols if data_profile else 0,
        prior_experiments=len(state["experiments"]),
        prior_model_families=prior_families,
        best_metric_so_far=best.metrics[dataset.primary_metric] if best else None,
        recent_invalidations=[f"{f.category}: {f.recommendation}" for f in invalidated],
        recommended_families=[str(f) for f in memo.recommended_families] if memo else [],
        avoid_families=[str(f) for f in memo.avoid_families] if memo else [],
        cautions=memo.cautions if memo else "",
    )
    plan = llm.structured(
        with_context(
            "Propose the next experiment to run: pick a model family not yet tried if "
            "possible, preferring recommended_families and never proposing a family listed "
            "in avoid_families, with reasonable hyperparameters.",
            context,
        ),
        ExperimentPlan,
    )

    avoid = set(context.avoid_families)
    errors: list[str] = []
    candidates = [
        spec
        for spec in plan.specs
        if spec.model_family in SUPPORTED_MODEL_FAMILIES and spec.model_family not in avoid
    ]
    if len(candidates) < len(plan.specs):
        skipped = [
            spec.model_family
            for spec in plan.specs
            if spec.model_family not in SUPPORTED_MODEL_FAMILIES or spec.model_family in avoid
        ]
        errors.append(f"experiment_planner: dropped unsupported/avoided model families: {skipped}")

    candidates = candidates[: settings.max_experiments_per_iteration] or [_FALLBACK_SPEC]

    n_prior = len(state["experiment_plan"])
    new_specs = [
        spec.model_copy(update={"experiment_id": f"exp-{n_prior + i + 1:03d}"})
        for i, spec in enumerate(candidates)
    ]

    update: dict[str, object] = {
        "experiment_plan": state["experiment_plan"] + new_specs,
        "costs": llm.costs,
    }
    if errors:
        update["errors"] = errors
    return update


@lru_cache(maxsize=1)
def build_modeling_team() -> CompiledStateGraph:
    builder = StateGraph(ModelingTeamState)
    builder.add_node("literature_scout", literature_scout)
    builder.add_node("experiment_planner", experiment_planner)
    builder.add_edge(START, "literature_scout")
    builder.add_edge("literature_scout", "experiment_planner")
    builder.add_edge("experiment_planner", END)
    return builder.compile(name="modeling_team")


def modeling_team_node(state: FoundryState) -> Command[Literal["principal"]]:
    sub_input: ModelingTeamState = {
        "goal": state["goal"],
        "dataset_ref": state["dataset_ref"],
        "data_profile": state["data_profile"],
        "experiment_plan": state["experiment_plan"],
        "experiments": state["experiments"],
        "invalidations": state["invalidations"],
        "approach_memo": state["approach_memo"],
        "errors": [],  # deliberately empty, not state["errors"] — see data_team_node's own
        # reasoning: both schemas use operator.add, so seeding the parent's list here would
        # duplicate every prior error.
        "costs": [],  # same reasoning as errors above
    }
    result = build_modeling_team().invoke(sub_input)
    update = {key: result[key] for key in MODELING_TEAM_OUTPUT_KEYS}
    return Command(goto="principal", update=update)
