"""Guards the committed demo recording, web/public/replays/demo-churn-leaky.jsonl. SPEC M9: "Ship
one recorded demo run that includes the red team catching the booby-trapped dataset" — the console's
Playwright e2e, the README GIF and every UI stage from M9c on are built against this one file, so a
re-recording that quietly lost the red-team catch, a gate, or the MLflow links would break them
without any obvious cause. The recording is made against real Docker by `make record-replay`; these
tests only read it, so they run offline and need no services."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.replay import Replay, fold_frames, replay_from_jsonl
from app.schemas import RunStatus

_REPO = Path(__file__).resolve().parent.parent
_DEMO = _REPO / "web" / "public" / "replays" / "demo-churn-leaky.jsonl"


@pytest.fixture(scope="module")
def demo() -> Replay:
    assert _DEMO.is_file(), f"{_DEMO} is missing; run `make record-replay` (needs Docker)"
    return replay_from_jsonl(_DEMO.read_text(encoding="utf-8").splitlines())


@pytest.fixture(scope="module")
def folded(demo: Replay) -> list[RunStatus]:
    return fold_frames(demo.frames)


def test_the_demo_was_closed_and_folds_to_its_own_final_status(
    demo: Replay, folded: list[RunStatus]
) -> None:
    """The cross-language anchor: web/src/replay/fold.test.ts asserts the same equality with the
    TypeScript fold against this same file."""
    assert demo.header.final_status is not None
    assert demo.header.final_status.status == "completed"
    assert folded[-1] == demo.header.final_status
    assert demo.header.n_frames == len(demo.frames) > 20


def test_the_demo_includes_both_approval_gates_in_order(demo: Replay) -> None:
    assert [d.gate for d in demo.header.decisions] == ["budget", "final"]
    assert all(d.approved for d in demo.header.decisions)
    gate_frames = [i for i, f in enumerate(demo.frames) if f.status.pending_approval is not None]
    assert gate_frames, "the player pauses on frames that carry a pending_approval"


def test_the_demo_catches_the_booby_trapped_leak(folded: list[RunStatus]) -> None:
    caught = [f for f in folded[-1].invalidations if f.verdict == "invalidated"]
    assert caught and all(f.category == "leakage" for f in caught)
    ranked = {entry.experiment_id for entry in folded[-1].leaderboard}
    assert not ranked & {f.experiment_id for f in caught}, "an invalidated run must leave the board"


def test_the_leak_appears_in_the_frame_where_the_red_team_found_it(
    demo: Replay, folded: list[RunStatus]
) -> None:
    first_audit = next(i for i, f in enumerate(demo.frames) if f.event.node == "red_team")
    assert any(f.verdict == "invalidated" for f in folded[first_audit].invalidations)
    assert not folded[first_audit - 1].invalidations


def test_the_demo_carries_what_the_experiment_drawer_needs(folded: list[RunStatus]) -> None:
    experiments = folded[-1].experiments
    assert len(experiments) >= 3
    for experiment in experiments:
        assert experiment.code, f"{experiment.experiment_id} lost its agent-written code"
        assert experiment.stdout, f"{experiment.experiment_id} lost its sandbox output"
        assert experiment.mlflow_run_id, (
            f"{experiment.experiment_id} has no MLflow run id; the recording was made with "
            "MLflow down or logging failing (see scripts/record_replay.py's UTF-8 guard)"
        )


def test_event_times_are_non_decreasing_and_match_the_header(demo: Replay) -> None:
    offsets = [frame.t_offset_s for frame in demo.frames]
    assert offsets == sorted(offsets)
    assert offsets[-1] == demo.header.duration_s
    assert [f.event.seq for f in demo.frames] == list(range(len(demo.frames)))


def test_the_demo_holds_no_host_paths_or_secrets() -> None:
    text = _DEMO.read_text(encoding="utf-8")
    for needle in ("C:\\", "C:/", "/Users/", "AppData", "OPENAI_API_KEY", "sk-"):
        assert needle not in text, f"committed recording contains {needle!r}"
