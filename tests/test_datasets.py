"""Tests for foundry/datasets.py."""

from __future__ import annotations

import pytest

from foundry.config import settings
from foundry.datasets import REGISTRY, get_dataset


def test_churn_dataset_is_registered() -> None:
    dataset = get_dataset("churn")
    assert dataset.name == "churn"
    assert dataset.target_column == "churned"
    assert dataset.task_type == "binary_classification"
    assert dataset.primary_metric == "roc_auc"


def test_churn_csv_exists_and_has_the_target_column_in_its_header() -> None:
    dataset = get_dataset("churn")
    assert dataset.path.exists()
    with dataset.path.open(encoding="utf-8") as f:
        header = f.readline().strip().split(",")
    assert dataset.target_column in header
    assert "customer_id" in header


def test_energy_dataset_is_registered_as_the_regression_showcase_task() -> None:
    """M8: SPEC's "3 small bundled tabular tasks" -- churn, churn_leaky (the red-team fixture),
    and energy (the regression showcase, exercising leaderboard.py's lower_is_better path)."""
    dataset = get_dataset("energy")
    assert dataset.name == "energy"
    assert dataset.target_column == "monthly_kwh"
    assert dataset.task_type == "regression"
    assert dataset.primary_metric == "rmse"


def test_energy_csv_exists_and_has_the_target_column_in_its_header() -> None:
    dataset = get_dataset("energy")
    assert dataset.path.exists()
    with dataset.path.open(encoding="utf-8") as f:
        header = f.readline().strip().split(",")
    assert dataset.target_column in header
    assert "building_id" in header


def test_every_registry_path_is_under_the_configured_data_dir() -> None:
    for dataset in REGISTRY.values():
        assert dataset.path.is_relative_to(settings.data_dir)


def test_unknown_ref_raises_and_lists_valid_keys() -> None:
    with pytest.raises(KeyError, match="churn"):
        get_dataset("does-not-exist")
