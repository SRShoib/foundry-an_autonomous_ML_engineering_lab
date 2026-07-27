"""Bundled sample dataset registry (SPEC M8: "3 small bundled tabular tasks (data + ground
truth)"; M3 ships the first one). state["dataset_ref"] holds only a registry key — SPEC's
"path/key only — raw data stays OUT of state" — so this module is the single place that
resolves a key to a path, a target column, a task type, and the primary metric + target value
the principal checks for the "target metric hit" stop condition.

Deliberately not part of Settings (foundry/config.py): this is code plus bundled data, not
deployment configuration. Only the directory the CSVs live under is env-overridable.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from foundry.config import settings


class DatasetSpec(BaseModel):
    name: str
    path: Path
    target_column: str
    task_type: Literal["binary_classification", "multiclass_classification", "regression"]
    primary_metric: Literal["roc_auc", "accuracy", "f1", "rmse"]
    target_value: float
    description: str


REGISTRY: dict[str, DatasetSpec] = {
    "churn": DatasetSpec(
        name="churn",
        path=settings.data_dir / "churn.csv",
        target_column="churned",
        task_type="binary_classification",
        primary_metric="roc_auc",
        target_value=0.90,
        description=(
            "Synthetic telecom churn dataset, 1200 rows. Structural missingness in "
            "avg_monthly_gb (customers with no internet service) and total_charges (new "
            "customers) forces real imputation; customer_id is a row-unique identifier the "
            "data team must flag as a leak, not a feature."
        ),
    ),
    "churn_leaky": DatasetSpec(
        name="churn_leaky",
        path=settings.data_dir / "churn_leaky.csv",
        target_column="churned",
        task_type="binary_classification",
        primary_metric="roc_auc",
        target_value=0.90,
        description=(
            "M5 red-team fixture, not a showcase task: churn.csv's generative model (300 rows) "
            "plus one categorical column, retention_call_outcome, standing in for a retention "
            "call that only happens after the churn decision is already made. It is invisible "
            "to the data team's leak scan (foundry/tools/profiler.py computes target_auc only "
            "for numeric columns) and survives cleaning untouched, driving CV roc_auc to an "
            "implausible level. Exists to prove the red team catches what the data team's scan "
            "misses — see data/samples/README.md for the measured numbers."
        ),
    ),
}


def get_dataset(ref: str) -> DatasetSpec:
    try:
        return REGISTRY[ref]
    except KeyError:
        valid = ", ".join(sorted(REGISTRY))
        raise KeyError(f"unknown dataset_ref {ref!r}; valid keys: {valid}") from None
