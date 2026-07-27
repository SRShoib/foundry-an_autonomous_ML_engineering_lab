"""Tests for foundry/graph.py. build_graph() compiling at all is itself a proof that every
Command[Literal[...]] goto target names a real node — LangGraph 1.2.9 validates that at
.compile() time (verified against the installed source), it does not fail silently.

M6: every offline end-to-end run now pauses at the real final_gate interrupt() before it can
reach report_md/stop_reason — graph.invoke() returns the paused state plus an "__interrupt__" key
rather than raising (verified against the installed LangGraph 1.2.9), so a test that only checked
final values without ever resuming would still "pass" while silently no longer exercising the
gate at all. _resume_through_final_gate asserts the pause actually happened (and that it is the
final gate, not some other interrupt) before resuming with an approval to reach true completion."""

from __future__ import annotations

import threading
import time
from typing import Any, cast, get_type_hints

import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.store.memory import InMemoryStore
from langgraph.types import Command

from foundry.config import settings
from foundry.graph import build_graph, initial_state, run_config
from foundry.llm import MeteredClient, StubClient
from foundry.models import SandboxResult
from foundry.state import FoundryState
from foundry.stubs import register_canned_responses
from foundry.teams import data_team as data_team_module
from foundry.teams import experiment_runner as runner_module
from foundry.teams import lessons as lessons_module
from foundry.teams import modeling_team as modeling_team_module
from foundry.teams import principal as principal_module
from foundry.teams import red_team as red_team_module
from foundry.teams import reporter as reporter_module
from foundry.tools import memory
from foundry.tools.audit import AuditColumnStat, AuditReport
from foundry.tools.profiler import RawColumnStats, RawProfile

_ALL_TEAM_MODULES = (
    principal_module,
    data_team_module,
    modeling_team_module,
    runner_module,
    red_team_module,
    reporter_module,
    lessons_module,
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

_CLEAN_AUDIT_REPORT = AuditReport(
    dataset_name="churn.csv",
    n_rows=1200,
    n_cols=2,
    target_column="churned",
    columns=[AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.3)],
    duplicate_row_count=0,
    duplicate_row_rate=0.0,
)

# --- M5 booby-trap fixture: churn_leaky's shape, faked so this stays Docker-free -----------------

_LEAKY_RAW_PROFILE = RawProfile(
    dataset_name="churn_leaky.csv",
    n_rows=300,
    n_cols=4,
    target_column="churned",
    target_positive_rate=0.27,
    columns=[
        RawColumnStats(
            name="customer_id", dtype="object", n_missing=0, pct_missing=0.0, n_unique=300,
            is_numeric=False, sample_values=["a"],
        ),
        RawColumnStats(
            name="tenure_months", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=72,
            is_numeric=True, sample_values=["1"], target_corr=-0.1, target_auc=0.4,
        ),
        # Categorical, so foundry/tools/profiler.py's real target_auc (numeric-only) would never
        # measure it either — this fixture models that blind spot, it doesn't just assert it.
        RawColumnStats(
            name="retention_call_outcome", dtype="object", n_missing=0, pct_missing=0.0,
            n_unique=3, is_numeric=False, sample_values=["saved"],
        ),
        RawColumnStats(
            name="churned", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=2,
            is_numeric=True, sample_values=["0", "1"],
        ),
    ],
)

_LEAKY_AUDIT_REPORT = AuditReport(
    dataset_name="churn_leaky.csv",
    n_rows=300,
    n_cols=2,
    target_column="churned",
    columns=[
        AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.4),
        AuditColumnStat(name="retention_call_outcome", is_numeric=False, target_auc=0.9962),
    ],
    duplicate_row_count=0,
    duplicate_row_rate=0.0,
)

_CLEAN_LEAKY_AUDIT_REPORT = AuditReport(
    dataset_name="churn_leaky.csv",
    n_rows=300,
    n_cols=1,
    target_column="churned",
    columns=[AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.4)],
    duplicate_row_count=0,
    duplicate_row_rate=0.0,
)


def _fake_leaky_audit(dataset: Any, cleaning_plan: Any, **kw: Any) -> AuditReport:
    dropped = set(cleaning_plan.drop_columns) if cleaning_plan else set()
    return _CLEAN_LEAKY_AUDIT_REPORT if "retention_call_outcome" in dropped else _LEAKY_AUDIT_REPORT


