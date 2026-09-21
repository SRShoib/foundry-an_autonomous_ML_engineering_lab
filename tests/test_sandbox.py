"""Tests for foundry/tools/sandbox.py.

test_build_command_* always runs (no Docker required) and is what actually proves the isolation
flags exist in CI, per CLAUDE.md's "Docker sandbox... enforced, not advisory." Everything below
is an integration proof gated behind @pytest.mark.docker (see tests/conftest.py) — it exercises
the same guardrails against the real daemon and the real foundry-sandbox:latest image.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from foundry.config import settings
from foundry.models import SandboxLimits
from foundry.tools import sandbox

# --- command construction (no Docker required) -----------------------------------------------


def test_build_command_includes_every_guardrail_flag(tmp_path: Path) -> None:
    limits = SandboxLimits(memory="256m", cpus=0.5, pids=64, timeout_seconds=10)
    command = sandbox._build_command(
        image="foundry-sandbox:latest",
        container_name="foundry-sbx-test",
        workdir=tmp_path,
        data_dir=None,
        limits=limits,
    )

    assert command[command.index("--network") + 1] == "none"
    mem_idx = command.index("--memory")
    swap_idx = command.index("--memory-swap")
    assert command[mem_idx + 1] == command[swap_idx + 1] == "256m"
    assert command[command.index("--cpus") + 1] == "0.5"
    assert command[command.index("--pids-limit") + 1] == "64"
    assert command[command.index("--cap-drop") + 1] == "ALL"
    assert command[command.index("--security-opt") + 1] == "no-new-privileges"
    assert "--read-only" in command
    assert command[command.index("--tmpfs") + 1] == "/tmp"
    assert "--rm" in command
    assert command[command.index("--name") + 1] == "foundry-sbx-test"
    assert command[-2:] == ["foundry-sandbox:latest", "main.py"]


def test_build_command_mounts_data_dir_read_only(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    command = sandbox._build_command(
        image=settings.sandbox_image,
        container_name="foundry-sbx-test",
        workdir=tmp_path,
        data_dir=data_dir,
        limits=SandboxLimits(),
    )
    mounts = [command[i + 1] for i, arg in enumerate(command) if arg == "-v"]
    assert any(m.endswith(":/data:ro") for m in mounts)


def test_build_command_omits_data_mount_when_none(tmp_path: Path) -> None:
    command = sandbox._build_command(
        image=settings.sandbox_image,
        container_name="foundry-sbx-test",
        workdir=tmp_path,
        data_dir=None,
        limits=SandboxLimits(),
    )
    mounts = [command[i + 1] for i, arg in enumerate(command) if arg == "-v"]
    assert not any(":/data:" in m for m in mounts)


# --- real Docker integration -------------------------------------------------------------------


@pytest.mark.docker
def test_sandbox_runs_and_captures_stdout() -> None:
    result = sandbox.run("print('hello from sandbox')")
    assert result.exit_code == 0
    assert "hello from sandbox" in result.stdout
    assert result.timed_out is False


@pytest.mark.docker
def test_sandbox_captures_traceback_on_nonzero_exit() -> None:
    result = sandbox.run("raise ValueError('boom')")
    assert result.exit_code != 0
    assert "ValueError" in result.stderr
    assert "boom" in result.stderr


@pytest.mark.docker
def test_sandbox_blocks_network() -> None:
    code = "import socket\nsocket.create_connection(('8.8.8.8', 53), timeout=3)\n"
    result = sandbox.run(code, limits=SandboxLimits(timeout_seconds=15))
    assert result.exit_code != 0


@pytest.mark.docker
def test_sandbox_enforces_memory_cap() -> None:
    code = "s = 'x' * (10 ** 9)\n"
    result = sandbox.run(code, limits=SandboxLimits(memory="64m", timeout_seconds=15))
    assert result.exit_code != 0
    assert result.timed_out is False


@pytest.mark.docker
def test_sandbox_timeout_kills_container_and_leaves_none_running() -> None:
    result = sandbox.run("import time\ntime.sleep(30)\n", limits=SandboxLimits(timeout_seconds=3))
    assert result.timed_out is True
    assert result.exit_code is None

    ps = subprocess.run(
        ["docker", "ps", "-a", "--filter", "name=foundry-sbx-", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert ps.stdout.strip() == ""


@pytest.mark.docker
def test_sandbox_kills_true_infinite_loop_after_timeout() -> None:
    """Distinct from the sleep-based timeout test above: a CPU-spinning `while True` is the
    realistic shape of a runaway agent-written bug (e.g. a broken loop condition), not a
    blocking I/O wait — this proves the timeout kill also holds under that failure mode."""
    result = sandbox.run("while True:\n    pass\n", limits=SandboxLimits(timeout_seconds=3))
    assert result.timed_out is True
    assert result.exit_code is None
    assert result.duration_s < 10  # killed promptly, not left spinning to the process timeout


@pytest.mark.docker
def test_sandbox_collects_artifacts_written_to_scratch() -> None:
    code = "with open('output.txt', 'w') as f:\n    f.write('artifact-content')\n"
    result = sandbox.run(code)
    assert result.exit_code == 0
    assert result.artifacts.get("output.txt") == b"artifact-content"


@pytest.mark.docker
def test_sandbox_data_dir_is_read_only(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "input.csv").write_text("a,b\n1,2\n")

    code = "open('/data/should_fail.txt', 'w').write('nope')\n"
    result = sandbox.run(code, data_dir=data_dir)
    assert result.exit_code != 0


@pytest.mark.docker
def test_sandbox_injects_files_readable_by_code() -> None:
    code = "print(open('helper.txt').read())\n"
    result = sandbox.run(code, files={"helper.txt": b"injected-content"})
    assert result.exit_code == 0
    assert "injected-content" in result.stdout
