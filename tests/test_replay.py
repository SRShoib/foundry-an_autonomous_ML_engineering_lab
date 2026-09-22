"""Tests for app/replay.py — the recording format that lets the operator console replay a run with
zero API calls. The load-bearing guarantee is that fold_frames is the exact inverse of encode_frame,
because carry-forward encoding (omitting unchanged fields) is only safe if decoding restores every
frame to precisely the RunStatus the API would have returned. web/src/replay/fold.ts is the
TypeScript twin of fold_frames; both are asserted against the same committed recording, so a
disagreement between the two languages fails a test on the real artifact.

Pure functions are tested directly; JsonlRecorder against tmp_path with a controllable clock."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app import replay as replay_module
from app.events import ActivityEvent
from app.replay import (
    CARRY_FORWARD_FIELDS,
    JsonlRecorder,
    Replay,
    ReplayFrame,
    ReplayHeader,
    encode_frame,
    fold_frames,
    list_replays,
    load_replay,
    replay_from_jsonl,
    replay_to_jsonl,
    safe_replay_name,
)
from app.schemas import PendingApproval, RunStatus
from foundry.config import settings
from foundry.models import (
    ColumnProfile,
    DataProfile,
    ExperimentResult,
    LeaderboardEntry,
    RedTeamFinding,
)

_T0 = datetime(2026, 1, 1, tzinfo=UTC)


def _experiment(experiment_id: str) -> ExperimentResult:
    return ExperimentResult(
        experiment_id=experiment_id, status="success", metrics={"roc_auc": 0.9}, cost_usd=0.1,
        duration_s=1.0, code=f"# {experiment_id}", stdout="out", stderr="",
    )


def _finding(experiment_id: str, verdict: str = "valid") -> RedTeamFinding:
    return RedTeamFinding(
        experiment_id=experiment_id, category="leakage",
        verdict=verdict,  # type: ignore[arg-type]
        explanation="e", recommendation="r",
    )


_PROFILE = DataProfile(
    n_rows=10, n_cols=1, target_column="y", task_type="binary_classification",
    columns=[ColumnProfile(name="x", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=3)],
)


def _status(**overrides: object) -> RunStatus:
    return RunStatus(thread_id="t", status="running", **overrides)  # type: ignore[arg-type]


def _event(seq: int, seconds: float, kind: str = "node") -> ActivityEvent:
    return ActivityEvent(
        thread_id="t", seq=seq, ts=_T0 + timedelta(seconds=seconds),
        kind=kind,  # type: ignore[arg-type]
        node="principal", summary=f"event {seq}",
    )


def _story() -> list[RunStatus]:
    """Statuses shaped like a real run: profile lands once, experiments and audits accumulate,
    the report is written and then extended by the final gate's sign-off."""
    exp_a, exp_b = _experiment("exp-001"), _experiment("exp-002")
    return [
        _status(),
        _status(data_profile=_PROFILE),
        _status(data_profile=_PROFILE, experiments=[exp_a]),
        _status(data_profile=_PROFILE, experiments=[exp_a, exp_b], spent_usd=0.4),
        _status(
            data_profile=_PROFILE, experiments=[exp_a, exp_b], spent_usd=0.5,
            invalidations=[_finding("exp-001")],
        ),
        _status(
            data_profile=_PROFILE, experiments=[exp_a, exp_b], invalidations=[_finding("exp-001")],
            report_md="# report", model_card_md="# card", spent_usd=0.5,
        ),
        _status(
            data_profile=_PROFILE, experiments=[exp_a, exp_b], invalidations=[_finding("exp-001")],
            report_md="# report\n\n## Sign-off", model_card_md="# card", spent_usd=0.5,
            leaderboard=[
                LeaderboardEntry(
                    experiment_id="exp-001", mlflow_run_id=None, primary_metric_name="roc_auc",
                    primary_metric_value=0.9, rank=1,
                )
            ],
        ),
    ]


def _encode_all(statuses: list[RunStatus]) -> list[ReplayFrame]:
    frames: list[ReplayFrame] = []
    previous: RunStatus | None = None
    for index, status in enumerate(statuses):
        frames.append(
            ReplayFrame(
                t_offset_s=float(index), event=_event(index, index),
                status=encode_frame(status, previous),
            )
        )
        previous = status
    return frames


