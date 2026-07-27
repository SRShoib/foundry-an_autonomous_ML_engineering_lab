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

M4: reached via Send fan-out from foundry/teams/principal.py, one Send per pending ExperimentSpec
in the current planning batch (SPEC's "Send fan-out of experiment runners") — so this node reads
a small RunnerInput payload, not the full FoundryState; there is no "pending spec" lookup to do,
Send always names the one spec this branch runs. Multiple branches execute on separate threads
within one superstep (verified against LangGraph 1.2.9's BackgroundExecutor), so this function
must never mutate shared state — its only communication with the rest of the graph is the plain
dict it returns, merged back via FoundryState's add-reducer channels (experiments, costs) through
a static `experiment_runner -> principal` edge (foundry/graph.py), the same pattern
foundry/teams/reporter.py uses for its own single, static destination. spent_usd is deliberately
NOT set here: with N concurrent branches all reading the same base state["spent_usd"], the last
write would silently discard the others' cost — foundry/teams/principal.py is the sole writer,
deriving it as sum(costs) once the whole batch's costs have merged in.

MLflow logging (foundry/tools/tracker.py) happens here, host-side, strictly after sandbox.run
returns — CLAUDE.md's sandbox guardrail runs training code with no network, so nothing inside the
container could reach a tracking server even if it tried. A tracker failure never fails an
otherwise-successful experiment (see tracker.py's docstring)."""

from __future__ import annotations

import time
from typing import Literal, TypedDict

from pydantic import BaseModel

from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.llm import get_llm
from foundry.models import (
    CleaningPlan,
    CostEntry,
    CVStrategy,
    ExperimentResult,
    ExperimentSpec,
    SandboxLimits,
    TrainingCode,
)
from foundry.prompting import with_context
from foundry.tools import sandbox, tracker
from foundry.tools.cost import sandbox_cost_usd
from foundry.tools.metrics import METRICS_SENTINEL, MetricsParseError, parse_metrics

SUPPORTED_MODEL_FAMILIES = frozenset(
    {"logistic_regression", "random_forest", "gradient_boosting", "mlp"}
)  # xgboost/lightgbm are valid ExperimentSpec values but not installed in docker/sandbox/Dockerfile


class RunnerInput(TypedDict):
    """The Send payload foundry/teams/principal.py fans out — one per pending ExperimentSpec in
    the current planning batch, not the full FoundryState (LangGraph's map-reduce pattern)."""

    spec: ExperimentSpec
    dataset_ref: str
    cleaning_plan: CleaningPlan | None
    cv_strategy: CVStrategy | None
    prior_experiments: int
    batch_index: int


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
    batch_index: int
    previous_error: str | None = None


def _family_description(model_family: str, task_type: str) -> str:
    """model_family names a model FAMILY, not a concrete sklearn class — foundry/stubs.py's
    per-(family, task_type) estimator table is the code-owned source of truth for which class
    that means (M8: adding foundry/datasets.py's regression task exposed that "logistic_regression"
    is ambiguous read literally against a continuous target). This is prompt clarity for the real
    LLM path only: on a regression task, name the family's actual regression counterpart instead
    of the word "logistic" so a real model never wastes a self-debug attempt trying to fit
    LogisticRegression against a continuous y."""
    if task_type == "regression" and model_family == "logistic_regression":
        return "a linear regression model (the logistic_regression family's regression counterpart)"
    return f"a {model_family} model"


def build_code_prompt(request: CodeRequest) -> str:
    instructions = (
        f"Write a Python training script that trains "
        f"{_family_description(request.model_family, request.task_type)} on the "
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


def experiment_runner(payload: RunnerInput) -> dict[str, object]:
    spec = payload["spec"]
    dataset = get_dataset(payload["dataset_ref"])
    cleaning_plan = payload["cleaning_plan"]
    cv_strategy = payload["cv_strategy"]
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
        prior_experiments=payload["prior_experiments"],
        batch_index=payload["batch_index"],
        previous_error=None,
    )

    start = time.monotonic()
    last_error = ""
    attempts_used = 0
    result_metrics: dict[str, float] | None = None
    artifacts: dict[str, bytes] = {}

    for attempt in range(settings.self_debug_max_attempts):
        request = request.model_copy(
            update={"attempt": attempt, "previous_error": last_error or None}
        )
        code = llm.structured(build_code_prompt(request), TrainingCode)
        sandbox_result = sandbox.run(code.code, data_dir=dataset.path.parent, limits=limits)
        attempts_used = attempt + 1
        artifacts = sandbox_result.artifacts

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
    status: Literal["success", "failed"] = "success" if result_metrics is not None else "failed"

    costs: list[CostEntry] = [*llm.costs]
    costs.append(
        CostEntry(
            agent_role="sandbox",
            model="sandbox",
            kind="sandbox",
            usd=sandbox_cost_usd(duration_s),
        )
    )
    cost_usd = round(sum(entry.usd for entry in costs), 8)

    run_id = tracker.log_run(
        spec=spec,
        dataset_ref=payload["dataset_ref"],
        metrics=result_metrics or {},
        params={"cv_kind": request.cv_kind, "cv_n_splits": str(request.cv_n_splits)},
        artifacts=artifacts,
        status=status,
        duration_s=duration_s,
    )

    errors: list[str] = []
    if run_id is None:
        errors.append(f"experiment_runner: mlflow logging failed for {spec.experiment_id}")

    if result_metrics is not None:
        experiment_result = ExperimentResult(
            experiment_id=spec.experiment_id,
            mlflow_run_id=run_id,
            status="success",
            metrics=result_metrics,
            cost_usd=cost_usd,
            duration_s=duration_s,
            attempts=attempts_used,
        )
    else:
        experiment_result = ExperimentResult(
            experiment_id=spec.experiment_id,
            mlflow_run_id=run_id,
            status="failed",
            metrics={},
            cost_usd=cost_usd,
            duration_s=duration_s,
            attempts=attempts_used,
            error=last_error,
        )

    update: dict[str, object] = {"experiments": [experiment_result], "costs": costs}
    if errors:
        update["errors"] = errors
    return update
