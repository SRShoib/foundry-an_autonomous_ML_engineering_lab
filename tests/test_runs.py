"""Tests for app/runs.py's RunManager rehydration (M9b). foundry's runs are durable — a paused
interrupt() is checkpointer-backed — but RunManager tracked runs only in an in-memory dict, so an
API restart emptied GET /runs and orphaned any run paused at a gate. These tests simulate a restart
the same way tests/test_graph.py's Postgres reconnect test proves durability: two independent
RunManagers (each with its own compiled graph and empty handle dict) over ONE shared checkpointer.

No Docker, Postgres, or real LLM — the same per-module get_llm patching and faked sandbox/tracker/
audit seams as tests/test_api.py, kept local to this file like every other test module here."""

from __future__ import annotations

import time
from collections.abc import Callable

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore

from app.events import ActivityEvent
from app.runs import RunManager
from app.schemas import RunStatus
from foundry.config import settings
from foundry.graph import build_graph
from foundry.llm import MeteredClient, StubClient
from foundry.models import SandboxResult
from foundry.stubs import register_canned_responses
from foundry.teams import data_team as data_team_module
from foundry.teams import experiment_runner as runner_module
from foundry.teams import lessons as lessons_module
from foundry.teams import modeling_team as modeling_team_module
from foundry.teams import principal as principal_module
from foundry.teams import red_team as red_team_module
from foundry.teams import reporter as reporter_module
from foundry.tools.audit import AuditColumnStat, AuditReport
from foundry.tools.profiler import RawColumnStats, RawProfile