def _fake_leaky_sandbox_run(code: str, **kw: Any) -> SandboxResult:
    # CodeRequest.drop_columns is embedded via repr(list[str]) — this literal only appears in
    # the generated code when the column is actually in drop_columns for THIS training run.
    if "'retention_call_outcome'" in code:
        return SandboxResult(
            stdout='FOUNDRY_METRICS {"roc_auc": 0.80}', stderr="", exit_code=0, duration_s=0.1,
            timed_out=False,
        )
    return SandboxResult(
        stdout='FOUNDRY_METRICS {"roc_auc": 0.99}', stderr="", exit_code=0, duration_s=0.1,
        timed_out=False,
    )


def _use_stub_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wraps the shared StubClient in a fresh MeteredClient per get_llm() call — mirroring
    foundry.llm.get_llm's own behavior — so concurrent Send-fanned-out experiment_runner
    branches (real threads; see foundry/teams/principal.py) each get an isolated `.costs` list
    instead of racing on one shared list."""
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    client = StubClient()
    register_canned_responses(client)
    for module in _ALL_TEAM_MODULES:
        monkeypatch.setattr(
            module, "get_llm", lambda role, _client=client: MeteredClient(role, _client, model=None)
        )


def _resume_through_final_gate(
    graph: Any, config: RunnableConfig, paused_state: dict[str, Any]
) -> dict[str, Any]:
    """Asserts the run genuinely paused at the real final_gate interrupt() (M6), then approves
    it to reach true completion. None of these fixtures ever project a single-run cost above
    settings.cost_cap_usd_per_run or total spend above settings.budget_gate_fraction * budget_usd
    (stub costs are a few cents against a $20 budget), so the final gate is the only interrupt
    these offline runs ever hit."""
    interrupts = paused_state.get("__interrupt__")
    assert interrupts, "expected the run to pause at final_gate before completing"
    assert interrupts[0].value["gate"] == "final"
    assert paused_state["report_md"], "reporter must have already run before the final gate pauses"
    return cast(
        "dict[str, Any]",
        graph.invoke(Command(resume={"approved": True, "note": "approved in test"}), config),
    )


def test_build_graph_compiles_with_expected_nodes() -> None:
    graph = build_graph()
    nodes = set(graph.get_graph().nodes) - {"__start__", "__end__"}
    assert nodes == {
        "principal", "data_team", "modeling_team", "experiment_runner", "red_team",
        "reporter", "final_gate", "lesson_writer",
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


def test_send_fanout_runs_in_parallel_and_never_loses_cost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression test for M4's Send fan-out (foundry/teams/principal.py): the first planning
    batch proposes max_experiments_per_iteration distinct families (foundry/stubs.py), principal
    fans all of them out via Send in one Command, and they genuinely execute on separate threads
    (verified against LangGraph 1.2.9's BackgroundExecutor — a real ThreadPoolExecutor). Every
    branch's cost must survive the merge: state["spent_usd"] is derived from state["costs"] (an
    add-reducer) by principal, never written by the runners directly, which is exactly the fix
    for the lost-update race concurrent branches would otherwise hit on a plain, non-reducer
    field. No Docker needed — sandbox.run, tracker.log_run, and (M5) the red_team audit tool are
    all faked."""
    _use_stub_everywhere(monkeypatch)
    monkeypatch.setattr(
        data_team_module.profiler_tool, "profile", lambda dataset, **kw: _RAW_PROFILE
    )
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: "run-id")
    monkeypatch.setattr(
        red_team_module.audit_tool,
        "audit",
        lambda dataset, cleaning_plan, **kw: _CLEAN_AUDIT_REPORT,
    )

    seen_threads: set[int] = set()

    def _fake_run(code: str, **kw: Any) -> SandboxResult:
        seen_threads.add(threading.get_ident())
        time.sleep(0.05)  # hold the thread long enough for sibling branches to overlap
        return _SANDBOX_SUCCESS

    monkeypatch.setattr(runner_module.sandbox, "run", _fake_run)

    graph = build_graph(InMemorySaver())
    state = initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0)
    config = run_config("fanout-test")
    paused_state = graph.invoke(state, config)
    final_state = _resume_through_final_gate(graph, config, paused_state)

    assert len(final_state["experiments"]) == settings.max_experiments_per_iteration
    assert len(seen_threads) >= 2  # genuinely parallel, not serialized onto one thread
    assert all(result.status == "success" for result in final_state["experiments"])

    total_cost = round(sum(entry.usd for entry in final_state["costs"]), 8)
    assert final_state["spent_usd"] == pytest.approx(total_cost)
    assert final_state["spent_usd"] > 0


