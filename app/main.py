"""FastAPI control plane (SPEC M6: "FastAPI (start run, stream events, list pending approvals,
resume)"). create_app() takes a checkpointer-context-manager factory, mirroring foundry/cli.py's
own --checkpointer switch (Postgres for `make api`, InMemorySaver via nullcontext for tests) —
the checkpointer is opened once in the app's lifespan and kept open for the process's lifetime,
never per-request, matching foundry/cli.py's own `with checkpointer_cm as checkpointer:` pattern.
Actual graph execution never runs inside a request handler: app/runs.py's RunManager does that on
a background thread, since foundry's sandboxed experiment runners make real, possibly
minutes-long Docker calls that must never block the event loop.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import AbstractContextManager, asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.postgres import PostgresSaver

from app.runs import RunManager
from app.schemas import (
    PendingApproval,
    ResumeRequest,
    RunStatus,
    StartRunRequest,
    StartRunResponse,
)
from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.graph import build_graph
from foundry.stubs import install_canned_responses

CheckpointerFactory = Callable[[], AbstractContextManager[BaseCheckpointSaver]]


def _default_checkpointer_factory() -> AbstractContextManager[BaseCheckpointSaver]:
    return PostgresSaver.from_conn_string(settings.database_url)


def create_app(
    checkpointer_factory: CheckpointerFactory = _default_checkpointer_factory,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if not settings.anthropic_api_key:
            install_canned_responses()
        with checkpointer_factory() as checkpointer:
            if isinstance(checkpointer, PostgresSaver):
                checkpointer.setup()
            graph = build_graph(checkpointer)
            app.state.run_manager = RunManager(graph)
            yield

    app = FastAPI(title="foundry", lifespan=lifespan)

    def manager() -> RunManager:
        return app.state.run_manager

    @app.post("/runs", status_code=202)
    def start_run(request: StartRunRequest) -> StartRunResponse:
        try:
            dataset = get_dataset(request.task)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from None
        thread_id = str(uuid.uuid4())
        goal = request.goal or f"predict {dataset.target_column}"
        manager().start(
            thread_id=thread_id, goal=goal, dataset_ref=request.task, budget_usd=request.budget_usd
        )
        return StartRunResponse(thread_id=thread_id, status="running")

    @app.get("/runs")
    def list_runs() -> list[RunStatus]:
        return [manager().status(tid) for tid in manager().thread_ids()]

    @app.get("/runs/{thread_id}")
    def get_run(thread_id: str) -> RunStatus:
        try:
            return manager().status(thread_id)
        except KeyError:
            raise HTTPException(404, f"unknown thread_id {thread_id!r}") from None

    @app.get("/runs/{thread_id}/events")
    def stream_events(thread_id: str) -> StreamingResponse:
        if thread_id not in manager().thread_ids():
            raise HTTPException(404, f"unknown thread_id {thread_id!r}")

        def _sse() -> Iterator[str]:
            for event in manager().stream(thread_id):
                yield f"data: {event.model_dump_json()}\n\n"

        return StreamingResponse(_sse(), media_type="text/event-stream")

    @app.get("/approvals")
    def list_approvals() -> list[PendingApproval]:
        statuses = (manager().status(tid) for tid in manager().thread_ids())
        return [s.pending_approval for s in statuses if s.pending_approval is not None]

    @app.post("/runs/{thread_id}/resume", status_code=202)
    def resume_run(thread_id: str, request: ResumeRequest) -> StartRunResponse:
        try:
            current = manager().status(thread_id)
        except KeyError:
            raise HTTPException(404, f"unknown thread_id {thread_id!r}") from None
        if current.status != "awaiting_approval":
            raise HTTPException(
                409, f"thread_id {thread_id!r} has no pending approval (status={current.status!r})"
            )
        manager().resume(thread_id, {"approved": request.approved, "note": request.note})
        return StartRunResponse(thread_id=thread_id, status="running")

    return app


app = create_app()
