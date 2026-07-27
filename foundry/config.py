from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Typed, validated configuration for foundry, loaded from the environment / .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Postgres — backs the LangGraph checkpointer (database: foundry)
    database_url: str = "postgresql://foundry:foundry@localhost:5432/foundry"

    # MLflow tracking server (reachable from the host) — foundry/tools/tracker.py, M4
    mlflow_tracking_uri: str = "http://localhost:5000"
    mlflow_experiment_name: str = "foundry"

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
    max_experiments_total: int = 6
    max_experiments_per_iteration: int = 3  # M4: one planning pass now fans out via Send

    # LangGraph's own default recursion_limit is 10007 (effectively unbounded) — M3 sets a real
    # cap so a routing bug fails fast with GraphRecursionError instead of running for minutes.
    graph_recursion_limit: int = 40
    # Bounds how many Send-fanned-out experiment_runner branches (each a real docker container,
    # foundry/tools/sandbox.py) run concurrently — verified against langchain_core's
    # get_executor_for_config: RunnableConfig.max_concurrency sets the BackgroundExecutor's
    # ThreadPoolExecutor(max_workers=...) that LangGraph's Pregel loop actually uses.
    graph_max_concurrency: int = 3

    # Experiment runner self-debug (foundry/teams/experiment_runner.py, M3) — SPEC: "runner
    # self-debug max k=3"
    self_debug_max_attempts: int = 3
    self_debug_error_chars: int = 4000
    # sandbox_timeout_seconds=60 is tuned for M2's isolation tests, not for import + CV fitting.
    experiment_timeout_seconds: int = 300
    profile_timeout_seconds: int = 120

    # Cost model (foundry/tools/cost.py, foundry/llm.py, M4). Real Anthropic calls are priced
    # from actual AIMessage.usage_metadata against foundry/tools/cost.py's per-model $/token
    # table; cost_per_llm_call_usd is the flat per-call fallback used only by StubClient, which
    # has no token usage to report (SPEC's "graph runs with NO api keys" guarantee, M2).
    cost_per_llm_call_usd: float = 0.01
    cost_per_sandbox_minute_usd: float = 0.002

    # Bundled sample datasets (foundry/datasets.py, M3) and where run artifacts are written.
    data_dir: Path = Path("data/samples")
    artifacts_dir: Path = Path("artifacts")
    random_seed: int = 42


settings = Settings()
