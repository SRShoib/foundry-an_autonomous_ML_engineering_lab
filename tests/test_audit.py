"""Tests for foundry/tools/audit.py. _build_audit_code is a pure string-template test (no
Docker required); audit() itself is proven against the real sandbox + both bundled datasets
under @pytest.mark.docker, the same split tests/test_profiler.py uses for _build_profile_code.
"""

from __future__ import annotations

import ast

import pytest

from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.models import CleaningPlan
from foundry.tools.audit import AUDIT_SENTINEL, _build_audit_code, audit


def test_build_audit_code_embeds_dataset_path_target_drop_columns_and_sentinel() -> None:
    code = _build_audit_code(
        dataset_filename="churn.csv", target_column="churned", drop_columns=["customer_id"]
    )
    assert "/data/churn.csv" in code
    assert 'target = "churned"' in code
    assert "customer_id" in code
    assert AUDIT_SENTINEL in code
    ast.parse(code)  # syntax proof, no Docker needed


@pytest.mark.docker
def test_audit_finds_no_leak_on_the_honest_churn_dataset() -> None:
    dataset = get_dataset("churn")
    cleaning_plan = CleaningPlan(drop_columns=["customer_id"], rationale="row-unique id")
    report = audit(dataset, cleaning_plan)

    assert report.n_rows == 1200
    assert report.duplicate_row_rate < settings.audit_duplicate_row_rate
    assert all(
        col.target_auc is None or col.target_auc < settings.audit_leak_auc_threshold
        for col in report.columns
    )


@pytest.mark.docker
def test_audit_catches_the_categorical_leak_on_churn_leaky() -> None:
    """The booby trap: retention_call_outcome is categorical, so
    foundry/tools/profiler.py's target_auc (numeric-only) never sees it — audit()'s
    target-encoded AUC does."""
    dataset = get_dataset("churn_leaky")
    cleaning_plan = CleaningPlan(drop_columns=["customer_id"], rationale="row-unique id")
    report = audit(dataset, cleaning_plan)

    by_name = {col.name: col for col in report.columns}
    leak = by_name["retention_call_outcome"]
    assert leak.is_numeric is False
    assert leak.target_auc is not None
    assert leak.target_auc >= settings.audit_leak_auc_threshold


@pytest.mark.docker
def test_audit_no_longer_sees_the_leak_column_once_it_is_dropped() -> None:
    dataset = get_dataset("churn_leaky")
    cleaning_plan = CleaningPlan(
        drop_columns=["customer_id", "retention_call_outcome"], rationale="post-remediation"
    )
    report = audit(dataset, cleaning_plan)
    assert "retention_call_outcome" not in {col.name for col in report.columns}
