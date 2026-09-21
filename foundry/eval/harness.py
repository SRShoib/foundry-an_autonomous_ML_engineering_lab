"""SPEC M8's evaluation harness: "run the lab end-to-end per task; report final metric, cost,
wall time, # invalid experiments caught by red team." run_task drives the SAME production graph
foundry/cli.py runs — built via foundry/graph.py::build_graph, answering both real interrupt()
gates (foundry/gates.py) through genuine Command(resume=...) round trips, never bypassed — the
only difference from a `make run` invocation is that every gate is auto-approved (no human sits
at a terminal for an eval sweep) and the checkpointer is always a throwaway InMemorySaver (each
call gets its own thread_id; nothing here needs cross-process durability).

TaskResult is code-authored only, the same "never LLM-estimated" rule every other result type in
this codebase follows (foundry/models.py's two-group split) — every field is read off FoundryState
or derived from foundry/teams/reporter.py's own cost_by_agent, never invented here.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Sequence
from typing import Any, cast

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.base import BaseStore
from langgraph.types import Command
from pydantic import BaseModel, Field

from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.graph import build_graph, initial_state, run_config
from foundry.models import CostEntry
from foundry.state import FoundryState
from foundry.stubs import install_canned_responses
from foundry.teams.reporter import cost_by_agent


class TaskResult(BaseModel):
    dataset_ref: str
    config: str
    approach: str
    thread_id: str
    stop_reason: str | None = None
    primary_metric_name: str
    primary_metric_value: float | None = None
    target_value: float
    target_met: bool
    n_experiments: int
    n_successful: int
    n_invalidated: int
    cost_total_usd: float
    cost_by_agent: dict[str, float] = Field(default_factory=dict)
    calls_by_agent: dict[str, int] = Field(default_factory=dict)
    wall_time_s: float
    winning_model_family: str | None = None
    first_model_family: str | None = None
    error: str | None = None


def calls_by_agent(costs: Sequence[CostEntry]) -> dict[str, int]:
    """Real per-role LLM call counts (kind="llm" only — a sandbox CostEntry isn't an LLM call).
    The model-split-vs-uniform ablation's projected-cost column prices exactly these counts under
    two different $/Mtok configurations (foundry/eval/report.py) rather than trusting
    foundry/llm.py's StubClient flat-rate `usd` field, which cannot distinguish the split from
    uniform at all offline."""
    counts: dict[str, int] = {}
    for entry in costs:
        if entry.kind != "llm":
            continue
        counts[entry.agent_role] = counts.get(entry.agent_role, 0) + 1
    return counts


def _run_to_completion(
    graph: Any, graph_input: FoundryState | Command, config: Any
) -> dict[str, Any]:
    """Mirrors foundry/cli.py's own invoke loop with `--auto-approve` always on — the eval harness
    runs unattended, but every pause is still a real interrupt(), answered through a genuine
    Command(resume=...) round trip, never skipped (CLAUDE.md: "both interrupt() gates are real
    and checkpointer-backed, never skipped")."""
    while True:
        result = cast("dict[str, Any]", graph.invoke(graph_input, config))
        interrupts = result.get("__interrupt__")
        if not interrupts:
            return result
        graph_input = Command(
            resume={"approved": True, "note": "auto-approved by foundry.eval harness"}
        )


def run_task(
    dataset_ref: str,
    *,
    budget_usd: float = 20.0,
    store: BaseStore | None = None,
    config_label: str = "full",
    thread_id: str | None = None,
) -> TaskResult:
    if not settings.openai_api_key:
        install_canned_responses()

    dataset = get_dataset(dataset_ref)
    tid = thread_id or f"eval-{dataset_ref}-{config_label}-{uuid.uuid4().hex[:8]}"
    graph = build_graph(InMemorySaver(), store)
    state = initial_state(
        goal=f"predict {dataset.target_column}", dataset_ref=dataset_ref, budget_usd=budget_usd
    )
    run_cfg = run_config(tid)

    start = time.monotonic()
    error: str | None = None
    graph_input: FoundryState | Command = state
    try:
        result = _run_to_completion(graph, graph_input, run_cfg)
    except Exception as exc:  # noqa: BLE001 — surfaced in TaskResult.error, never fatal to a sweep
        error = str(exc)
        snapshot = graph.get_state(run_cfg)
        result = dict(snapshot.values or {})
    wall_time_s = time.monotonic() - start

    final_state = cast(FoundryState, result)
    board = final_state.get("leaderboard") or []
    best = board[0] if board else None
    experiment_plan = final_state.get("experiment_plan") or []
    winning_family = (
        next(
            (
                spec.model_family
                for spec in experiment_plan
                if spec.experiment_id == best.experiment_id
            ),
            None,
        )
        if best is not None
        else None
    )
    # The FIRST family the plan ever named, not the winner — SPEC's memory ablation demo is
    # "run #2 differing because of run #1's lessons" (tests/test_graph.py's own headline M7 test
    # checks this exact field), which a winning-family comparison alone would not show whenever
    # both runs happen to converge on the same eventual winner.
    first_model_family = experiment_plan[0].model_family if experiment_plan else None
    experiments = final_state.get("experiments") or []
    invalidations = final_state.get("invalidations") or []
    costs = final_state.get("costs") or []

    return TaskResult(
        dataset_ref=dataset_ref,
        config=config_label,
        approach="hierarchical",
        thread_id=tid,
        stop_reason=final_state.get("stop_reason"),
        primary_metric_name=dataset.primary_metric,
        primary_metric_value=best.primary_metric_value if best is not None else None,
        target_value=dataset.target_value,
        target_met=final_state.get("stop_reason") == "target_met",
        n_experiments=len(experiments),
        n_successful=sum(1 for r in experiments if r.status == "success"),
        n_invalidated=sum(1 for f in invalidations if f.verdict == "invalidated"),
        cost_total_usd=final_state.get("spent_usd", 0.0),
        cost_by_agent=cost_by_agent(costs),
        calls_by_agent=calls_by_agent(costs),
        wall_time_s=wall_time_s,
        winning_model_family=winning_family,
        first_model_family=first_model_family,
        error=error,
    )
