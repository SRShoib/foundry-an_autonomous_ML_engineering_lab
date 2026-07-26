from pathlib import Path

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
    sandbox_pids_limit: int = 128
    sandbox_timeout_seconds: int = 60
    sandbox_network_disabled: bool = True

    # Cost caps (SPEC: hard per-run cost cap; principal loop stops at 80% of total)
    cost_cap_usd_total: float = 20.0
    cost_cap_usd_per_run: float = 2.0

    # Model split — cheap workers/runners, strong principal + red team (SPEC)
    principal_model: str = "claude-opus-5"
    red_team_model: str = "claude-opus-5"
    worker_model: str = "claude-haiku-4-5"

    # LLM interface (foundry/llm.py, M2) — no sampling params: rejected (400) on Opus 5 / Sonnet 5
    llm_max_tokens: int = 8192
    llm_max_parse_retries: int = 2

    anthropic_api_key: str | None = None

    # Principal loop (foundry/teams/principal.py, M3) — SPEC: "principal loop max iterations"
    principal_max_iterations: int = 12
    max_experiments_total: int = 3
    max_experiments_per_iteration: int = 1  # M4 raises this once Send fan-out lands

    # LangGraph's own default recursion_limit is 10007 (effectively unbounded) — M3 sets a real
    # cap so a routing bug fails fast with GraphRecursionError instead of running for minutes.
    graph_recursion_limit: int = 40

    # Experiment runner self-debug (foundry/teams/experiment_runner.py, M3) — SPEC: "runner
    # self-debug max k=3"
    self_debug_max_attempts: int = 3
    self_debug_error_chars: int = 4000
    # sandbox_timeout_seconds=60 is tuned for M2's isolation tests, not for import + CV fitting.
    experiment_timeout_seconds: int = 300
    profile_timeout_seconds: int = 120

    # Crude, deterministic cost model — replaced by real per-agent token accounting in M4.
    cost_per_llm_call_usd: float = 0.01
    cost_per_sandbox_minute_usd: float = 0.002

    # Bundled sample datasets (foundry/datasets.py, M3) and where run artifacts are written.
    data_dir: Path = Path("data/samples")
    artifacts_dir: Path = Path("artifacts")
    random_seed: int = 42


settings = Settings()