def test_second_run_plans_differently_because_of_the_first_runs_lesson(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SPEC M7's headline requirement: "demonstrate run #2 differing because of run #1's
    lessons." Run #1 (a fresh, empty InMemoryStore) fans out all three of the stub's default
    families in one Send batch — _FAMILY_SEQUENCE (foundry/stubs.py) has exactly 3 entries,
    matching settings.max_experiments_per_iteration, so no family filtering is needed to make
    that happen. gradient_boosting is made to score highest, so
    foundry/teams/lessons.py::lesson_writer persists it as the run's Lesson.best_model_family.
    Run #2 shares the same store: its literature_scout recommends gradient_boosting first
    (foundry/teams/modeling_team.py::_best_past_family, direction-aware over roc_auc), which the
    stub's _experiment_plan then places ahead of the default escalation order — the first family
    run #2 actually plans differs from run #1's, entirely offline, no API key involved."""
    _use_stub_everywhere(monkeypatch)
    monkeypatch.setattr(
        data_team_module.profiler_tool, "profile", lambda dataset, **kw: _RAW_PROFILE
    )
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: "run-id")
    monkeypatch.setattr(
        red_team_module.audit_tool,
        "audit",
        lambda dataset, cleaning_plan, **kw: _CLEAN_AUDIT_REPORT,
    )

    def _family_scored_sandbox_run(code: str, **kw: Any) -> SandboxResult:
        if "GradientBoostingClassifier" in code:
            auc = 0.95
        elif "RandomForestClassifier" in code:
            auc = 0.80
        else:
            auc = 0.70
        return SandboxResult(
            stdout=f'FOUNDRY_METRICS {{"roc_auc": {auc}}}', stderr="", exit_code=0,
            duration_s=0.1, timed_out=False,
        )

    monkeypatch.setattr(runner_module.sandbox, "run", _family_scored_sandbox_run)

    store = InMemoryStore()
    graph = build_graph(InMemorySaver(), store)

    config_1 = run_config("memory-run-1")
    paused_1 = graph.invoke(
        initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0), config_1
    )
    final_1 = _resume_through_final_gate(graph, config_1, paused_1)

    winner_1 = next(
        spec.model_family
        for spec in final_1["experiment_plan"]
        if spec.experiment_id == final_1["leaderboard"][0].experiment_id
    )
    assert winner_1 == "gradient_boosting"
    run_1_first_family = final_1["experiment_plan"][0].model_family
    assert run_1_first_family == "logistic_regression"  # default order — no lesson existed yet
    assert "## Lessons applied" not in final_1["report_md"]  # nothing recommended on run #1
    assert "## Lessons learned" in final_1["report_md"]

    lessons = memory.search("churn", store=store)
    assert len(lessons) == 1
    assert lessons[0].best_model_family == "gradient_boosting"
    assert lessons[0].best_metric_name == "roc_auc"

    config_2 = run_config("memory-run-2")
    paused_2 = graph.invoke(
        initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0), config_2
    )
    final_2 = _resume_through_final_gate(graph, config_2, paused_2)

    run_2_first_family = final_2["experiment_plan"][0].model_family
    assert run_2_first_family == "gradient_boosting"
    assert run_2_first_family != run_1_first_family
    assert "## Lessons applied" in final_2["report_md"]
    assert "gradient_boosting" in final_2["report_md"]


@pytest.mark.docker
def test_end_to_end_offline_run_with_in_memory_checkpointer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_stub_everywhere(monkeypatch)

    graph = build_graph(InMemorySaver())
    state = initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0)
    config = run_config("e2e-test")
    paused_state = graph.invoke(state, config)
    final_state = _resume_through_final_gate(graph, config, paused_state)

    assert final_state["report_md"]
    assert "## Sign-off" in final_state["report_md"]
    assert "APPROVED" in final_state["report_md"]
    assert final_state["stop_reason"] is not None
    assert final_state["iteration_count"] > 1
    assert any(result.status == "success" for result in final_state["experiments"])
    assert final_state["costs"]  # M4: per-agent cost ledger populated
    assert final_state["leaderboard"]  # M4: principal maintains this every turn
    assert [d.gate for d in final_state["human_decisions"]] == ["final"]  # M6


