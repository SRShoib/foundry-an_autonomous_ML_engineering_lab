"""FastAPI control plane (SPEC M6: "FastAPI (start run, stream events, list pending approvals,
resume)"). create_app() takes a checkpointer-context-manager factory, mirroring foundry/cli.py's
own --checkpointer switch (Postgres for `make api`, InMemorySaver via nullcontext for tests) —
the checkpointer is opened once in the app's lifespan and kept open for the process's lifetime,
never per-request, matching foundry/cli.py's own `with checkpointer_cm as checkpointer:` pattern.
Actual graph execution never runs inside a request handler: app/runs.py's RunManager does that on
a background thread, since foundry's sandboxed experiment runners make real, possibly
minutes-long Docker calls that must never block the event loop.

M7: a `store_factory` mirrors `checkpointer_factory` exactly (Postgres default for `make api`,
`nullcontext(InMemoryStore())` for tests/test_api.py) — the same reason foundry/cli.py opens both
together: cross-run lessons should follow whichever backend the checkpointer uses, not be a
separate switch to keep in sync.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import AbstractContextManager, asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.sse import EventSourceResponse
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.store.base import BaseStore
from langgraph.store.postgres import PostgresStore
from pydantic import ValidationError

from app.events import ActivityEvent
from app.replay import JsonlRecorder, Replay, ReplaySummary, list_replays, load_replay
from app.runs import RunManager
from app.schemas import (
    DatasetOption,
    PendingApproval,
    ResumeRequest,
    RunStatus,
    StartRunRequest,
    StartRunResponse,
)
from foundry.config import settings
from foundry.datasets import REGISTRY, get_dataset
from foundry.eval.harness import TaskResult
from foundry.graph import build_graph
from foundry.models import ExperimentResult
from foundry.stubs import install_canned_responses

CheckpointerFactory = Callable[[], AbstractContextManager[BaseCheckpointSaver]]
StoreFactory = Callable[[], AbstractContextManager[BaseStore]]


def _default_checkpointer_factory() -> AbstractContextManager[BaseCheckpointSaver]:
    return PostgresSaver.from_conn_string(settings.database_url)


def _default_store_factory() -> AbstractContextManager[BaseStore]:
    return PostgresStore.from_conn_string(settings.database_url)


def create_app(
    checkpointer_factory: CheckpointerFactory = _default_checkpointer_factory,
    store_factory: StoreFactory = _default_store_factory,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if not settings.openai_api_key:
            install_canned_responses()
        with checkpointer_factory() as checkpointer, store_factory() as store:
            if isinstance(checkpointer, PostgresSaver):
                checkpointer.setup()
            if isinstance(store, PostgresStore):
                store.setup()
            graph = build_graph(checkpointer, store)
            recorder = (
                JsonlRecorder(settings.replay_record_dir)
                if settings.replay_recording_enabled
                else None
            )
            app.state.run_manager = RunManager(graph, recorder)
            yield

    app = FastAPI(title="foundry", lifespan=lifespan)

    def manager() -> RunManager:
        return app.state.run_manager

    def require_thread(thread_id: str) -> None:
        # A dependency, not a check inside stream_events: a generator endpoint's body does not
        # run until iteration starts, which is after the 200 status line has been sent — a raise
        # there could no longer become a 404. Dependencies resolve before the endpoint is called.
        if not manager().exists(thread_id):
            raise HTTPException(404, f"unknown thread_id {thread_id!r}")

    @app.get("/datasets")
    def list_datasets() -> list[DatasetOption]:
        # M9e: the start-a-run panel's dataset select (docs/design-plan.md §6). Sorted by key so the
        # select's order is stable across restarts rather than dict-insertion-order.
        return [DatasetOption.from_spec(key, REGISTRY[key]) for key in sorted(REGISTRY)]

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

    @app.get(
        "/runs/{thread_id}/events",
        response_class=EventSourceResponse,
        dependencies=[Depends(require_thread)],
    )
    def stream_events(thread_id: str) -> Iterator[ActivityEvent]:
        # FastAPI's native SSE support is what puts ActivityEvent into the OpenAPI schema (a
        # StreamingResponse return annotation documents nothing), so the console's event type is
        # generated, never hand-written. It also emits keepalive comments during quiet stretches.
        yield from manager().stream(thread_id)

    @app.get("/runs/{thread_id}/experiments")
    def get_experiments(thread_id: str) -> list[ExperimentResult]:
        try:
            return manager().status(thread_id).experiments
        except KeyError:
            raise HTTPException(404, f"unknown thread_id {thread_id!r}") from None

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

    @app.get("/eval")
    def get_eval_results() -> list[TaskResult]:
        path = settings.artifacts_dir / "eval" / "results.json"
        if not path.is_file():
            raise HTTPException(404, "no eval results yet; run `make eval`")
        try:
            return [TaskResult.model_validate(row) for row in json.loads(path.read_text("utf-8"))]
        except (ValueError, ValidationError) as exc:
            raise HTTPException(
                500, f"{path} is unreadable ({exc.__class__.__name__}); rerun `make eval`"
            ) from None

    @app.get("/replays")
    def get_replays() -> list[ReplaySummary]:
        return list_replays()

    @app.get("/replays/{name}")
    def get_replay(name: str) -> Replay:
        try:
            return load_replay(name)
        except (ValueError, FileNotFoundError):
            raise HTTPException(404, f"unknown replay {name!r}") from None

    return app


app = create_app()
