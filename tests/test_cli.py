"""Tests for foundry/cli.py. build_graph is monkeypatched to a fake graph everywhere so these
never touch Docker, Postgres, or a real LLM — the real end-to-end path is proven in
tests/test_graph.py under @pytest.mark.docker / @pytest.mark.postgres."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from langgraph.types import Command

from foundry import cli
from foundry.config import settings


class _FakeInterrupt:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value


def test_unknown_task_exits_nonzero_and_lists_valid_keys(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc_info:
        cli.main(["--task", "does-not-exist"])
    assert exc_info.value.code != 0
    assert "churn" in capsys.readouterr().err


def test_no_task_and_no_show_is_a_usage_error_before_touching_a_checkpointer(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Default --checkpointer is postgres; this must fail on argument validation alone, without
    # ever attempting a database connection (no Postgres is running in this test environment).
    code = cli.main([])
    assert code != 0
    assert "--task" in capsys.readouterr().err


def test_run_with_memory_checkpointer_writes_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "artifacts_dir", tmp_path)
    monkeypatch.setattr(settings, "anthropic_api_key", None)

    final_state = {
        "report_md": "# report",
        "model_card_md": "# card",
        "stop_reason": "diminishing_returns",
    }

    class _FakeGraph:
        def invoke(self, state: Any, config: Any) -> Any:
            return final_state

        def get_state(self, config: Any) -> Any:
            raise AssertionError("should not be called in run mode")

    monkeypatch.setattr(cli, "build_graph", lambda checkpointer, store: _FakeGraph())
    monkeypatch.setattr(cli, "install_canned_responses", lambda: None)

    code = cli.main(["--task", "churn", "--checkpointer", "memory", "--thread-id", "t1"])
    assert code == 0
    assert (tmp_path / "t1" / "report.md").read_text(encoding="utf-8") == "# report"
    assert (tmp_path / "t1" / "model_card.md").read_text(encoding="utf-8") == "# card"


def test_auto_approve_answers_the_gate_without_prompting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """M6: --auto-approve must still go through a real interrupt/resume round trip — this fake
    graph only reaches `final_state` on its SECOND invoke() call, so the test fails if the CLI
    ever skips the pause instead of actually resuming it."""
    monkeypatch.setattr(settings, "artifacts_dir", tmp_path)
    monkeypatch.setattr(settings, "anthropic_api_key", None)

    paused_state = {
        "report_md": "# report",
        "__interrupt__": [
            _FakeInterrupt(
                {"gate": "final", "reason": "sign-off", "spent_usd": 1.0, "budget_usd": 20.0}
            )
        ],
    }
    final_state = {
        "report_md": "# report\n\n## Sign-off\n\n**APPROVED**",
        "model_card_md": "# card",
        "stop_reason": "diminishing_returns",
    }
    calls: list[Any] = []

    class _FakeGraph:
        def invoke(self, graph_input: Any, config: Any) -> Any:
            calls.append(graph_input)
            return paused_state if len(calls) == 1 else final_state

        def get_state(self, config: Any) -> Any:
            raise AssertionError("should not be called in run mode")

    monkeypatch.setattr(cli, "build_graph", lambda checkpointer, store: _FakeGraph())
    monkeypatch.setattr(cli, "install_canned_responses", lambda: None)

    code = cli.main(
        ["--task", "churn", "--checkpointer", "memory", "--thread-id", "t2", "--auto-approve"]
    )
    assert code == 0
    assert len(calls) == 2
    assert isinstance(calls[1], Command)
    assert calls[1].resume == {"approved": True, "note": "auto-approved via --auto-approve"}
    assert "--auto-approve: approving" in capsys.readouterr().out
    assert (tmp_path / "t2" / "report.md").read_text(encoding="utf-8") == final_state["report_md"]


def test_paused_gate_without_auto_approve_or_a_tty_leaves_the_run_paused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """SPEC: "expensive runs pause for approval and resume via the API" — with no human to answer
    on stdin, the CLI must report the pause and exit non-zero rather than inventing an answer."""
    monkeypatch.setattr(settings, "artifacts_dir", tmp_path)
    monkeypatch.setattr(settings, "anthropic_api_key", None)

    paused_state = {
        "report_md": "# report",
        "__interrupt__": [
            _FakeInterrupt(
                {"gate": "budget", "reason": "over cap", "spent_usd": 16.0, "budget_usd": 20.0}
            )
        ],
    }

    class _FakeGraph:
        def invoke(self, graph_input: Any, config: Any) -> Any:
            return paused_state

        def get_state(self, config: Any) -> Any:
            raise AssertionError("should not be called in run mode")

    class _NonTTYStdin:
        def isatty(self) -> bool:
            return False

    monkeypatch.setattr(cli, "build_graph", lambda checkpointer, store: _FakeGraph())
    monkeypatch.setattr(cli, "install_canned_responses", lambda: None)
    monkeypatch.setattr(cli.sys, "stdin", _NonTTYStdin())

    code = cli.main(["--task", "churn", "--checkpointer", "memory", "--thread-id", "t3"])
    assert code == 2
    out = capsys.readouterr().out
    assert "t3" in out
    assert "PAUSED at gate: budget" in out


def test_show_prints_persisted_report_without_invoking_the_graph(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    class _FakeSnapshot:
        values = {"report_md": "# persisted report"}

    class _FakeGraph:
        def invoke(self, state: Any, config: Any) -> Any:
            raise AssertionError("should not run the graph in --show mode")

        def get_state(self, config: Any) -> Any:
            return _FakeSnapshot()

    monkeypatch.setattr(cli, "build_graph", lambda checkpointer, store: _FakeGraph())

    code = cli.main(["--show", "some-thread", "--checkpointer", "memory"])
    assert code == 0
    assert "persisted report" in capsys.readouterr().out


def test_show_missing_thread_reports_a_clean_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    class _EmptySnapshot:
        values: dict[str, Any] = {}

    class _FakeGraph:
        def invoke(self, state: Any, config: Any) -> Any:
            raise AssertionError

        def get_state(self, config: Any) -> Any:
            return _EmptySnapshot()

    monkeypatch.setattr(cli, "build_graph", lambda checkpointer, store: _FakeGraph())
    code = cli.main(["--show", "missing-thread", "--checkpointer", "memory"])
    assert code != 0
    assert "missing-thread" in capsys.readouterr().err