_ALL_TEAM_MODULES = (
    principal_module, data_team_module, modeling_team_module, runner_module, red_team_module,
    reporter_module, lessons_module,
)
_RAW_PROFILE = RawProfile(
    dataset_name="churn.csv",
    n_rows=1200,
    n_cols=2,
    target_column="churned",
    target_positive_rate=0.28,
    columns=[
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


@pytest.fixture(autouse=True)
def _stub_everything(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "openai_api_key", None)
    client = StubClient()
    register_canned_responses(client)
    for module in _ALL_TEAM_MODULES:
        monkeypatch.setattr(
            module, "get_llm", lambda role, _client=client: MeteredClient(role, _client, model=None)
        )
    monkeypatch.setattr(
        data_team_module.profiler_tool, "profile", lambda dataset, **kw: _RAW_PROFILE
    )
    monkeypatch.setattr(runner_module.sandbox, "run", lambda code, **kw: _SANDBOX_SUCCESS)
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: "run-id")
    monkeypatch.setattr(
        red_team_module.audit_tool,
        "audit",
        lambda dataset, cleaning_plan, **kw: _CLEAN_AUDIT_REPORT,
    )


def _wait_until(
    predicate: Callable[[], bool], *, timeout: float = 5.0, interval: float = 0.02
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError(f"condition not met within {timeout}s")


def _manager(saver: InMemorySaver, store: InMemoryStore) -> RunManager:
    """A fresh RunManager — a new compiled graph and an empty handle dict — over shared storage."""
    return RunManager(build_graph(saver, store))


def _start_and_wait_for_the_final_gate(manager: RunManager, thread_id: str = "run-a") -> str:
    manager.start(thread_id=thread_id, goal="predict churn", dataset_ref="churn", budget_usd=20.0)
    _wait_until(lambda: manager.status(thread_id).status != "running")
    assert manager.status(thread_id).status == "awaiting_approval"
    return thread_id


def test_status_rehydrates_a_completed_thread_with_no_handle() -> None:
    saver, store = InMemorySaver(), InMemoryStore()
    before_restart = _manager(saver, store)
    thread_id = _start_and_wait_for_the_final_gate(before_restart)
    before_restart.resume(thread_id, {"approved": True, "note": "ok"})
    _wait_until(lambda: before_restart.status(thread_id).status == "completed")

    after_restart = _manager(saver, store)
    status = after_restart.status(thread_id)
    assert status.status == "completed"
    assert status.report_md and "## Sign-off" in status.report_md
    assert status.experiments
    assert status.error is None


def test_thread_ids_includes_persisted_threads_after_a_restart() -> None:
    saver, store = InMemorySaver(), InMemoryStore()
    before_restart = _manager(saver, store)
    thread_id = _start_and_wait_for_the_final_gate(before_restart)

    after_restart = _manager(saver, store)
    assert after_restart.thread_ids() == [thread_id]
    assert after_restart.exists(thread_id)


def test_thread_ids_lists_live_runs_first_and_never_duplicates_them() -> None:
    saver, store = InMemorySaver(), InMemoryStore()
    old = _start_and_wait_for_the_final_gate(_manager(saver, store), "run-old")

    manager = _manager(saver, store)
    new = _start_and_wait_for_the_final_gate(manager, "run-new")
    assert manager.thread_ids() == [new, old]


def test_persisted_listing_is_bounded_by_api_max_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    saver, store = InMemorySaver(), InMemoryStore()
    seeding = _manager(saver, store)
    for name in ("run-1", "run-2", "run-3"):
        _start_and_wait_for_the_final_gate(seeding, name)

    monkeypatch.setattr(settings, "api_max_runs", 2)
    assert len(_manager(saver, store).thread_ids()) == 2


def test_status_still_raises_key_error_for_a_never_seen_thread() -> None:
    manager = _manager(InMemorySaver(), InMemoryStore())
    with pytest.raises(KeyError):
        manager.status("never-existed")
    assert not manager.exists("never-existed")


def test_resume_works_on_a_rehydrated_thread_paused_at_a_gate() -> None:
    """The whole point of a checkpointer-backed interrupt(): the gate outlives the process."""
    saver, store = InMemorySaver(), InMemoryStore()
    thread_id = _start_and_wait_for_the_final_gate(_manager(saver, store))

    after_restart = _manager(saver, store)
    paused = after_restart.status(thread_id)
    assert paused.status == "awaiting_approval"
    assert paused.pending_approval is not None
    assert paused.pending_approval.gate == "final"

    after_restart.resume(thread_id, {"approved": True, "note": "approved after restart"})
    _wait_until(lambda: after_restart.status(thread_id).status == "completed")
    report = after_restart.status(thread_id).report_md
    assert report and "approved after restart" in report


def test_resuming_an_unknown_thread_raises_key_error() -> None:
    manager = _manager(InMemorySaver(), InMemoryStore())
    with pytest.raises(KeyError):
        manager.resume("never-existed", {"approved": True, "note": ""})


def test_a_thread_cut_off_mid_run_is_reported_failed_not_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _explode(code: str, **kwargs: object) -> SandboxResult:
        raise RuntimeError("docker daemon went away")

    monkeypatch.setattr(runner_module.sandbox, "run", _explode)
    saver, store = InMemorySaver(), InMemoryStore()
    crashed = _manager(saver, store)
    crashed.start(thread_id="run-x", goal="g", dataset_ref="churn", budget_usd=20.0)
    _wait_until(lambda: crashed.status("run-x").status == "failed")

    after_restart = _manager(saver, store).status("run-x")
    assert after_restart.status == "failed"
    assert after_restart.error and "interrupted before finishing" in after_restart.error


def test_stream_on_a_rehydrated_thread_yields_a_restored_notice_instead_of_raising() -> None:
    saver, store = InMemorySaver(), InMemoryStore()
    thread_id = _start_and_wait_for_the_final_gate(_manager(saver, store))

    events = list(_manager(saver, store).stream(thread_id))
    assert [event.kind for event in events] == ["done"]
    assert "restored from a checkpoint" in events[0].summary


class _SpyRecorder:
    """Implements app/replay.py's ReplayRecorder protocol, logging the order calls arrive in."""

    def __init__(self, *, fail_on_record: bool = False) -> None:
        self.calls: list[str] = []
        self.manager: RunManager | None = None
        self.status_when_paused: str | None = None
        self.final_status: RunStatus | None = None
        self._fail_on_record = fail_on_record

    def begin(self, *, thread_id: str, task: str, goal: str, budget_usd: float) -> None:
        self.calls.append("begin")

    def record(self, thread_id: str, event: ActivityEvent, status: RunStatus) -> None:
        if self._fail_on_record:
            raise OSError("disk full")
        self.calls.append(f"record:{event.kind}")

    def pause(self, thread_id: str) -> None:
        self.calls.append("pause")
        assert self.manager is not None
        self.status_when_paused = self.manager.status(thread_id).status

    def resume(self, thread_id: str, *, approved: bool, note: str) -> None:
        self.calls.append("resume")

    def close(self, thread_id: str, *, final_status: RunStatus) -> None:
        self.calls.append(f"close:{final_status.status}")
        self.final_status = final_status


def test_the_pause_is_recorded_before_the_gate_is_visible_to_clients() -> None:
    """A client only sees awaiting_approval once handle.finish() has run. If finish() ran BEFORE
    the recorder's pause(), a fast resume could reach the recorder first and the operator's
    decision would be silently dropped. So at the moment pause() is called the run must still
    read as running."""
    spy = _SpyRecorder()
    manager = RunManager(build_graph(InMemorySaver(), InMemoryStore()), spy)
    spy.manager = manager
    _start_and_wait_for_the_final_gate(manager)

    assert spy.status_when_paused == "running"
    assert spy.calls[0] == "begin"
    assert spy.calls[-3:] == ["record:interrupt", "record:done", "pause"]


def test_a_failed_leg_is_closed_with_the_real_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def _explode(code: str, **kwargs: object) -> SandboxResult:
        raise RuntimeError("docker daemon went away")

    monkeypatch.setattr(runner_module.sandbox, "run", _explode)
    spy = _SpyRecorder()
    manager = RunManager(build_graph(InMemorySaver(), InMemoryStore()), spy)
    spy.manager = manager
    manager.start(thread_id="run-x", goal="g", dataset_ref="churn", budget_usd=20.0)
    _wait_until(lambda: manager.status("run-x").status == "failed")

    assert spy.calls[-2:] == ["record:error", "close:failed"]
    assert spy.final_status is not None
    assert spy.final_status.error == "docker daemon went away"


def test_a_recorder_that_raises_never_fails_the_run_it_observes() -> None:
    manager = RunManager(
        build_graph(InMemorySaver(), InMemoryStore()), _SpyRecorder(fail_on_record=True)
    )
    _start_and_wait_for_the_final_gate(manager)
    assert manager.status("run-a").error is None
