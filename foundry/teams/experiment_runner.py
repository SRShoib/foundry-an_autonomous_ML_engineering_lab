"""The experiment runner (SPEC: "a ReAct agent with the sandbox tool... writes training code,
executes, reads traceback, self-debugs (max k=3 attempts)"). Hand-rolled as explicit nodes
rather than langgraph.prebuilt.create_react_agent: that prebuilt requires a real tool-calling
BaseChatModel, which StubClient is not (it implements only LLMClient.structured()), so it cannot
satisfy M2's "graph runs with NO api keys" guarantee. More importantly, the prebuilt agent would
read the sandbox's ToolMessage and narrate a final answer — the metrics reaching
ExperimentResult would pass through the model's mouth. Here, parse_metrics(result.stdout) is a
pure function over sandbox stdout and the LLM's only output is a TrainingCode.code string, so
CLAUDE.md's "metrics computed by code, never estimated by an LLM" is structural.

This is still reason → act → observe: the LLM's `reasoning` field carries the Thought,
sandbox.run is the Act, and the traceback fed into the next prompt is the Observation. The
self-debug bound is a literal `for attempt in range(settings.self_debug_max_attempts)`, so
SPEC's "max k=3" is counted, not an emergent property of a recursion_limit.
"""

from __future__ import annotations

import time
from typing import Literal

from langgraph.types import Command
from pydantic import BaseModel

from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import ExperimentResult, ExperimentSpec, SandboxLimits, TrainingCode
from foundry.prompting import with_context
from foundry.state import FoundryState
from foundry.tools import sandbox
from foundry.tools.metrics import METRICS_SENTINEL, MetricsParseError, parse_metrics

SUPPORTED_MODEL_FAMILIES = frozenset(
    {"logistic_regression", "random_forest", "gradient_boosting", "mlp"}
)  # xgboost/lightgbm are valid ExperimentSpec values but not installed in docker/sandbox/Dockerfile


class CodeRequest(BaseModel):
    experiment_id: str
    model_family: str
    hyperparams: dict[str, float | int | str | bool]
    dataset_path: str
    target_column: str
    task_type: str
    primary_metric: str
    drop_columns: list[str]
    numeric_impute: str
    categorical_impute: str
    cv_kind: str
    cv_n_splits: int
    random_seed: int
    metrics_sentinel: str
    attempt: int
    prior_experiments: int
    previous_error: str | None = None


def build_code_prompt(request: CodeRequest) -> str:
    instructions = (
        f"Write a Python training script that trains a {request.model_family} model on the "
        f"dataset at {request.dataset_path} to predict {request.target_column} "
        f"({request.task_type}), evaluated with {request.cv_kind} using {request.cv_n_splits} "
        f"splits and random_state={request.random_seed}. Drop these columns before fitting: "
        f"{request.drop_columns}. Impute numeric columns with {request.numeric_impute} and "
        f"categorical columns with {request.categorical_impute}, then encode categoricals. "
        f"Print exactly one line '{request.metrics_sentinel} <json>' with the cross-validated "
        f"{request.primary_metric} (and any other useful metrics) as the last line of output, "
        "and save the fitted model to model.pkl via joblib.dump."
    )
    if request.previous_error:
        instructions += (
            "\n\nThe previous attempt failed with this traceback — fix the bug and try again:"
            f"\n{request.previous_error}"
        )
    return with_context(instructions, request)


def _pending_spec(state: FoundryState) -> ExperimentSpec | None:
    done_ids = {result.experiment_id for result in state["experiments"]}
    for spec in state["experiment_plan"]:
        if spec.experiment_id not in done_ids:
            return spec
    return None


def _estimate_cost(*, attempts: int, duration_s: float) -> float:
    return round(
        attempts * settings.cost_per_llm_call_usd
        + (duration_s / 60.0) * settings.cost_per_sandbox_minute_usd,
        6,
    )


def experiment_runner(state: FoundryState) -> Command[Literal["principal"]]:
    spec = _pending_spec(state)
    if spec is None:
        return Command(
            goto="principal",
            update={"errors": ["experiment_runner: no pending experiment spec"]},
        )

    dataset = get_dataset(state["dataset_ref"])
    cleaning_plan = state["cleaning_plan"]
    cv_strategy = state["cv_strategy"]
    llm = get_llm("worker")
    limits = SandboxLimits(timeout_seconds=settings.experiment_timeout_seconds)

    request = CodeRequest(
        experiment_id=spec.experiment_id,
        model_family=spec.model_family,
        hyperparams=spec.hyperparams,
        dataset_path=f"/data/{dataset.path.name}",
        target_column=dataset.target_column,
        task_type=dataset.task_type,
        primary_metric=dataset.primary_metric,
        drop_columns=cleaning_plan.drop_columns if cleaning_plan else [],
        numeric_impute=cleaning_plan.numeric_impute if cleaning_plan else "median",
        categorical_impute=cleaning_plan.categorical_impute if cleaning_plan else "most_frequent",
        cv_kind=cv_strategy.kind if cv_strategy else "stratified_kfold",
        cv_n_splits=cv_strategy.n_splits if cv_strategy else 5,
        random_seed=settings.random_seed,
        metrics_sentinel=METRICS_SENTINEL,
        attempt=0,
        prior_experiments=len(state["experiments"]),
        previous_error=None,
    )

    start = time.monotonic()
    last_error = ""
    attempts_used = 0
    result_metrics: dict[str, float] | None = None

    for attempt in range(settings.self_debug_max_attempts):
        request = request.model_copy(
            update={"attempt": attempt, "previous_error": last_error or None}
        )
        code = llm.structured(build_code_prompt(request), TrainingCode)
        sandbox_result = sandbox.run(code.code, data_dir=dataset.path.parent, limits=limits)
        attempts_used = attempt + 1

        if sandbox_result.exit_code != 0:
            tail = sandbox_result.stderr or sandbox_result.stdout
            last_error = tail[-settings.self_debug_error_chars :]
            continue

        try:
            result_metrics = parse_metrics(sandbox_result.stdout)
        except MetricsParseError as exc:
            last_error = f"exit 0 but no valid metrics were printed: {exc}"
            continue

        break

    duration_s = time.monotonic() - start
    cost_usd = _estimate_cost(attempts=attempts_used, duration_s=duration_s)

    if result_metrics is not None:
        experiment_result = ExperimentResult(
            experiment_id=spec.experiment_id,
            status="success",
            metrics=result_metrics,
            cost_usd=cost_usd,
            duration_s=duration_s,
            attempts=attempts_used,
        )
    else:
        experiment_result = ExperimentResult(
            experiment_id=spec.experiment_id,
            status="failed",
            metrics={},
            cost_usd=cost_usd,
            duration_s=duration_s,
            attempts=attempts_used,
            error=last_error,
        )

    return Command(
        goto="principal",
        update={
            "experiments": [experiment_result],
            "spent_usd": state["spent_usd"] + cost_usd,
        },
    )
