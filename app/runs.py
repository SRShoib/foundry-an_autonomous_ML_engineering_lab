"""Background execution + activity-feed buffering (SPEC M6: "start run, stream events, list
pending approvals, resume"). graph.stream(...) genuinely runs on a background thread —
foundry's sandboxed experiment runners make real Docker calls that can take minutes, and a
FastAPI request handler must never block on that (app/main.py's endpoints only ever start a
thread or read already-computed state).

Status (running / awaiting_approval / completed / failed) is derived from graph.get_state(config)
— .interrupts and .next are the checkpointer's own source of truth for "is this run paused" —
rather than tracked as a second, driftable copy in RunHandle. RunHandle contributes only the
activity-feed buffer and whether the background thread is still alive / raised.

Resuming does not reset RunHandle.events: a later `GET /events` call after a resume simply opens
a new stream, which replays the full history (including earlier legs) and then follows the new
leg live, terminating again at the next pause or completion — so each HTTP response is finite and
testable, never an unbounded connection."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from app.events import ActivityEvent, EventContent, to_event
from app.schemas import PendingApproval, RunStatus, RunStatusKind
from foundry.graph import initial_state, run_config
from foundry.state import FoundryState


@dataclass
class RunHandle:
    thread_id: str
    events: list[ActivityEvent] = field(default_factory=list)
    running: bool = True
    error: str | None = None
    condition: threading.Condition = field(default_factory=threading.Condition)

    def append(self, content: EventContent) -> ActivityEvent:
        with self.condition:
            event = ActivityEvent(
                thread_id=self.thread_id, seq=len(self.events), **content._asdict()
            )
            self.events.append(event)
            self.condition.notify_all()
            return event

    def begin_leg(self) -> None:
        with self.condition:
            self.running = True
            self.error = None
            self.condition.notify_all()

    def finish(self, *, error: str | None = None) -> None:
        with self.condition:
            self.running = False
            self.error = error
            self.condition.notify_all()


class RunManager:
    def __init__(self, graph: CompiledStateGraph) -> None:
        self._graph = graph
        self._handles: dict[str, RunHandle] = {}
        self._registry_lock = threading.Lock()

    def _run(self, thread_id: str, graph_input: FoundryState | Command) -> None:
        handle = self._handles[thread_id]
        config = run_config(thread_id)
        try:
            for chunk in self._graph.stream(graph_input, config, stream_mode="updates"):
                handle.append(to_event(chunk))
        except Exception as exc:  # noqa: BLE001 — surfaced to API clients, never swallowed
            handle.append(EventContent(kind="error", node=None, summary=str(exc)))
            handle.finish(error=str(exc))
            return
        snapshot = self._graph.get_state(config)
        summary = "awaiting approval" if snapshot.interrupts else "run complete"
        handle.append(EventContent(kind="done", node=None, summary=summary))
        handle.finish()

    def start(self, *, thread_id: str, goal: str, dataset_ref: str, budget_usd: float) -> None:
        with self._registry_lock:
            if thread_id in self._handles:
                raise ValueError(f"thread_id {thread_id!r} already exists")
            self._handles[thread_id] = RunHandle(thread_id=thread_id)
        state = initial_state(goal=goal, dataset_ref=dataset_ref, budget_usd=budget_usd)
        threading.Thread(target=self._run, args=(thread_id, state), daemon=True).start()

    def resume(self, thread_id: str, decision: dict[str, Any]) -> None:
        with self._registry_lock:
            handle = self._handles.get(thread_id)
        if handle is None:
            raise KeyError(thread_id)
        handle.begin_leg()
        threading.Thread(
            target=self._run, args=(thread_id, Command(resume=decision)), daemon=True
        ).start()

    def thread_ids(self) -> list[str]:
        with self._registry_lock:
            return list(self._handles)

    def stream(self, thread_id: str) -> Iterator[ActivityEvent]:
        handle = self._handles[thread_id]
        index = 0
        while True:
            with handle.condition:
                handle.condition.wait_for(
                    lambda idx=index: len(handle.events) > idx or not handle.running, timeout=1.0
                )
                batch = handle.events[index:]
                running = handle.running
            yield from batch
            index += len(batch)
            if not running and index >= len(handle.events):
                return

    def status(self, thread_id: str) -> RunStatus:
        handle = self._handles.get(thread_id)
        if handle is None:
            raise KeyError(thread_id)
        config = run_config(thread_id)
        snapshot = self._graph.get_state(config)
        values = snapshot.values or {}

        pending_approval: PendingApproval | None = None
        if snapshot.interrupts:
            payload = snapshot.interrupts[0].value
            pending_approval = PendingApproval(thread_id=thread_id, **payload)

        # handle.running gates everything else: a brand-new thread_id has an empty snapshot
        # (values={}, next=()) before its background thread has produced a single checkpoint,
        # which would otherwise misread as "completed" rather than "hasn't started yet". Only
        # once the current leg has actually finished (running is False) is it safe to ask
        # get_state what it finished AT — awaiting_approval (paused on an interrupt) or
        # completed (reached END) — since by then the checkpoint is durably written.
        kind: RunStatusKind
        if handle.error:
            kind = "failed"
        elif handle.running:
            kind = "running"
        elif snapshot.interrupts:
            kind = "awaiting_approval"
        elif not snapshot.next:
            kind = "completed"
        else:
            kind = "running"

        return RunStatus(
            thread_id=thread_id,
            status=kind,
            stop_reason=values.get("stop_reason"),
            spent_usd=values.get("spent_usd", 0.0),
            budget_usd=values.get("budget_usd", 0.0),
            leaderboard=values.get("leaderboard", []),
            pending_approval=pending_approval,
            report_md=values.get("report_md"),
            error=handle.error,
        )
