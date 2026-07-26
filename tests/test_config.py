from pathlib import Path

import pytest

from foundry.config import Settings

_ENV_VARS = (
    "DATABASE_URL",
    "MLFLOW_TRACKING_URI",
    "SANDBOX_IMAGE",
    "SANDBOX_TIMEOUT_SECONDS",
    "COST_CAP_USD_TOTAL",
    "PRINCIPAL_MODEL",
    "ANTHROPIC_API_KEY",
    "PRINCIPAL_MAX_ITERATIONS",
    "MAX_EXPERIMENTS_TOTAL",
    "MAX_EXPERIMENTS_PER_ITERATION",
    "GRAPH_RECURSION_LIMIT",
    "SELF_DEBUG_MAX_ATTEMPTS",
    "DATA_DIR",
    "ARTIFACTS_DIR",
)


def test_settings_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in _ENV_VARS:
        monkeypatch.delenv(var, raising=False)

    settings = Settings(_env_file=None)  # pyright: ignore[reportCallIssue]

    assert settings.database_url.startswith("postgresql://")
    assert settings.mlflow_tracking_uri == "http://localhost:5000"
    assert settings.sandbox_image == "foundry-sandbox:latest"
    assert settings.sandbox_network_disabled is True
    assert settings.cost_cap_usd_per_run <= settings.cost_cap_usd_total
    assert settings.principal_model == settings.red_team_model
    assert settings.worker_model != settings.principal_model
    assert settings.anthropic_api_key is None

    # M3: principal loop / self-debug caps (SPEC: "runner self-debug max k=3")
    assert settings.self_debug_max_attempts == 3
    assert settings.max_experiments_per_iteration <= settings.max_experiments_total
    assert settings.graph_recursion_limit > settings.principal_max_iterations * 2
    assert settings.data_dir == Path("data/samples")
    assert settings.artifacts_dir == Path("artifacts")


def test_settings_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SANDBOX_TIMEOUT_SECONDS", "120")
    monkeypatch.setenv("COST_CAP_USD_TOTAL", "100.5")

    settings = Settings(_env_file=None)  # pyright: ignore[reportCallIssue]

    assert settings.sandbox_timeout_seconds == 120
    assert settings.cost_cap_usd_total == 100.5
