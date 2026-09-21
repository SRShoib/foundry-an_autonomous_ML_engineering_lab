"""Leaderboard ranking (SPEC: "leaderboard (best runs)" — a live FoundryState field the
principal maintains every turn it runs, not something computed once at the end by the reporter;
M5's red team needs to audit "every leaderboard candidate" as experiments complete, not just the
final set). Lives at top level rather than under foundry/tools/ (pure ranking over
already-computed ExperimentResults, not a SPEC "tool") and rather than in
foundry/teams/reporter.py, its M3 home (a principal -> reporter import would run the wrong
direction: the reporter is the last node in the graph, the principal runs every iteration).

metric_direction encodes which primary metrics rank higher-is-better (roc_auc, accuracy, f1) vs
lower-is-better (rmse) — SPEC only ships roc_auc today (churn dataset), but
foundry/teams/principal.py's "target metric hit" stop condition would be silently backwards for
rmse the moment M8 adds a regression task, so direction is threaded through now rather than
assumed via a bare max()."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from foundry.models import ExperimentResult, LeaderboardEntry

MetricDirection = Literal["higher_is_better", "lower_is_better"]

_LOWER_IS_BETTER = frozenset({"rmse"})


def metric_direction(metric: str) -> MetricDirection:
    return "lower_is_better" if metric in _LOWER_IS_BETTER else "higher_is_better"


def target_met(value: float, target: float, metric: str) -> bool:
    return value <= target if metric_direction(metric) == "lower_is_better" else value >= target


def _successful_scores(
    results: Sequence[ExperimentResult], metric: str
) -> list[tuple[ExperimentResult, float]]:
    return [
        (result, result.metrics[metric])
        for result in results
        if result.status == "success" and metric in result.metrics
    ]


def rank_experiments(results: Sequence[ExperimentResult], metric: str) -> list[LeaderboardEntry]:
    scored = _successful_scores(results, metric)
    scored.sort(key=lambda pair: pair[1], reverse=metric_direction(metric) == "higher_is_better")
    return [
        LeaderboardEntry(
            experiment_id=result.experiment_id,
            mlflow_run_id=result.mlflow_run_id,
            primary_metric_name=metric,
            primary_metric_value=value,
            rank=i + 1,
        )
        for i, (result, value) in enumerate(scored)
    ]


def best_result(results: Sequence[ExperimentResult], metric: str) -> ExperimentResult | None:
    scored = _successful_scores(results, metric)
    if not scored:
        return None
    pick = min if metric_direction(metric) == "lower_is_better" else max
    return pick(scored, key=lambda pair: pair[1])[0]
