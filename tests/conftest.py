"""Shared pytest configuration. Tests marked @pytest.mark.docker are skipped automatically when
the Docker daemon isn't reachable or the sandbox image hasn't been built — this keeps `make
test` fast and dependency-free per README, while still exercising the real isolation checks
whenever Docker is available (as it is after `make sandbox-build`)."""

from __future__ import annotations

import shutil
import subprocess

import pytest

from foundry.config import settings


def _docker_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        subprocess.run(["docker", "info"], capture_output=True, timeout=5, check=True)
        image_check = subprocess.run(
            ["docker", "image", "inspect", settings.sandbox_image],
            capture_output=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    return image_check.returncode == 0


_DOCKER_READY = _docker_ready()


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if _DOCKER_READY:
        return
    skip_docker = pytest.mark.skip(
        reason="Docker daemon or foundry-sandbox:latest image not available"
    )
    for item in items:
        if "docker" in item.keywords:
            item.add_marker(skip_docker)
