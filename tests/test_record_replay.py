"""Tests for scripts/record_replay.py — the script that produces the committed demo recording.
It drives the production RunManager + JsonlRecorder, so these tests run the real graph on its
background thread and assert on the recording it leaves behind. Docker is faked at the sandbox and
audit boundary exactly as tests/test_graph.py's booby-trap test does, using churn_leaky's shape: a
categorical `retention_call_outcome` column that leaks the target, which the profiler cannot see
but the red team's audit can. The real, Docker-backed recording is made by `make record-replay`.

Kept self-contained like every other test module here: the fixtures below intentionally mirror
tests/test_graph.py rather than importing from another test file."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from app.replay import fold_frames
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

_ROOT = Path(__file__).resolve().parent.parent


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "record_replay", _ROOT / "scripts" / "record_replay.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


record_replay = _load_script()

_ALL_TEAM_MODULES = (
    principal_module, data_team_module, modeling_team_module, runner_module, red_team_module,
    reporter_module, lessons_module,
)
_LEAKY_RAW_PROFILE = RawProfile(
    dataset_name="churn_leaky.csv",
    n_rows=300,
    n_cols=4,
    target_column="churned",
    target_positive_rate=0.27,
    columns=[
        RawColumnStats(
            name="customer_id", dtype="object", n_missing=0, pct_missing=0.0, n_unique=300,
            is_numeric=False, sample_values=["a"],
        ),
        RawColumnStats(
            name="tenure_months", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=72,
            is_numeric=True, sample_values=["1"], target_corr=-0.1, target_auc=0.4,
        ),
        RawColumnStats(
            name="retention_call_outcome", dtype="object", n_missing=0, pct_missing=0.0,
            n_unique=3, is_numeric=False, sample_values=["saved"],
        ),
        RawColumnStats(
            name="churned", dtype="int64", n_missing=0, pct_missing=0.0, n_unique=2,
            is_numeric=True, sample_values=["0", "1"],
        ),
    ],
)
_LEAKY_AUDIT_REPORT = AuditReport(
    dataset_name="churn_leaky.csv", n_rows=300, n_cols=2, target_column="churned",
    columns=[
        AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.4),
        AuditColumnStat(name="retention_call_outcome", is_numeric=False, target_auc=0.9962),
    ],
    duplicate_row_count=0, duplicate_row_rate=0.0,
)
_CLEAN_AUDIT_REPORT = AuditReport(
    dataset_name="churn_leaky.csv", n_rows=300, n_cols=1, target_column="churned",
    columns=[AuditColumnStat(name="tenure_months", is_numeric=True, target_auc=0.4)],
    duplicate_row_count=0, duplicate_row_rate=0.0,
)


def _fake_audit(dataset: Any, cleaning_plan: Any, **kw: Any) -> AuditReport:
    dropped = set(cleaning_plan.drop_columns) if cleaning_plan else set()
    return _CLEAN_AUDIT_REPORT if "retention_call_outcome" in dropped else _LEAKY_AUDIT_REPORT


def _fake_sandbox(code: str, **kw: Any) -> SandboxResult:
    # The column name appears in the generated code only when THIS training run drops it.
    roc_auc = 0.80 if "'retention_call_outcome'" in code else 0.99
    return SandboxResult(
        stdout=f'FOUNDRY_METRICS {{"roc_auc": {roc_auc}}}', stderr="", exit_code=0,
        duration_s=0.1, timed_out=False,
    )


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "openai_api_key", None)
    client = StubClient()
    register_canned_responses(client)
    for module in _ALL_TEAM_MODULES:
        monkeypatch.setattr(
            module, "get_llm", lambda role, _client=client: MeteredClient(role, _client, model=None)
        )
    monkeypatch.setattr(
        data_team_module.profiler_tool, "profile", lambda dataset, **kw: _LEAKY_RAW_PROFILE
    )
    monkeypatch.setattr(runner_module.sandbox, "run", _fake_sandbox)
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: "run-id")
    monkeypatch.setattr(red_team_module.audit_tool, "audit", _fake_audit)


def test_the_recording_captures_both_gates_and_the_red_team_catch(tmp_path: Path) -> None:
    replay = record_replay.record(
        task="churn_leaky", name="demo", budget_usd=record_replay.DEFAULT_BUDGET_USD,
        out_dir=tmp_path, timeout_s=30.0, poll_s=0.02,
    )

    assert replay.header.final_status is not None
    assert replay.header.final_status.status == "completed"
    assert [d.gate for d in replay.header.decisions] == ["budget", "final"]
    assert all(d.approved for d in replay.header.decisions)

    folded = fold_frames(replay.frames)
    assert folded[-1] == replay.header.final_status
    caught = [f for f in folded[-1].invalidations if f.verdict == "invalidated"]
    assert caught, "the booby-trapped column must be caught and stay in the audit trail"
    assert caught[0].category == "leakage"


def test_the_red_team_catch_is_visible_in_the_frame_it_happened_in(tmp_path: Path) -> None:
    """The console's headline moment: the frame for the red_team event must already show the
    invalidation, and the frame before it must not (statuses are paired with post-step state)."""
    replay = record_replay.record(
        task="churn_leaky", name="demo", budget_usd=1.0, out_dir=tmp_path, poll_s=0.02,
        timeout_s=30.0,
    )
    folded = fold_frames(replay.frames)
    first_audit = next(i for i, f in enumerate(replay.frames) if f.event.node == "red_team")

    assert any(f.verdict == "invalidated" for f in folded[first_audit].invalidations)
    assert not folded[first_audit - 1].invalidations


def test_main_writes_the_named_file_and_prints_a_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = record_replay.main(
        ["--out-dir", str(tmp_path), "--poll-s", "0.02", "--timeout-s", "30"]
    )
    out = capsys.readouterr().out

    assert code == 0
    assert (tmp_path / "demo-churn-leaky.jsonl").is_file()
    assert "budget=approved, final=approved" in out
    assert "mlflow ids    5/5" in out
    assert "warning" not in out
    assert "5 audited, 3 invalidated" in out
    assert "caught        exp-001: leakage" in out


def test_the_summary_warns_when_a_recording_has_no_mlflow_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The failure mode that shipped a first draft of the demo: MLflow logging silently returns
    None, and the recording looks fine until the console has nothing to link to."""
    monkeypatch.setattr(runner_module.tracker, "log_run", lambda **kwargs: None)
    code = record_replay.main(["--out-dir", str(tmp_path), "--poll-s", "0.02", "--timeout-s", "30"])
    out = capsys.readouterr().out

    assert code == 0
    assert "mlflow ids    0/5" in out
    assert "warning" in out and "make up" in out


def test_an_unknown_task_exits_nonzero_and_names_the_valid_ones(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = record_replay.main(["--task", "nope", "--out-dir", str(tmp_path)])
    assert code == 1
    assert "churn_leaky" in capsys.readouterr().err


def test_a_run_that_fails_is_reported_not_recorded_as_a_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def _explode(code: str, **kwargs: Any) -> SandboxResult:
        raise RuntimeError("docker daemon went away")

    monkeypatch.setattr(runner_module.sandbox, "run", _explode)
    code = record_replay.main(["--out-dir", str(tmp_path), "--poll-s", "0.02", "--timeout-s", "30"])
    assert code == 1
    assert "docker daemon went away" in capsys.readouterr().err


def test_defaults_target_the_booby_trapped_dataset_with_a_gate_tripping_budget() -> None:
    """$20 never trips foundry/gates.py's budget gate, which would leave the demo without it."""
    args = record_replay.build_parser().parse_args([])
    assert (args.task, args.name, args.budget_usd) == ("churn_leaky", None, 1.0)
    assert args.budget_usd < settings.cost_cap_usd_total
