"""MLflow tracker tool (SPEC: "tracker.log_run(...) / tracker.query_runs(...)"). Host-side only:
CLAUDE.md's sandbox guardrail runs training code with `--network none` (foundry/tools/sandbox.py),
so nothing inside the container can reach the MLflow server — log_run is called by
foundry/teams/experiment_runner.py *after* sandbox.run returns, from the already-parsed
SandboxResult.artifacts and metrics, never from inside the training script.

Uses MlflowClient's explicit create_run/log_*/set_terminated calls, never the fluent
mlflow.start_run() global-active-run API: M4's Send fan-out runs several experiment_runner
branches concurrently on separate threads (verified against the installed LangGraph 1.2.9
BackgroundExecutor — real ThreadPoolExecutor, not cooperative), and a globally "active run" would
race across them. A fresh MlflowClient per call sidesteps any client-side shared state too.

Logging is best-effort observability, never a hard dependency of the training loop: any failure
here is caught and reported as None, so a flaky or absent MLflow server (make test / make run
without `make up`) never fails an otherwise-successful experiment. Metrics themselves are never
at risk either way — they are parsed from sandbox stdout by foundry/tools/metrics.py before
log_run is ever called (CLAUDE.md: "Metrics computed by code, never estimated by an LLM").

One MLflow experiment per foundry dataset (`{settings.mlflow_experiment_name}-{dataset_ref}`),
shared across foundry graph runs on that dataset. foundry's own experiment_id
(`exp-001`, `exp-002`, ...) is only unique WITHIN a single graph run today — FoundryState carries
no run-scoped id yet — so query_runs's results may span multiple foundry threads on the same
dataset until a thread_id is threaded through state (a natural fit for M6's FastAPI layer)."""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Literal

from mlflow import MlflowClient
from mlflow.exceptions import MlflowException
from pydantic import BaseModel

from foundry.config import settings
from foundry.models import ExperimentSpec

logger = logging.getLogger(__name__)


class RunSummary(BaseModel):
    run_id: str
    status: str
    params: dict[str, str]
    metrics: dict[str, float]
    tags: dict[str, str]


def _experiment_name(dataset_ref: str) -> str:
    return f"{settings.mlflow_experiment_name}-{dataset_ref}"


def _build_params(spec: ExperimentSpec, extra: dict[str, str]) -> dict[str, str]:
    params = {"model_family": spec.model_family}
    params.update({f"hp_{key}": str(value) for key, value in spec.hyperparams.items()})
    params.update(extra)
    return params


def _build_tags(spec: ExperimentSpec, *, dataset_ref: str, status: str) -> dict[str, str]:
    return {
        "foundry_experiment_id": spec.experiment_id,
        "dataset_ref": dataset_ref,
        "status": status,
    }


def _get_or_create_experiment(client: MlflowClient, name: str) -> str:
    experiment = client.get_experiment_by_name(name)
    if experiment is not None:
        return experiment.experiment_id
    try:
        return client.create_experiment(name)
    except MlflowException:
        # Lost a race with another parallel Send branch creating the same experiment.
        experiment = client.get_experiment_by_name(name)
        if experiment is None:
            raise
        return experiment.experiment_id


def log_run(
    *,
    spec: ExperimentSpec,
    dataset_ref: str,
    metrics: dict[str, float],
    params: dict[str, str],
    artifacts: dict[str, bytes],
    status: Literal["success", "failed"],
    duration_s: float,
) -> str | None:
    """Logs one experiment run to MLflow. Returns the MLflow run_id, or None (logged, not
    raised) if the tracking server is unreachable or rejects the request."""
    try:
        client = MlflowClient(tracking_uri=settings.mlflow_tracking_uri)
        experiment_id = _get_or_create_experiment(client, _experiment_name(dataset_ref))
        run = client.create_run(
            experiment_id=experiment_id,
            tags=_build_tags(spec, dataset_ref=dataset_ref, status=status),
        )
        run_id = run.info.run_id

        params = _build_params(spec, {"duration_s": f"{duration_s:.3f}", **params})
        for key, value in params.items():
            client.log_param(run_id, key, value)
        for name, value in metrics.items():
            client.log_metric(run_id, name, value)

        with tempfile.TemporaryDirectory(prefix="foundry-mlflow-artifacts-") as tmp:
            for rel_path, content in artifacts.items():
                local_path = Path(tmp) / rel_path
                local_path.parent.mkdir(parents=True, exist_ok=True)
                local_path.write_bytes(content)
                client.log_artifact(run_id, str(local_path))

        client.set_terminated(run_id, status="FINISHED" if status == "success" else "FAILED")
        return run_id
    except Exception:
        # Best-effort: tracking is observability, never load-bearing for the experiment itself.
        logger.exception("tracker.log_run failed for experiment %s", spec.experiment_id)
        return None


def query_runs(dataset_ref: str, *, max_results: int = 100) -> list[RunSummary]:
    """Returns MLflow runs logged for `dataset_ref`'s experiment, most recent first. Returns an
    empty list (never raises) if the experiment doesn't exist yet or the server is unreachable —
    ready for M5's red team / M8's eval harness to consume."""
    try:
        client = MlflowClient(tracking_uri=settings.mlflow_tracking_uri)
        experiment = client.get_experiment_by_name(_experiment_name(dataset_ref))
        if experiment is None:
            return []
        runs = client.search_runs(
            experiment_ids=[experiment.experiment_id], max_results=max_results
        )
    except Exception:
        logger.exception("tracker.query_runs failed for dataset %s", dataset_ref)
        return []

    return [
        RunSummary(
            run_id=run.info.run_id,
            status=run.info.status,
            params=dict(run.data.params),
            metrics=dict(run.data.metrics),
            tags=dict(run.data.tags),
        )
        for run in runs
    ]
