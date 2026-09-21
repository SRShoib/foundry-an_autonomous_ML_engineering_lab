"""Tests for foundry/tools/profiler.py. _build_profile_code is a pure string-template test (no
Docker required); profile() itself is proven against the real sandbox + churn.csv under
@pytest.mark.docker, the same split tests/test_sandbox.py uses for _build_command."""

from __future__ import annotations

import ast

import pytest

from foundry.datasets import get_dataset
from foundry.tools.profiler import PROFILE_SENTINEL, _build_profile_code, profile


def test_build_profile_code_embeds_dataset_path_target_and_sentinel() -> None:
    code = _build_profile_code(
        dataset_filename="churn.csv", target_column="churned", sample_values=5
    )
    assert "/data/churn.csv" in code
    assert 'target = "churned"' in code
    assert PROFILE_SENTINEL in code
    ast.parse(code)  # syntax proof, no Docker needed


@pytest.mark.docker
def test_profile_measures_the_real_churn_csv() -> None:
    dataset = get_dataset("churn")
    raw = profile(dataset)

    assert raw.n_rows == 1200
    assert raw.n_cols == 12
    assert raw.target_positive_rate is not None

    by_name = {col.name: col for col in raw.columns}
    assert by_name["customer_id"].n_unique == raw.n_rows
    assert by_name["avg_monthly_gb"].n_missing > 0
    assert by_name["total_charges"].n_missing > 0
