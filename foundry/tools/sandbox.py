"""Sandboxed code execution (SPEC: sandbox.run(code, files, limits) -> {stdout, stderr,
artifacts, duration, exit}). CLAUDE.md: "Agent-written code executes ONLY in the Docker
sandbox (no network, resource caps) — never on the host, never via bare exec/eval." Every
guardrail below is a docker run flag, enforced by the daemon, not advisory.

Built on the docker CLI via subprocess rather than the docker SDK — no extra dependency, matches
scripts/smoke_test.py's approach, and keeps the guardrail flags as a plain list[str] that
test_sandbox.py can assert on without a running daemon (see _build_command).
"""

from __future__ import annotations

import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from foundry.config import settings
from foundry.models import SandboxLimits, SandboxResult


def _build_command(
    *,
    image: str,
    container_name: str,
    workdir: Path,
    data_dir: Path | None,
    limits: SandboxLimits,
) -> list[str]:
    """Pure function from inputs to the full docker argv — the guardrail flags live here so
    they can be asserted on directly, with no Docker daemon required."""
    command = [
        "docker",
        "run",
        "--rm",
        "--name",
        container_name,
        "--network",
        "none",
        "--memory",
        limits.memory,
        "--memory-swap",
        limits.memory,  # equal to --memory: prevents escaping the cap via swap
        "--cpus",
        str(limits.cpus),
        "--pids-limit",
        str(limits.pids),  # blocks fork bombs
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "-e",
        "PYTHONDONTWRITEBYTECODE=1",
        "-v",
        f"{workdir.resolve().as_posix()}:/workspace",
        "-w",
        "/workspace",
    ]
    if data_dir is not None:
        command += ["-v", f"{data_dir.resolve().as_posix()}:/data:ro"]
    command += [image, "main.py"]
    return command


def _collect_artifacts(workdir: Path, *, exclude: set[str]) -> dict[str, bytes]:
    artifacts: dict[str, bytes] = {}
    for path in sorted(workdir.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(workdir).as_posix()
        if rel in exclude:
            continue
        artifacts[rel] = path.read_bytes()
    return artifacts


def run(
    code: str,
    *,
    files: dict[str, bytes] | None = None,
    limits: SandboxLimits | None = None,
    data_dir: Path | str | None = None,
) -> SandboxResult:
    """Run `code` as main.py inside the sandbox image. `files` are written into the writable
    scratch dir before execution (available to the code at their given relative paths); any
    file present under the scratch dir after execution that wasn't part of the input is
    returned as an artifact. `data_dir`, if given, is mounted read-only at /data."""
    limits = limits or SandboxLimits()
    resolved_data_dir = Path(data_dir) if data_dir is not None else None

    with tempfile.TemporaryDirectory(prefix="foundry-sandbox-") as tmp:
        workdir = Path(tmp)
        (workdir / "main.py").write_text(code, encoding="utf-8")
        pre_existing = {"main.py"}
        for rel_path, content in (files or {}).items():
            target = workdir / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            pre_existing.add(rel_path)

        container_name = f"foundry-sbx-{uuid.uuid4().hex[:12]}"
        command = _build_command(
            image=settings.sandbox_image,
            container_name=container_name,
            workdir=workdir,
            data_dir=resolved_data_dir,
            limits=limits,
        )

        start = time.monotonic()
        timed_out = False
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=limits.timeout_seconds,
            )
            stdout, stderr, exit_code = completed.stdout, completed.stderr, completed.returncode
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            exit_code = None
            # Killing the `docker run` client process alone does not stop the container —
            # explicitly kill it by the name we gave it.
            subprocess.run(
                ["docker", "kill", container_name],
                capture_output=True,
                timeout=limits.timeout_seconds,
            )
            stdout = _decode(exc.stdout)
            stderr = _decode(exc.stderr)
        duration_s = time.monotonic() - start

        artifacts = _collect_artifacts(workdir, exclude=pre_existing)

    return SandboxResult(
        stdout=stdout,
        stderr=stderr,
        exit_code=exit_code,
        duration_s=duration_s,
        timed_out=timed_out,
        artifacts=artifacts,
    )


def _decode(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