def test_booby_trap_offline_end_to_end_catches_and_remediates_the_leak(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """M5's headline integration test (SPEC: "a booby-trapped leaky dataset it must catch").
    churn_leaky's real shape (data/samples/churn_leaky.csv, data/samples/README.md) is faked here
    at the sandbox boundary — _fake_leaky_sandbox_run/_fake_leaky_audit key off whether
    'retention_call_outcome' is in the CURRENT cleaning_plan.drop_columns, exactly the state
    foundry/teams/data_team.py's remediation re-run is meant to change — so this stays Docker-free
    while still exercising the full catch-then-remediate loop: audit gate -> red_team invalidates
    -> data_team remediates -> a clean replacement experiment reaches the leaderboard.
    """
    _use_stub_everywhere(monkeypatch)
    monkeypatch.setattr(
        data_team_module.profiler_tool, "profile", lambda dataset, **kw: _LEAKY_RAW_PROFILE
    )
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: "run-id")
    monkeypatch.setattr(runner_module.sandbox, "run", _fake_leaky_sandbox_run)
    monkeypatch.setattr(red_team_module.audit_tool, "audit", _fake_leaky_audit)

    graph = build_graph(InMemorySaver())
    state = initial_state(goal="predict churn", dataset_ref="churn_leaky", budget_usd=20.0)
    config = run_config("booby-trap-test")
    paused_state = graph.invoke(state, config)
    final_state = _resume_through_final_gate(graph, config, paused_state)

    invalidated_ids = {
        finding.experiment_id
        for finding in final_state["invalidations"]
        if finding.verdict == "invalidated"
    }
    assert invalidated_ids  # the red team actually caught something

    assert any(
        finding.column == "retention_call_outcome" and finding.severity == "high"
        for finding in final_state["leakage_findings"]
    )
    cleaning_plan = final_state["cleaning_plan"]
    assert cleaning_plan is not None
    assert "retention_call_outcome" in cleaning_plan.drop_columns  # remediation happened

    leaderboard_ids = {entry.experiment_id for entry in final_state["leaderboard"]}
    assert leaderboard_ids, "a clean, post-remediation experiment should have made the board"
    assert leaderboard_ids.isdisjoint(invalidated_ids)

    assert final_state["stop_reason"] is not None


@pytest.mark.postgres
def test_postgres_checkpoint_survives_a_fresh_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    """M6: the pending final_gate interrupt itself — not just the completed report — must
    survive a fresh connection, proving the gate is really checkpointer-backed (CLAUDE.md: "both
    interrupt() gates are real and checkpointer-backed") rather than an artifact of one
    in-process graph object."""
    import uuid

    from langgraph.checkpoint.postgres import PostgresSaver

    _use_stub_everywhere(monkeypatch)
    thread_id = f"pg-durability-{uuid.uuid4()}"

    with PostgresSaver.from_conn_string(settings.database_url) as checkpointer:
        checkpointer.setup()
        graph = build_graph(checkpointer)
        state = initial_state(goal="predict churn", dataset_ref="churn", budget_usd=20.0)
        paused_state = graph.invoke(state, run_config(thread_id))
        assert paused_state.get("__interrupt__"), "expected a pause at the final gate"

    with PostgresSaver.from_conn_string(settings.database_url) as checkpointer:
        graph = build_graph(checkpointer)
        snapshot = graph.get_state({"configurable": {"thread_id": thread_id}})
        assert snapshot.interrupts, "the final gate's pending approval must survive a reconnect"
        assert snapshot.interrupts[0].value["gate"] == "final"
        assert snapshot.values["report_md"]  # reporter already ran before the gate paused

        final_state = graph.invoke(
            Command(resume={"approved": True, "note": "approved after reconnect"}),
            run_config(thread_id),
        )
        assert final_state["stop_reason"] is not None
        assert "APPROVED" in final_state["report_md"]