def test_encode_frame_omits_unchanged_carry_forward_fields() -> None:
    exp = _experiment("exp-001")
    first = _status(data_profile=_PROFILE, experiments=[exp], report_md="r")
    second = _status(data_profile=_PROFILE, experiments=[exp], report_md="r", spent_usd=1.0)

    encoded = encode_frame(second, first)

    for name in CARRY_FORWARD_FIELDS:
        assert getattr(encoded, name) in (None, [])
    assert encoded.spent_usd == 1.0, "non-carry-forward fields stay verbatim on every frame"


def test_encode_frame_keeps_a_changed_field_and_the_very_first_frame_whole() -> None:
    first = _status(report_md="draft")
    assert encode_frame(first, None) == first
    assert encode_frame(_status(report_md="draft\n\nsigned"), first).report_md == "draft\n\nsigned"


def test_fold_frames_round_trips_every_snapshot() -> None:
    statuses = _story()
    assert fold_frames(_encode_all(statuses)) == statuses


def test_fold_handles_the_report_being_extended_at_the_final_gate() -> None:
    folded = fold_frames(_encode_all(_story()))
    assert folded[-2].report_md == "# report"
    assert folded[-1].report_md == "# report\n\n## Sign-off"


def test_encode_frame_refuses_a_field_that_shrinks_back_to_empty() -> None:
    """Carry-forward reads an empty value as 'unchanged'. If a field ever legitimately returned to
    empty, silently encoding it would corrupt every replay — so it must be loud instead."""
    with_experiment = _status(experiments=[_experiment("exp-001")])
    with pytest.raises(ValueError, match="experiments"):
        encode_frame(_status(experiments=[]), with_experiment)


@pytest.mark.parametrize(
    "name", ["", "..", "../etc/passwd", "a/b", "a\\b", ".hidden", "x" * 65, "a..b", "a b", "a\x00b"]
)
def test_safe_replay_name_rejects_traversal_and_malformed_names(name: str) -> None:
    with pytest.raises(ValueError):
        safe_replay_name(name)


@pytest.mark.parametrize("name", ["demo-churn-leaky", "5c255737-39db-464e-b0d2-d82e7cdc0b3a", "a"])
def test_safe_replay_name_accepts_ordinary_names(name: str) -> None:
    assert safe_replay_name(name) == name


def _header(name: str = "demo", thread_id: str = "t") -> ReplayHeader:
    return ReplayHeader(
        name=name, thread_id=thread_id, task="churn", goal="predict churn", budget_usd=20.0,
        recorded_at=_T0,
    )


def test_jsonl_round_trips_a_whole_replay() -> None:
    statuses = _story()
    frames = _encode_all(statuses)
    closed_header = _header().model_copy(
        update={
            "final_status": statuses[-1],
            "n_frames": len(statuses),
            "duration_s": frames[-1].t_offset_s,
        }
    )
    replay = Replay(header=closed_header, frames=frames)
    lines = list(replay_to_jsonl(replay))
    assert lines[0].startswith('{"kind":"header"')
    assert all(line.startswith('{"kind":"frame"') for line in lines[1:])

    restored = replay_from_jsonl(lines)
    assert restored == replay
    assert fold_frames(restored.frames)[-1] == restored.header.final_status


def test_an_interrupted_recording_is_still_readable_and_trusts_its_frames() -> None:
    """A recorder that crashed never rewrote its header: n_frames is 0, but the frames are there."""
    frames = _encode_all(_story())
    # _header() is exactly what begin() writes on line 1: n_frames=0, duration 0, no final_status.
    lines = list(replay_to_jsonl(Replay(header=_header(), frames=frames)))

    restored = replay_from_jsonl(lines)
    assert restored.header.n_frames == len(frames)
    assert restored.header.duration_s == frames[-1].t_offset_s


def test_replay_from_jsonl_rejects_an_unsupported_version_and_a_missing_header() -> None:
    one_frame = Replay(header=_header(), frames=_encode_all(_story()[:1]))
    frame_line = list(replay_to_jsonl(one_frame))[1]
    with pytest.raises(ValueError, match="no header"):
        replay_from_jsonl([frame_line])
    future_header = _header().model_copy(update={"version": 99})
    future = list(replay_to_jsonl(Replay(header=future_header, frames=[])))
    with pytest.raises(ValueError, match="version"):
        replay_from_jsonl(future)


class _Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock(_T0)

    class _FakeDatetime(datetime):
        @classmethod
        def now(cls, tz: object = None) -> datetime:  # type: ignore[override]
            return fake.now

    monkeypatch.setattr(replay_module, "datetime", _FakeDatetime)
    return fake


def _gate_status() -> RunStatus:
    return RunStatus(
        thread_id="t", status="awaiting_approval",
        pending_approval=PendingApproval(
            thread_id="t", gate="budget", reason="projected over cap", spent_usd=1.0,
            budget_usd=2.0, projected_usd=2.5,
        ),
    )


