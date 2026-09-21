"""Shared pytest configuration. Tests marked @pytest.mark.docker, @pytest.mark.postgres, or
@pytest.mark.mlflow are skipped automatically when the corresponding service isn't reachable —
this keeps `make test` fast and dependency-free per README, while still exercising the real
integration whenever the service is available (Docker after `make sandbox-build`; Postgres and
MLflow after `make up`)."""

from __future__ import annotations

import shutil
import subprocess
import urllib.request

import psycopg
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


def _postgres_ready() -> bool:
    try:
        with psycopg.connect(settings.database_url, connect_timeout=2):
            return True
    except Exception:
        return False


def _mlflow_ready() -> bool:
    try:
        with urllib.request.urlopen(f"{settings.mlflow_tracking_uri}/health", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


_SERVICE_READY = {
    "docker": (_docker_ready(), "Docker daemon or foundry-sandbox:latest image not available"),
    "postgres": (_postgres_ready(), f"Postgres not reachable at {settings.database_url}"),
    "mlflow": (_mlflow_ready(), f"MLflow not reachable at {settings.mlflow_tracking_uri}"),
}


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    for item in items:
        for marker, (ready, reason) in _SERVICE_READY.items():
            if marker in item.keywords and not ready:
                item.add_marker(pytest.mark.skip(reason=reason))
