"""Tests for app/main.py (SPEC M6: "FastAPI (start run, stream events, list pending approvals,
resume)"). create_app() takes a checkpointer-context-manager factory precisely so tests can swap
in InMemorySaver via nullcontext — mirroring foundry/cli.py's own --checkpointer switch — instead
of needing a live Postgres server. The graph genuinely runs on a background thread (app/runs.py's
RunManager), so these tests poll GET /runs/{id} for a status transition rather than asserting
immediately after POST — the same "real background execution" foundry's sandboxed experiment
runners require in production.

No Docker, Postgres, or real LLM: get_llm is monkeypatched per team module exactly like
tests/test_graph.py's _use_stub_everywhere, and sandbox/tracker/red-team-audit are faked so the
churn task completes in milliseconds — full network-of-agents behavior, zero external services.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore

from app.main import create_app
from app.replay import Replay, fold_frames
from app.schemas import RunStatus
from foundry.config import settings
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


def _use_stub_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
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
    predicate: Callable[[], bool], *, timeout: float = 5.0, interval: float = 0.05
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError(f"condition not met within {timeout}s")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Any:
    _use_stub_everywhere(monkeypatch)
    # Every run is recorded (app/replay.py): keep test recordings out of the real artifacts/ dir
    # and out of the committed demo dir, and let tests find them under tmp_path.
    monkeypatch.setattr(settings, "replay_record_dir", tmp_path / "recorded")
    monkeypatch.setattr(settings, "replay_demo_dir", tmp_path / "demo")
    test_app = create_app(
        checkpointer_factory=lambda: nullcontext(InMemorySaver()),
        store_factory=lambda: nullcontext(InMemoryStore()),
    )
    with TestClient(test_app) as test_client:
        yield test_client


def test_unknown_task_is_a_404(client: TestClient) -> None:
    response = client.post("/runs", json={"task": "does-not-exist"})
    assert response.status_code == 404


def test_unknown_thread_id_is_a_404(client: TestClient) -> None:
    assert client.get("/runs/does-not-exist").status_code == 404
    assert client.get("/runs/does-not-exist/events").status_code == 404
    assert (
        client.post("/runs/does-not-exist/resume", json={"approved": True}).status_code == 404
    )


def test_full_round_trip_start_pause_at_final_gate_approve_and_complete(
    client: TestClient,
) -> None:
    start = client.post("/runs", json={"task": "churn", "budget_usd": 20.0})
    assert start.status_code == 202
    thread_id = start.json()["thread_id"]

    _wait_until(lambda: client.get(f"/runs/{thread_id}").json()["status"] != "running")
    status = client.get(f"/runs/{thread_id}").json()
    assert status["status"] == "awaiting_approval"
    assert status["pending_approval"]["gate"] == "final"
    assert status["report_md"]  # reporter already ran before the gate paused

    approvals = client.get("/approvals").json()
    assert any(entry["thread_id"] == thread_id for entry in approvals)

    events_response = client.get(f"/runs/{thread_id}/events")
    assert events_response.status_code == 200
    assert "interrupt" in events_response.text

    resume = client.post(f"/runs/{thread_id}/resume", json={"approved": True, "note": "lgtm"})
    assert resume.status_code == 202

    _wait_until(lambda: client.get(f"/runs/{thread_id}").json()["status"] == "completed")
    final = client.get(f"/runs/{thread_id}").json()
    assert final["stop_reason"] is not None
    assert "## Sign-off" in final["report_md"]
    assert "APPROVED" in final["report_md"]

    # already completed — no pending approval left to resume
    assert client.get("/approvals").json() == []
    conflict = client.post(f"/runs/{thread_id}/resume", json={"approved": True})
    assert conflict.status_code == 409


def _sse_events(text: str) -> list[dict[str, Any]]:
    """Decode an SSE body, ignoring comment/keepalive lines — only `data:` frames carry events."""
    prefix = "data: "
    lines = [line for line in text.splitlines() if line.startswith(prefix)]
    return [json.loads(line[len(prefix) :]) for line in lines]


def _run_to_final_gate(client: TestClient) -> str:
    thread_id = client.post("/runs", json={"task": "churn", "budget_usd": 20.0}).json()["thread_id"]
    _wait_until(lambda: client.get(f"/runs/{thread_id}").json()["status"] != "running")
    return thread_id


def test_run_status_exposes_experiments_audit_trail_profile_card_and_cost(
    client: TestClient,
) -> None:
    status = client.get(f"/runs/{_run_to_final_gate(client)}").json()

    assert status["experiments"], "the operator console's experiment drawer needs these"
    assert all(experiment["code"] for experiment in status["experiments"])
    assert status["data_profile"]["target_column"] == "churned"
    assert status["model_card_md"]
    assert status["cost_by_agent"]["worker"] > 0

    # invalidations is the FULL audit trail: with a clean audit every verdict is `valid`, yet each
    # audited experiment still appears — consumers must filter on verdict, not on presence.
    assert status["invalidations"]
    assert {finding["verdict"] for finding in status["invalidations"]} == {"valid"}


def test_events_carry_a_server_side_non_decreasing_timestamp(client: TestClient) -> None:
    thread_id = _run_to_final_gate(client)

    events = _sse_events(client.get(f"/runs/{thread_id}/events").text)
    stamps = [datetime.fromisoformat(event["ts"]) for event in events]
    assert len(stamps) > 3
    assert all(stamp.tzinfo is not None for stamp in stamps)
    assert stamps == sorted(stamps)


def test_experiments_route_returns_each_result_with_its_code(client: TestClient) -> None:
    thread_id = _run_to_final_gate(client)

    experiments = client.get(f"/runs/{thread_id}/experiments").json()
    assert experiments
    assert all(row["code"] and row["status"] == "success" for row in experiments)
    assert client.get("/runs/does-not-exist/experiments").status_code == 404


def test_eval_route_returns_the_parsed_results_file(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "artifacts_dir", tmp_path)
    (tmp_path / "eval").mkdir()
    row = {
        "dataset_ref": "churn", "config": "full", "approach": "hierarchical", "thread_id": "t",
        "stop_reason": "target_met", "primary_metric_name": "roc_auc",
        "primary_metric_value": 0.91, "target_value": 0.9, "target_met": True,
        "n_experiments": 3, "n_successful": 3, "n_invalidated": 0, "cost_total_usd": 0.18,
        "wall_time_s": 12.5,
    }
    (tmp_path / "eval" / "results.json").write_text(json.dumps([row]), encoding="utf-8")

    response = client.get("/eval")
    assert response.status_code == 200
    assert response.json()[0]["primary_metric_value"] == 0.91


def test_eval_route_names_the_fix_when_nothing_has_been_run(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "artifacts_dir", tmp_path)
    response = client.get("/eval")
    assert response.status_code == 404
    assert "make eval" in response.json()["detail"]


def test_a_corrupt_eval_file_is_a_500_that_names_the_fix(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "artifacts_dir", tmp_path)
    (tmp_path / "eval").mkdir()
    (tmp_path / "eval" / "results.json").write_text("[{\"nope\": 1}]", encoding="utf-8")
    response = client.get("/eval")
    assert response.status_code == 500
    assert "make eval" in response.json()["detail"]


def test_a_completed_run_is_recorded_and_served_from_replays(client: TestClient) -> None:
    """The whole recording path end to end: record while the graph really runs on its background
    thread, then serve it back and prove the carry-forward fold reproduces what GET /runs/{id}
    reports — including the operator's approval at the gate."""
    thread_id = _run_to_final_gate(client)
    client.post(f"/runs/{thread_id}/resume", json={"approved": True, "note": "ship it"})
    _wait_until(lambda: client.get(f"/runs/{thread_id}").json()["status"] == "completed")
    _wait_until(lambda: any(r["thread_id"] == thread_id for r in client.get("/replays").json()))
    # close() rewrites the file only once the run has finished; wait for the closed form
    _wait_until(lambda: client.get(f"/replays/{thread_id}").json()["header"]["final_status"])

    (summary,) = [r for r in client.get("/replays").json() if r["thread_id"] == thread_id]
    assert summary["committed"] is False
    assert summary["task"] == "churn"

    replay = Replay.model_validate(client.get(f"/replays/{thread_id}").json())
    folded = fold_frames(replay.frames)
    live = RunStatus.model_validate(client.get(f"/runs/{thread_id}").json())
    assert folded[-1] == replay.header.final_status == live

    (first_gate, *_) = replay.header.decisions
    assert (first_gate.gate, first_gate.approved, first_gate.note) == ("final", True, "ship it")
    assert [frame.event.seq for frame in replay.frames] == list(range(len(replay.frames)))

    # the frame for the event that PRODUCED the report already carries it: statuses are paired
    # with post-step checkpoints, not read one step stale at the moment the event arrives
    reporter_frame = next(
        status for frame, status in zip(replay.frames, folded, strict=True)
        if frame.event.node == "reporter"
    )
    assert reporter_frame.report_md
    data_team_frame = next(
        status for frame, status in zip(replay.frames, folded, strict=True)
        if frame.event.node == "data_team"
    )
    assert data_team_frame.data_profile is not None


def test_replay_routes_404_for_unknown_and_malformed_names(client: TestClient) -> None:
    assert client.get("/replays/never-recorded").status_code == 404
    assert client.get("/replays/.hidden").status_code == 404
    assert client.get("/replays").json() == []


def test_list_runs_reflects_known_threads(client: TestClient) -> None:
    start = client.post("/runs", json={"task": "churn", "budget_usd": 20.0})
    thread_id = start.json()["thread_id"]
    _wait_until(lambda: client.get(f"/runs/{thread_id}").json()["status"] != "running")

    runs = client.get("/runs").json()
    assert any(entry["thread_id"] == thread_id for entry in runs)
