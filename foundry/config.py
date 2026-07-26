from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Typed, validated configuration for foundry, loaded from the environment / .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Postgres — backs the LangGraph checkpointer (database: foundry)
    database_url: str = "postgresql://foundry:foundry@localhost:5432/foundry"

    # MLflow tracking server (reachable from the host)
    mlflow_tracking_uri: str = "http://localhost:5000"

    # Sandbox execution (foundry/tools/sandbox.py wraps these in M2)
    sandbox_image: str = "foundry-sandbox:latest"
    sandbox_memory_limit: str = "512m"
    sandbox_cpu_limit: float = 1.0
    sandbox_timeout_seconds: int = 60
    sandbox_network_disabled: bool = True

    # Cost caps (SPEC: hard per-run cost cap; principal loop stops at 80% of total)
    cost_cap_usd_total: float = 20.0
    cost_cap_usd_per_run: float = 2.0

    # Model split — cheap workers/runners, strong principal + red team (SPEC)
    principal_model: str = "claude-opus-5"
    red_team_model: str = "claude-opus-5"
    worker_model: str = "claude-haiku-4-5"

    anthropic_api_key: str | None = None


settings = Settings()
