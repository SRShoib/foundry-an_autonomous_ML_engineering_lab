"""Tests for foundry/tools/audit.py. _build_audit_code is a pure string-template test (no
Docker required); audit() itself is proven against the real sandbox + both bundled datasets
under @pytest.mark.docker, the same split tests/test_profiler.py uses for _build_profile_code.
"""

from __future__ import annotations

import ast
import json

import pandas as pd
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


def _exec_audit_code(
    code: str, *, data_dir: str, dataset_filename: str, capsys: pytest.CaptureFixture[str]
) -> dict:
    """Runs generated audit code directly (no Docker) by redirecting its hardcoded /data/ mount
    path to a real, local directory — scikit-learn/pandas are transitive dev dependencies of
    foundry's own `mlflow` dependency (pinned in uv.lock), so this is genuinely dependency-free
    per conftest.py's docstring, the same reasoning tests/test_stubs.py's ast.parse checks lean
    on for TrainingCode. Mirrors foundry/tools/sandbox.py's own stdout-sentinel-line convention."""
    redirected = code.replace(f"/data/{dataset_filename}", f"{data_dir}/{dataset_filename}")
    exec(compile(redirected, "<audit-code>", "exec"), {})
    out = capsys.readouterr().out
    line = next(line for line in out.splitlines() if line.startswith(AUDIT_SENTINEL))
    return json.loads(line[len(AUDIT_SENTINEL) :].strip())


def test_median_split_matches_the_documented_churn_leaky_leak_auc(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """M8: audit.py now binarizes any numeric target before measuring association instead of
    gating the whole measurement on "target has exactly 2 unique values" — churn's target is
    already binary, so this must reproduce data/samples/README.md's documented 0.9962 exactly,
    not just approximately, proving the generalization is byte-identical on the binary case."""
    code = _build_audit_code(
        dataset_filename="churn_leaky.csv", target_column="churned", drop_columns=["customer_id"]
    )
    result = _exec_audit_code(
        code, data_dir="data/samples", dataset_filename="churn_leaky.csv", capsys=capsys
    )
    by_name = {col["name"]: col for col in result["columns"]}
    assert by_name["retention_call_outcome"]["target_auc"] == pytest.approx(0.9961948, abs=1e-6)


def test_median_split_measures_a_continuous_target_where_it_previously_yielded_none(
    tmp_path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Before M8, target_auc was gated on `y.nunique() == 2` — every column's target_auc stayed
    None forever on a continuous (regression) target, silently disabling the red team's leak floor
    for foundry/datasets.py's `energy` task. A column perfectly monotonic with the target must now
    measure a real (non-None), high target_auc via the median split."""
    df = pd.DataFrame(
        {
            "leaky": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
            "noise": [5, 1, 8, 2, 3, 7, 4, 6],
            "target": [10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 22.0, 24.0],
        }
    )
    df.to_csv(tmp_path / "regr.csv", index=False)
    code = _build_audit_code(dataset_filename="regr.csv", target_column="target", drop_columns=[])
    result = _exec_audit_code(
        code, data_dir=str(tmp_path).replace("\\", "/"), dataset_filename="regr.csv", capsys=capsys
    )
    by_name = {col["name"]: col for col in result["columns"]}
    assert by_name["leaky"]["target_auc"] == pytest.approx(1.0)


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
