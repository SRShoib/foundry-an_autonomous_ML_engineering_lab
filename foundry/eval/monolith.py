"""SPEC M8 ablation: "multi-agent vs single monolithic agent." run_monolith is a single agent that
plans one experiment and self-debugs it in the sandbox — no profiler, no cleaner, no splitter, no
literature scout, no leaderboard, no red team, no memory, no Send fan-out. It is deliberately built
almost entirely from pieces foundry/teams/experiment_runner.py and foundry/teams/modeling_team.py
already have (the same CodeRequest/build_code_prompt/sandbox.run/parse_metrics self-debug loop, the
same PlanContext/ExperimentPlan planning call), so the comparison in foundry/eval/report.py isolates
STRUCTURE — what the hierarchy buys — not a difference in prompt quality or model.

It flies blind on purpose: PlanContext gets n_rows=0/n_cols=0/no recommended_families (there is no
data_profile or approach_memo — nothing has profiled this dataset), and CodeRequest gets
drop_columns=[] (nothing has flagged an identifier column) — so on churn it never learns to drop
customer_id unless the LLM notices on its own, and on churn_leaky it reports whatever metric the
one attempt that succeeds prints, because nothing downstream audits it. Both are the measurable
consequences SPEC's ablation exists to surface, not oversights to fix.
"""

from __future__ import annotations

import time
import uuid

from foundry import leaderboard
from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.eval.harness import TaskResult, calls_by_agent
from foundry.llm import get_llm
from foundry.models import CostEntry, ExperimentPlan, SandboxLimits, TrainingCode
from foundry.prompting import with_context
from foundry.teams.experiment_runner import CodeRequest, build_code_prompt
from foundry.teams.modeling_team import _FALLBACK_SPEC, PlanContext
from foundry.teams.reporter import cost_by_agent
from foundry.tools import sandbox
from foundry.tools.cost import sandbox_cost_usd, total_usd
from foundry.tools.metrics import METRICS_SENTINEL, MetricsParseError, parse_metrics

_CLASSIFICATION_TASK_TYPES = frozenset({"binary_classification", "multiclass_classification"})


def run_monolith(dataset_ref: str, *, budget_usd: float = 20.0) -> TaskResult:
    dataset = get_dataset(dataset_ref)
    start = time.monotonic()
    costs: list[CostEntry] = []

    planner_llm = get_llm("worker")
    plan_context = PlanContext(
        goal=f"predict {dataset.target_column}",
        task_type=dataset.task_type,
        primary_metric=dataset.primary_metric,
        n_rows=0,
        n_cols=0,
        prior_experiments=0,
        prior_model_families=[],
    )
    plan = planner_llm.structured(
        with_context(
            "Propose one experiment to run on this dataset: a model family and reasonable "
            "hyperparameters.",
            plan_context,
        ),
        ExperimentPlan,
    )
    costs.extend(planner_llm.costs)
    spec = plan.specs[0] if plan.specs else _FALLBACK_SPEC

    worker_llm = get_llm("worker")
    limits = SandboxLimits(timeout_seconds=settings.experiment_timeout_seconds)
    cv_kind = "stratified_kfold" if dataset.task_type in _CLASSIFICATION_TASK_TYPES else "kfold"

    request = CodeRequest(
        experiment_id="monolith-001",
        model_family=spec.model_family,
        hyperparams=spec.hyperparams,
        dataset_path=f"/data/{dataset.path.name}",
        target_column=dataset.target_column,
        task_type=dataset.task_type,
        primary_metric=dataset.primary_metric,
        drop_columns=[],  # no data_team -- the whole point of this ablation, see module docstring
        numeric_impute="median",
        categorical_impute="most_frequent",
        cv_kind=cv_kind,
        cv_n_splits=5,
        random_seed=settings.random_seed,
        metrics_sentinel=METRICS_SENTINEL,
        attempt=0,
        prior_experiments=0,
        batch_index=0,
        previous_error=None,
    )

    last_error = ""
    result_metrics: dict[str, float] | None = None
    for attempt in range(settings.self_debug_max_attempts):
        request = request.model_copy(
            update={"attempt": attempt, "previous_error": last_error or None}
        )
        code = worker_llm.structured(build_code_prompt(request), TrainingCode)
        sandbox_result = sandbox.run(code.code, data_dir=dataset.path.parent, limits=limits)

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

    costs.extend(worker_llm.costs)
    wall_time_s = time.monotonic() - start
    costs.append(
        CostEntry(
            agent_role="sandbox", model="sandbox", kind="sandbox", usd=sandbox_cost_usd(wall_time_s)
        )
    )

    status_success = result_metrics is not None
    metric_value = result_metrics.get(dataset.primary_metric) if result_metrics else None
    target_met = metric_value is not None and leaderboard.target_met(
        metric_value, dataset.target_value, dataset.primary_metric
    )

    return TaskResult(
        dataset_ref=dataset_ref,
        config="monolith",
        approach="monolithic",
        thread_id=f"monolith-{dataset_ref}-{uuid.uuid4().hex[:8]}",
        stop_reason="single_shot" if status_success else "self_debug_exhausted",
        primary_metric_name=dataset.primary_metric,
        primary_metric_value=metric_value,
        target_value=dataset.target_value,
        target_met=target_met,
        n_experiments=1,
        n_successful=1 if status_success else 0,
        n_invalidated=0,  # no red team in this ablation, by construction -- see module docstring
        cost_total_usd=total_usd(costs),
        cost_by_agent=cost_by_agent(costs),
        calls_by_agent=calls_by_agent(costs),
        wall_time_s=wall_time_s,
        winning_model_family=spec.model_family,
        first_model_family=spec.model_family,
        error=None if status_success else last_error,
    )
