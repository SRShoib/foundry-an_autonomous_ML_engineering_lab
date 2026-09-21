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

    # Budget gate (foundry/teams/principal.py, foundry/gates.py, M6) — SPEC: "any single run
    # projected > $X or total spend > 80% of budget pauses for approval". est_cost_usd_per_
    # experiment is the code-owned cost floor foundry/tools/cost.py's project_run_usd() falls
    # back to before any experiment has completed (an LLM-authored ExperimentSpec.est_cost_usd is
    # never trusted alone to decide whether to pause a human — CLAUDE.md's "code owns the floor"
    # asymmetry, same as foundry/teams/red_team.py's _apply_floor).
    budget_gate_fraction: float = 0.8
    est_cost_usd_per_experiment: float = 0.25

    # Model split — cheap workers/runners, strong principal + red team (SPEC)
    principal_model: str = "claude-opus-5"
    red_team_model: str = "claude-opus-5"
    worker_model: str = "claude-haiku-4-5"

    # LLM interface (foundry/llm.py, M2) — no sampling params: rejected (400) on Opus 5 / Sonnet 5
    llm_max_tokens: int = 8192
    llm_max_parse_retries: int = 2

    anthropic_api_key: str | None = None

    # Principal loop (foundry/teams/principal.py, M3) — SPEC: "principal loop max iterations".
    # M5: a red_team audit pass and a remediation data_team re-run each cost an extra
    # principal turn beyond what M4 budgeted for, so the cap needs headroom for that round trip.
    principal_max_iterations: int = 20
    max_experiments_total: int = 6
    max_experiments_per_iteration: int = 3  # M4: one planning pass now fans out via Send

    # LangGraph's own default recursion_limit is 10007 (effectively unbounded) — M3 sets a real
    # cap so a routing bug fails fast with GraphRecursionError instead of running for minutes.
    # M5: bumped alongside principal_max_iterations for the same audit/remediation round trip.
    graph_recursion_limit: int = 60
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
    audit_timeout_seconds: int = 120

    # Red team code floor (foundry/teams/red_team.py, M5) — evidence past these hard thresholds
    # forces verdict="invalidated" regardless of what the red_team LLM judged (CLAUDE.md: "Hard
    # cost caps and iteration limits everywhere the spec says so" — same "code owns the floor"
    # ethos extended to the audit). audit_leak_auc_threshold applies to
    # foundry/tools/audit.py's per-column target association (numeric AUC or the categorical
    # in-sample target-encoded AUC); audit_duplicate_row_rate to its exact-duplicate-row rate;
    # audit_suspicious_metric_ceiling to the experiment's own reported primary metric, for
    # metrics known to be bounded in [0, 1] (roc_auc/accuracy/f1 — see
    # foundry/leaderboard.py's metric_direction) where a near-perfect CV score is implausible on
    # real, noisy tabular data regardless of what the audit evidence shows.
    audit_leak_auc_threshold: float = 0.95
    audit_duplicate_row_rate: float = 0.05
    audit_suspicious_metric_ceiling: float = 0.999

    # Cost model (foundry/tools/cost.py, foundry/llm.py, M4). Real Anthropic calls are priced
    # from actual AIMessage.usage_metadata against foundry/tools/cost.py's per-model $/token
    # table; cost_per_llm_call_usd is the flat per-call fallback used only by StubClient, which
    # has no token usage to report (SPEC's "graph runs with NO api keys" guarantee, M2).
    cost_per_llm_call_usd: float = 0.01
    cost_per_sandbox_minute_usd: float = 0.002

    # Cross-thread lesson memory (foundry/tools/memory.py, foundry/teams/lessons.py, M7) — how
    # many of a dataset's most recent Lesson records the literature scout is shown per pass.
    memory_max_lessons: int = 5

    # Bundled sample datasets (foundry/datasets.py, M3) and where run artifacts are written.
    data_dir: Path = Path("data/samples")
    artifacts_dir: Path = Path("artifacts")
    random_seed: int = 42

    # FastAPI control plane (app/main.py, M6) — SPEC: "FastAPI (start run, stream events, list
    # pending approvals, resume)".
    api_host: str = "0.0.0.0"
    api_port: int = 8000


settings = Settings()
