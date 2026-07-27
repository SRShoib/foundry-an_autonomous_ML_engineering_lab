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

import time
from collections.abc import Callable
from contextlib import nullcontext
from typing import Any

import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore

from app.main import create_app
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
    monkeypatch.setattr(settings, "anthropic_api_key", None)
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
def client(monkeypatch: pytest.MonkeyPatch) -> Any:
    _use_stub_everywhere(monkeypatch)
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


def test_list_runs_reflects_known_threads(client: TestClient) -> None:
    start = client.post("/runs", json={"task": "churn", "budget_usd": 20.0})
    thread_id = start.json()["thread_id"]
    _wait_until(lambda: client.get(f"/runs/{thread_id}").json()["status"] != "running")

    runs = client.get("/runs").json()
    assert any(entry["thread_id"] == thread_id for entry in runs)