def test_recorder_excludes_gate_wait_from_offsets_and_records_the_decision(
    tmp_path: Path, clock: _Clock
) -> None:
    """1x must be real agent working time. The recording operator deliberated for 60 s at the
    gate; the replay's own operator does that deliberating live, so it cannot be in the offsets."""
    recorder = JsonlRecorder(tmp_path)
    recorder.begin(thread_id="t", task="churn", goal="g", budget_usd=2.0)

    recorder.record("t", _event(0, 2.0), _status())
    recorder.record("t", _event(1, 2.0, kind="interrupt"), _gate_status())
    clock.now = _T0 + timedelta(seconds=2)
    recorder.pause("t")
    clock.now = _T0 + timedelta(seconds=62)
    recorder.resume("t", approved=True, note="fine")
    recorder.record("t", _event(2, 65.0), _status())
    recorder.close("t", final_status=_status())

    replay = replay_from_jsonl((tmp_path / "t.jsonl").read_text(encoding="utf-8").splitlines())
    assert [frame.t_offset_s for frame in replay.frames] == [2.0, 2.0, 5.0]
    (decision,) = replay.header.decisions
    assert (decision.gate, decision.approved, decision.note) == ("budget", True, "fine")
    assert decision.wait_s == 60.0
    assert replay.header.gate_wait_s == 60.0
    assert replay.header.duration_s == 5.0


def test_recorder_round_trips_through_disk_and_folds_to_the_final_status(
    tmp_path: Path, clock: _Clock
) -> None:
    statuses = _story()
    recorder = JsonlRecorder(tmp_path, name="demo")
    recorder.begin(thread_id="t", task="churn", goal="g", budget_usd=20.0)
    for index, status in enumerate(statuses):
        recorder.record("t", _event(index, index), status)
    recorder.close("t", final_status=statuses[-1])

    replay = load_replay_from(tmp_path / "demo.jsonl")
    assert replay.header.name == "demo"
    assert replay.header.n_frames == len(statuses)
    assert fold_frames(replay.frames) == statuses
    assert fold_frames(replay.frames)[-1] == replay.header.final_status
    assert not (tmp_path / "demo.jsonl.tmp").exists()


def load_replay_from(path: Path) -> Replay:
    return replay_from_jsonl(path.read_text(encoding="utf-8").splitlines())


def test_recorder_ignores_threads_it_did_not_begin(tmp_path: Path) -> None:
    """A run rehydrated after an API restart and resumed has no session — it must not raise."""
    recorder = JsonlRecorder(tmp_path)
    recorder.record("ghost", _event(0, 0.0), _status())
    recorder.pause("ghost")
    recorder.resume("ghost", approved=True, note="")
    recorder.close("ghost", final_status=_status())
    assert list(tmp_path.iterdir()) == []


def test_list_replays_merges_committed_and_recorded_with_committed_winning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    demo_dir, record_dir = tmp_path / "demo", tmp_path / "recorded"
    monkeypatch.setattr(settings, "replay_demo_dir", demo_dir)
    monkeypatch.setattr(settings, "replay_record_dir", record_dir)
    for directory, name, task in [
        (demo_dir, "shipped", "churn_leaky"),
        (record_dir, "local", "churn"),
        (record_dir, "shipped", "shadowed"),
    ]:
        directory.mkdir(parents=True, exist_ok=True)
        header = _header(name=name).model_copy(update={"task": task})
        (directory / f"{name}.jsonl").write_text(
            "\n".join(replay_to_jsonl(Replay(header=header, frames=[]))) + "\n", encoding="utf-8"
        )

    by_name = {summary.name: summary for summary in list_replays()}
    assert set(by_name) == {"shipped", "local"}
    assert (by_name["shipped"].committed, by_name["shipped"].task) == (True, "churn_leaky")
    assert by_name["local"].committed is False


def test_list_replays_tolerates_missing_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "replay_demo_dir", tmp_path / "nope")
    monkeypatch.setattr(settings, "replay_record_dir", tmp_path / "also-nope")
    assert list_replays() == []


def test_load_replay_rejects_traversal_and_reports_unknown_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "replay_demo_dir", tmp_path)
    monkeypatch.setattr(settings, "replay_record_dir", tmp_path)
    (tmp_path.parent / "secret.jsonl").write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError):
        load_replay("../secret")
    with pytest.raises(FileNotFoundError):
        load_replay("does-not-exist")
