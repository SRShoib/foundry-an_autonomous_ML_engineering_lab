"""Run recording and replay (SPEC M9: "Record every run's event stream to JSONL. The UI can replay
a recorded run at 1x/4x/16x with zero API calls"). A recording has to drive the WHOLE console —
leaderboard, budget meter, both approval gates, the red-team audit strip, the report — not just the
feed, and ActivityEvent carries only a one-line summary and a spend figure. So a frame is one event
plus the RunStatus the API would have returned immediately after it: live and replay then produce
the same generated type, and no component needs to know which it is reading.

RunStatus is dominated by five fields that repeat unchanged in almost every frame (experiments carry
agent-written code and two 4 KB output tails each). Frames therefore omit a field when it has not
changed since the previous frame — "carry-forward" encoding. `None` / `[]` in a frame's status means
"same as before", never "the real value is empty". That is sound only because these fields never
return to empty once set: report_md, model_card_md and data_profile are write-once channels, and
experiments / invalidations are add-reducer channels in foundry/state.py that only grow.
encode_frame raises rather than silently corrupt a recording if that ever stops being true. The
un-encoded final status is kept whole in the header, so any reader can prove its fold is correct
against it.

Pure functions (encode_frame, fold_frames, the JSONL codecs) do no I/O; JsonlRecorder owns the
files and is the only impure part. web/src/replay/fold.ts is the TypeScript twin of fold_frames, and
both are asserted against the same committed recording."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from collections.abc import Iterable, Iterator, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from app.events import ActivityEvent
from app.schemas import RunStatus
from foundry.config import settings
from foundry.models import WIRE_CONFIG

logger = logging.getLogger(__name__)

REPLAY_FORMAT_VERSION = 1

CARRY_FORWARD_FIELDS: tuple[str, ...] = (
    "report_md",
    "model_card_md",
    "data_profile",
    "experiments",
    "invalidations",
)

_REPLAY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ReplayDecision(BaseModel):
    """What the operator did at a gate while the recording was made."""

    model_config = WIRE_CONFIG

    gate: Literal["budget", "final"]
    approved: bool
    note: str = ""
    t_offset_s: float  # replay clock when the gate was reached
    wait_s: float  # how long the recording operator deliberated; excluded from every offset


class ReplayHeader(BaseModel):
    model_config = WIRE_CONFIG
    version: int = REPLAY_FORMAT_VERSION
    name: str
    thread_id: str
    task: str
    goal: str
    budget_usd: float
    recorded_at: datetime
    duration_s: float = 0.0  # agent working time — gate waits are excluded, so 1x is real speed
    gate_wait_s: float = 0.0
    n_frames: int = 0
    decisions: list[ReplayDecision] = Field(default_factory=list)
    # The full, NOT carry-forward-encoded status after the last event: the conformance anchor that
    # fold_frames(frames)[-1] must equal. None while a recording is still in progress.
    final_status: RunStatus | None = None


class ReplayFrame(BaseModel):
    """`status` is carry-forward ENCODED — it is not a standalone RunStatus. Read it only through
    fold_frames() here or foldFrames() in web/src/replay/fold.ts."""

    model_config = WIRE_CONFIG

    t_offset_s: float
    event: ActivityEvent
    status: RunStatus


class Replay(BaseModel):
    model_config = WIRE_CONFIG
    header: ReplayHeader
    frames: list[ReplayFrame]


class ReplaySummary(BaseModel):
    model_config = WIRE_CONFIG
    name: str
    thread_id: str
    task: str
    goal: str
    recorded_at: datetime
    duration_s: float
    n_frames: int
    committed: bool = Field(description="a shipped demo (replay_demo_dir), not a local recording")


def _empty(field_name: str) -> Any:
    return RunStatus.model_fields[field_name].get_default(call_default_factory=True)


def encode_frame(status: RunStatus, previous: RunStatus | None) -> RunStatus:
    """Blank every carry-forward field that is unchanged since `previous` (a FULL status)."""
    if previous is None:
        return status
    blanked: dict[str, Any] = {}
    for name in CARRY_FORWARD_FIELDS:
        current, prior = getattr(status, name), getattr(previous, name)
        if current == prior:
            blanked[name] = _empty(name)
        elif current == _empty(name):
            raise ValueError(
                f"{name} went from a value back to empty; carry-forward encoding would lose "
                "that — the field is no longer write-once/append-only"
            )
    return status.model_copy(update=blanked)


def fold_frames(frames: Sequence[ReplayFrame]) -> list[RunStatus]:
    """The exact inverse of encode_frame: one complete RunStatus per frame."""
    carried: dict[str, Any] = {name: _empty(name) for name in CARRY_FORWARD_FIELDS}
    folded: list[RunStatus] = []
    for frame in frames:
        restored: dict[str, Any] = {}
        for name in CARRY_FORWARD_FIELDS:
            value = getattr(frame.status, name)
            if value == _empty(name):
                restored[name] = carried[name]
            else:
                carried[name] = value
        folded.append(frame.status.model_copy(update=restored))
    return folded


def safe_replay_name(name: str) -> str:
    """The one place a URL path segment becomes a filename — a real trust boundary."""
    if not _REPLAY_NAME.fullmatch(name) or ".." in name:
        raise ValueError(f"invalid replay name {name!r}")
    return name


def replay_to_jsonl(replay: Replay) -> Iterator[str]:
    """Line 1 is the header, every later line one frame. JSONL rather than one JSON document so a
    recorder can append during a live run and a crash mid-run still leaves a readable prefix."""
    yield _dump({"kind": "header", **replay.header.model_dump(mode="json")})
    for frame in replay.frames:
        yield _dump({"kind": "frame", **frame.model_dump(mode="json")})


def replay_from_jsonl(lines: Iterable[str]) -> Replay:
    header: ReplayHeader | None = None
    frames: list[ReplayFrame] = []
    for line in lines:
        if not line.strip():
            continue
        payload = json.loads(line)
        kind = payload.pop("kind", None)
        if kind == "header" and header is None:
            header = ReplayHeader.model_validate(payload)
        elif kind == "frame":
            frames.append(ReplayFrame.model_validate(payload))
        else:
            raise ValueError(f"unexpected replay line kind {kind!r}")
    if header is None:
        raise ValueError("replay has no header line")
    if header.version != REPLAY_FORMAT_VERSION:
        raise ValueError(f"unsupported replay version {header.version}")
    # An interrupted recording never got its closing rewrite: trust the frames over the header.
    header.n_frames = len(frames)
    if frames:
        header.duration_s = max(header.duration_s, frames[-1].t_offset_s)
    return Replay(header=header, frames=frames)


def _dump(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


class ReplayRecorder(Protocol):
    """What app/runs.py's RunManager calls. RunManager is the single funnel every event passes
    through, so recording needs no other hook."""

    def begin(self, *, thread_id: str, task: str, goal: str, budget_usd: float) -> None: ...

    def record(self, thread_id: str, event: ActivityEvent, status: RunStatus) -> None: ...

    def pause(self, thread_id: str) -> None: ...

    def resume(self, thread_id: str, *, approved: bool, note: str) -> None: ...

    def close(self, thread_id: str, *, final_status: RunStatus) -> None: ...


class _Session:
    def __init__(self, path: Path, header: ReplayHeader) -> None:
        self.path = path
        self.header = header
        self.frames: list[ReplayFrame] = []
        self.previous: RunStatus | None = None
        self.excluded_s = 0.0
        self.paused_at: datetime | None = None
        self.pause_offset_s = 0.0
        self.pause_status: RunStatus | None = None


class JsonlRecorder:
    """Appends each frame to a JSONL file as it happens, then rewrites the file once at close with
    the final header. Sessions belong to the recorder that began them: a run rehydrated after an API
    restart and then resumed has no session here, so record/pause/resume for it are no-ops — the
    partial file from the original process stays as it was."""

    def __init__(self, directory: Path, *, name: str | None = None) -> None:
        self._directory = directory
        self._fixed_name = name
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()

    def begin(self, *, thread_id: str, task: str, goal: str, budget_usd: float) -> None:
        name = safe_replay_name(self._fixed_name or thread_id)
        self._directory.mkdir(parents=True, exist_ok=True)
        header = ReplayHeader(
            name=name,
            thread_id=thread_id,
            task=task,
            goal=goal,
            budget_usd=budget_usd,
            recorded_at=datetime.now(UTC),
        )
        session = _Session(self._directory / f"{name}.jsonl", header)
        with session.path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(_dump({"kind": "header", **header.model_dump(mode="json")}) + "\n")
        with self._lock:
            self._sessions[thread_id] = session

    def _session(self, thread_id: str) -> _Session | None:
        with self._lock:
            return self._sessions.get(thread_id)

    def record(self, thread_id: str, event: ActivityEvent, status: RunStatus) -> None:
        session = self._session(thread_id)
        if session is None:
            return
        elapsed = (event.ts - session.header.recorded_at).total_seconds() - session.excluded_s
        frame = ReplayFrame(
            t_offset_s=round(max(0.0, elapsed), 3),
            event=event,
            status=encode_frame(status, session.previous),
        )
        session.frames.append(frame)
        session.previous = status
        with session.path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(_dump({"kind": "frame", **frame.model_dump(mode="json")}) + "\n")

    def pause(self, thread_id: str) -> None:
        session = self._session(thread_id)
        if session is None or session.paused_at is not None:
            return
        session.paused_at = datetime.now(UTC)
        session.pause_status = session.previous
        session.pause_offset_s = session.frames[-1].t_offset_s if session.frames else 0.0

    def resume(self, thread_id: str, *, approved: bool, note: str) -> None:
        session = self._session(thread_id)
        if session is None or session.paused_at is None:
            return
        waited = (datetime.now(UTC) - session.paused_at).total_seconds()
        pending = session.pause_status.pending_approval if session.pause_status else None
        session.header.decisions.append(
            ReplayDecision(
                gate=pending.gate if pending else "final",
                approved=approved,
                note=note,
                t_offset_s=session.pause_offset_s,
                wait_s=round(waited, 3),
            )
        )
        session.excluded_s += waited
        session.paused_at = None

    def close(self, thread_id: str, *, final_status: RunStatus) -> None:
        with self._lock:
            session = self._sessions.pop(thread_id, None)
        if session is None:
            return
        header = session.header
        header.final_status = final_status
        header.n_frames = len(session.frames)
        header.duration_s = session.frames[-1].t_offset_s if session.frames else 0.0
        header.gate_wait_s = round(sum(d.wait_s for d in header.decisions), 3)
        replay = Replay(header=header, frames=session.frames)
        scratch = session.path.with_suffix(".jsonl.tmp")
        with scratch.open("w", encoding="utf-8", newline="\n") as handle:
            for line in replay_to_jsonl(replay):
                handle.write(line + "\n")
        os.replace(scratch, session.path)


def _replay_dirs() -> list[tuple[Path, bool]]:
    """(directory, committed) in lookup order: shipped demos shadow local recordings."""
    return [(settings.replay_demo_dir, True), (settings.replay_record_dir, False)]


def list_replays() -> list[ReplaySummary]:
    summaries: dict[str, ReplaySummary] = {}
    for directory, committed in _replay_dirs():
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.jsonl")):
            try:
                replay = replay_from_jsonl(path.read_text(encoding="utf-8").splitlines())
            except (ValueError, OSError):
                logger.warning("skipping unreadable replay %s", path, exc_info=True)
                continue
            header = replay.header
            summaries.setdefault(
                header.name,
                ReplaySummary(
                    name=header.name,
                    thread_id=header.thread_id,
                    task=header.task,
                    goal=header.goal,
                    recorded_at=header.recorded_at,
                    duration_s=header.duration_s,
                    n_frames=header.n_frames,
                    committed=committed,
                ),
            )
    return sorted(summaries.values(), key=lambda s: s.recorded_at, reverse=True)


def load_replay(name: str) -> Replay:
    """Raises ValueError for an unsafe name and FileNotFoundError for an unknown one."""
    safe = safe_replay_name(name)
    for directory, _committed in _replay_dirs():
        path = directory / f"{safe}.jsonl"
        if path.is_file():
            return replay_from_jsonl(path.read_text(encoding="utf-8").splitlines())
    raise FileNotFoundError(safe)
