"""Tests for foundry/graph.py. build_graph() compiling at all is itself a proof that every
Command[Literal[...]] goto target names a real node — LangGraph 1.2.9 validates that at
.compile() time (verified against the installed source), it does not fail silently."""

from __future__ import annotations

from typing import get_type_hints

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError

from foundry.config import settings
from foundry.graph import build_graph, initial_state, run_config
from foundry.llm import StubClient
from foundry.models import SandboxResult
from foundry.state import FoundryState
from foundry.stubs import register_canned_responses
from foundry.teams import data_team as data_team_module
from foundry.teams import experiment_runner as runner_module
from foundry.teams import modeling_team as modeling_team_module
from foundry.teams import principal as principal_module
from foundry.teams import reporter as reporter_module
from foundry.tools.profiler import RawColumnStats, RawProfile

_ALL_TEAM_MODULES = (
    principal_module,
    data_team_module,
    modeling_team_module,
    runner_module,
    reporter_module,
)

_RAW_PROFILE = RawProfile(
    dataset_name="churn.csv",
    n_rows=1200,
    n_cols=3,
    target_column="churned",
    target_positive_rate=0.28,
    columns=[
        RawColumnStats(
            name="customer_id", dtype="object", n_missing=0, pct_missing=0.0, n_unique=1200,
            is_numeric=False, sample_values=["a"],
        ),
        RawColumnStats(
            name="tenure_months", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=72,
            is_numeric=True, sample_values=["1"],
        ),
        RawColumnStats(
            name="churned", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=2,
            is_numeric=True, sample_values=["0", "1"],
        ),
    ],
)

_SANDBOX_SUCCESS = SandboxResult(
    stdout='FOUNDRY_METRICS {"roc_auc": 0.9}', stderr="", exit_code=0, duration_s=0.1,
    timed_out=False,
)


def _use_stub_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    client = StubClient()
    register_canned_responses(client)
    for module in _ALL_TEAM_MODULES:
        monkeypatch.setattr(module, "get_llm", lambda role: client)


def test_build_graph_compiles_with_expected_nodes() -> None:
    graph = build_graph()
    nodes = set(graph.get_graph().nodes) - {"__start__", "__end__"}
    assert nodes == {
        "principal", "data_team", "experiment_planner", "experiment_runner", "reporter",
    }


def test_initial_state_has_every_foundry_state_key() -> None:
    state = initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0)
    assert set(state.keys()) == set(get_type_hints(FoundryState))


def test_run_config_sets_the_configured_recursion_limit() -> None:
    config = run_config("thread-1")
    assert config.get("recursion_limit") == settings.graph_recursion_limit
    configurable = config.get("configurable") or {}
    assert configurable.get("thread_id") == "thread-1"


def test_recursion_limit_exceeded_raises_graph_recursion_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_stub_everywhere(monkeypatch)
    monkeypatch.setattr(
        data_team_module.profiler_tool, "profile", lambda dataset, **kw: _RAW_PROFILE
    )
    monkeypatch.setattr(runner_module.sandbox, "run", lambda code, **kw: _SANDBOX_SUCCESS)

    graph = build_graph(InMemorySaver())
    state = initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0)
    with pytest.raises(GraphRecursionError):
        graph.invoke(
            state, {"configurable": {"thread_id": "recursion-test"}, "recursion_limit": 1}
        )


@pytest.mark.docker
def test_end_to_end_offline_run_with_in_memory_checkpointer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_stub_everywhere(monkeypatch)

    graph = build_graph(InMemorySaver())
    state = initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0)
    final_state = graph.invoke(state, run_config("e2e-test"))

    assert final_state["report_md"]
    assert final_state["stop_reason"] is not None
    assert final_state["iteration_count"] > 1
    assert any(result.status == "success" for result in final_state["experiments"])


@pytest.mark.postgres
def test_postgres_checkpoint_survives_a_fresh_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    import uuid

    from langgraph.checkpoint.postgres import PostgresSaver

    _use_stub_everywhere(monkeypatch)
    thread_id = f"pg-durability-{uuid.uuid4()}"

    with PostgresSaver.from_conn_string(settings.database_url) as checkpointer:
        checkpointer.setup()
        graph = build_graph(checkpointer)
        state = initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0)
        graph.invoke(state, run_config(thread_id))

    with PostgresSaver.from_conn_string(settings.database_url) as checkpointer:
        graph = build_graph(checkpointer)
        snapshot = graph.get_state({"configurable": {"thread_id": thread_id}})
        assert snapshot.values["report_md"]
