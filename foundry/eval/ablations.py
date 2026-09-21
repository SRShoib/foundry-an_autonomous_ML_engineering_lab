"""SPEC M8's four named ablations: "red team on/off; memory on/off; multi-agent vs single
monolithic agent; model-split vs uniform." Every ablation but the last exercises the SAME
production code path as a normal run — a single settings flag read in one place
(foundry/teams/principal.py's `settings.red_team_enabled`), a `store` argument
foundry/graph.py::build_graph already accepts, or a direct settings override this module applies
and restores around one call. The one true fork is foundry/eval/monolith.py's single-agent
baseline: SPEC names it "single monolithic agent" precisely because it is not the graph at all.

Five runs per dataset — `full` (config="full", memory ON via a fresh, per-dataset store) serves as
the baseline for three separate comparisons (red team, model split, monolith) AND as run #1 of the
memory pair, rather than four independent baseline runs: a first run against an empty store is
behaviorally identical to memory being off entirely (foundry/teams/modeling_team.py's
literature_scout has nothing to recall either way), so reusing it costs nothing and the memory
block's own run #2 is the only genuinely additional run.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from langgraph.store.memory import InMemoryStore

from foundry.config import settings
from foundry.eval.harness import TaskResult, run_task
from foundry.eval.monolith import run_monolith

TASKS: tuple[str, ...] = ("churn", "churn_leaky", "energy")


@contextmanager
def override_settings(**overrides: Any) -> Iterator[None]:
    """Temporarily mutates the foundry.config.settings singleton and restores every overridden
    field on exit, including on exception — the same lever tests/ already exercise per-test via
    monkeypatch.setattr(settings, ...), just without a pytest fixture backing the restore, since
    an eval sweep runs many configurations in one process rather than one config per test."""
    original = {key: getattr(settings, key) for key in overrides}
    for key, value in overrides.items():
        setattr(settings, key, value)
    try:
        yield
    finally:
        for key, value in original.items():
            setattr(settings, key, value)


def run_task_matrix(dataset_ref: str, *, budget_usd: float = 20.0) -> list[TaskResult]:
    """The five runs for one dataset: full (+ its reuse as memory run #1), memory run #2 on the
    same store, red team off, uniform model, and the monolith baseline."""
    store = InMemoryStore()
    full = run_task(dataset_ref, budget_usd=budget_usd, store=store, config_label="full")

    memory_run_2 = run_task(
        dataset_ref, budget_usd=budget_usd, store=store, config_label="memory_run_2"
    )

    with override_settings(red_team_enabled=False):
        no_red_team = run_task(dataset_ref, budget_usd=budget_usd, config_label="no_red_team")

    with override_settings(
        principal_model=settings.worker_model, red_team_model=settings.worker_model
    ):
        uniform_model = run_task(dataset_ref, budget_usd=budget_usd, config_label="uniform_model")

    monolith = run_monolith(dataset_ref, budget_usd=budget_usd)

    return [full, memory_run_2, no_red_team, uniform_model, monolith]
