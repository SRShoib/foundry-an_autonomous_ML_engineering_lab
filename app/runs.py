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
testable, never an unbounded connection.

M9b: runs survive an API restart. thread_ids() also lists threads found in the checkpointer,
status() derives their state purely from the checkpoint (a thread cut off mid-run reads as
`failed`), and resume() adopts a checkpoint-only thread so a run paused at a gate before the
restart can still be answered after it. Only the event BUFFER is lost — stream() yields one honest
"restored" event.

Recording (app/replay.py) rides the same single funnel every event passes through. Each event waits
for the checkpoint that reflects its own step and is recorded with THAT state: LangGraph yields a
step's "updates" chunk before writing its checkpoint, so reading state at the moment an event
arrives would pair every frame with the previous step's state."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import islice
from typing import Any, cast

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command, Interrupt

from app.events import ActivityEvent, EventContent, to_event
from app.replay import ReplayRecorder
from app.schemas import PendingApproval, RunStatus, RunStatusKind
from foundry.config import settings
from foundry.graph import initial_state, run_config
from foundry.state import FoundryState
from foundry.teams.reporter import cost_by_agent

logger = logging.getLogger(__name__)


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
                thread_id=self.thread_id,
                seq=len(self.events),
                ts=datetime.now(UTC),
                **content._asdict(),
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
    def __init__(
        self, graph: CompiledStateGraph, recorder: ReplayRecorder | None = None
    ) -> None:
        self._graph = graph
        self._recorder = recorder
        self._handles: dict[str, RunHandle] = {}
        self._registry_lock = threading.Lock()

    def _recording(self, action: str, thread_id: str, call: Callable[[], None]) -> None:
        """Recording is a side channel: a full disk or an unencodable frame must never fail the
        run it is merely observing."""
        if self._recorder is None:
            return
        try:
            call()
        except Exception:  # noqa: BLE001 — see docstring
            logger.warning("replay %s failed for %s; the run continues", action, thread_id,
                           exc_info=True)

    def _record_at_checkpoint(
        self, handle: RunHandle, events: list[ActivityEvent], checkpoint: dict[str, Any]
    ) -> None:
        def _record() -> None:
            assert self._recorder is not None
            # Projected from the chunk itself, NOT re-fetched with get_state(checkpoint config):
            # LangGraph's default durability is async, so this chunk is emitted before the
            # checkpoint has landed in the saver, and a get_state by its id returns an empty
            # snapshot for most checkpoints (verified). The chunk carries the same live state
            # objects, and never carries interrupts mid-leg — those are read once the leg settles.
            # updated_at is omitted (stays None): the "checkpoints" stream payload is built from
            # map_debug_checkpoint's own dict (values/next/tasks/metadata/config), which carries no
            # timestamp — unlike get_state()'s StateSnapshot, which the other two call sites use.
            status = self._project(
                handle.thread_id, handle, checkpoint["values"], (), checkpoint["next"]
            )
            for event in events:
                self._recorder.record(handle.thread_id, event, status)

        self._recording("frame", handle.thread_id, _record)

    def _record_settled(
        self, thread_id: str, events: list[ActivityEvent], *, failure: str | None = None
    ) -> None:
        """Flush the events a leg ended on with the settled status, then close or pause the file.

        Must run BEFORE handle.finish(). A client only sees `awaiting_approval` once finish() has
        run, so recording the pause first means it cannot resume until the pause is on record. The
        other order lets a fast resume reach the recorder ahead of pause(): the operator's decision
        is dropped and the late pause() then mis-times the next leg."""

        def _record() -> None:
            assert self._recorder is not None
            snapshot = self._graph.get_state(run_config(thread_id))
            status = self._project(
                thread_id, None, snapshot.values or {}, snapshot.interrupts, snapshot.next,
                failure=failure, updated_at=snapshot.created_at,
            )
            for event in events:
                self._recorder.record(thread_id, event, status)
            if status.status in ("completed", "failed"):
                self._recorder.close(thread_id, final_status=status)
            else:
                self._recorder.pause(thread_id)

        self._recording("settle", thread_id, _record)

    def _run(self, thread_id: str, graph_input: FoundryState | Command) -> None:
        handle = self._handles[thread_id]
        config = run_config(thread_id)
        # LangGraph yields a step's "updates" chunk BEFORE writing that step's checkpoint, so
        # get_state() at the moment an event arrives is one step stale (verified: at the data_team
        # update, get_state has no data_profile yet). A recording must pair each event with the
        # state AFTER its step, so events wait here for the "checkpoints" chunk that follows, which
        # carries exactly that post-step state. Buffering does not distort replay timing: each
        # event keeps its own server-side ts.
        pending: list[ActivityEvent] = []
        try:
            # Multiple stream modes yield (mode, chunk) tuples; LangGraph's overloads don't type it.
            chunks = cast(
                "Iterator[tuple[str, dict[str, Any]]]",
                self._graph.stream(graph_input, config, stream_mode=["updates", "checkpoints"]),
            )
            for mode, payload in chunks:
                if mode == "updates":
                    pending.append(handle.append(to_event(payload)))
                elif pending:
                    self._record_at_checkpoint(handle, pending, payload)
                    pending = []
        except Exception as exc:  # noqa: BLE001 — surfaced to API clients, never swallowed
            pending.append(handle.append(EventContent(kind="error", node=None, summary=str(exc))))
            self._record_settled(thread_id, pending, failure=str(exc))
            handle.finish(error=str(exc))
            return
        snapshot = self._graph.get_state(config)
        summary = "awaiting approval" if snapshot.interrupts else "run complete"
        pending.append(handle.append(EventContent(kind="done", node=None, summary=summary)))
        self._record_settled(thread_id, pending)
        handle.finish()

    def start(self, *, thread_id: str, goal: str, dataset_ref: str, budget_usd: float) -> None:
        with self._registry_lock:
            if thread_id in self._handles:
                raise ValueError(f"thread_id {thread_id!r} already exists")
            self._handles[thread_id] = RunHandle(thread_id=thread_id)
        if self._recorder is not None:
            recorder = self._recorder
            self._recording(
                "begin",
                thread_id,
                lambda: recorder.begin(
                    thread_id=thread_id, task=dataset_ref, goal=goal, budget_usd=budget_usd
                ),
            )
        state = initial_state(goal=goal, dataset_ref=dataset_ref, budget_usd=budget_usd)
        threading.Thread(target=self._run, args=(thread_id, state), daemon=True).start()

    def resume(self, thread_id: str, decision: dict[str, Any]) -> None:
        with self._registry_lock:
            handle = self._handles.get(thread_id)
        if handle is None:
            handle = self._adopt(thread_id)
        if self._recorder is not None:
            recorder = self._recorder
            self._recording(
                "resume",
                thread_id,
                lambda: recorder.resume(
                    thread_id,
                    approved=bool(decision.get("approved")),
                    note=str(decision.get("note", "")),
                ),
            )
        handle.begin_leg()
        threading.Thread(
            target=self._run, args=(thread_id, Command(resume=decision)), daemon=True
        ).start()

    def _adopt(self, thread_id: str) -> RunHandle:
        """Give a thread that exists only as a checkpoint a live handle, so it can be resumed.

        That is the point of a checkpointer-backed interrupt(): a run paused at a gate before an
        API restart is still resumable after it. The adopted handle's event buffer starts empty —
        only the resumed leg streams; the earlier legs' events died with the old process."""
        if self._graph.get_state(run_config(thread_id)).created_at is None:
            raise KeyError(thread_id)
        adopted = RunHandle(thread_id=thread_id, running=False)
        with self._registry_lock:
            return self._handles.setdefault(thread_id, adopted)

    def _persisted_thread_ids(self, exclude: set[str]) -> list[str]:
        saver = self._graph.checkpointer
        remaining = settings.api_max_runs - len(exclude)
        if not isinstance(saver, BaseCheckpointSaver) or remaining <= 0:
            return []
        found: dict[str, None] = {}
        for checkpoint in islice(saver.list(None), settings.api_checkpoint_scan_limit):
            thread_id = checkpoint.config.get("configurable", {}).get("thread_id")
            if thread_id is not None and thread_id not in exclude:
                found.setdefault(thread_id, None)
            if len(found) >= remaining:
                break
        return list(found)

    def thread_ids(self) -> list[str]:
        """This process's own runs first, then checkpointed runs from before it started, bounded
        by settings.api_max_runs (see foundry/config.py for why two limits)."""
        with self._registry_lock:
            live = list(self._handles)
        return live + self._persisted_thread_ids(set(live))

    def exists(self, thread_id: str) -> bool:
        """Unbounded, unlike thread_ids(): a run older than the listing cap is still a real run."""
        if thread_id in self._handles:
            return True
        return self._graph.get_state(run_config(thread_id)).created_at is not None

    def stream(self, thread_id: str) -> Iterator[ActivityEvent]:
        handle = self._handles.get(thread_id)
        if handle is None:
            # Checkpoint-only thread: state survived a restart, its event history did not. One
            # honest terminal event beats a 500 — the client refetches GET /runs/{id} on EOF.
            yield ActivityEvent(
                thread_id=thread_id,
                seq=0,
                ts=datetime.now(UTC),
                kind="done",
                summary="run restored from a checkpoint; live event history is not available",
            )
            return
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
        snapshot = self._graph.get_state(run_config(thread_id))
        # An unknown thread_id yields an empty snapshot (created_at None), never an exception —
        # so this, not the get_state call, is what keeps GET /runs/{id}'s 404 path intact.
        if handle is None and snapshot.created_at is None:
            raise KeyError(thread_id)
        return self._project(
            thread_id, handle, snapshot.values or {}, snapshot.interrupts, snapshot.next,
            updated_at=snapshot.created_at,
        )

    def _project(
        self,
        thread_id: str,
        handle: RunHandle | None,
        values: Mapping[str, Any],
        interrupts: Sequence[Interrupt],
        next_nodes: Sequence[str],
        *,
        failure: str | None = None,
        updated_at: str | None = None,
    ) -> RunStatus:
        pending_approval: PendingApproval | None = None
        if interrupts:
            payload = interrupts[0].value
            pending_approval = PendingApproval(thread_id=thread_id, **payload)

        error: str | None = None
        kind: RunStatusKind
        if failure is not None:
            # A leg that raised: recording asks for its status before handle.error is set.
            kind, error = "failed", failure
        elif handle is None:
            # No live worker in this process: the checkpoint is the only truth. A thread that is
            # neither paused at a gate nor finished was cut off mid-run (an API restart, or
            # another process's run). Reported as `failed` rather than a fifth status kind, which
            # would change docs/design-plan.md's contract.
            if interrupts:
                kind = "awaiting_approval"
            elif not next_nodes:
                kind = "completed"
            else:
                kind = "failed"
                error = (
                    "run has no live worker in this API process; "
                    "it was interrupted before finishing"
                )
        else:
            error = handle.error
            # handle.running gates everything else: a brand-new thread_id has an empty snapshot
            # (values={}, next=()) before its background thread has produced a single checkpoint,
            # which would otherwise misread as "completed" rather than "hasn't started yet". Only
            # once the current leg has actually finished (running is False) is it safe to ask
            # get_state what it finished AT — awaiting_approval (paused on an interrupt) or
            # completed (reached END) — since by then the checkpoint is durably written.
            if handle.error:
                kind = "failed"
            elif handle.running:
                kind = "running"
            elif interrupts:
                kind = "awaiting_approval"
            elif not next_nodes:
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
            error=error,
            experiments=values.get("experiments", []),
            invalidations=values.get("invalidations", []),
            model_card_md=values.get("model_card_md"),
            data_profile=values.get("data_profile"),
            cost_by_agent=cost_by_agent(values.get("costs", [])),
            goal=values.get("goal"),
            dataset_ref=values.get("dataset_ref"),
            updated_at=updated_at,
        )
