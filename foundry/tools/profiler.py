"""Measures a dataset inside the sandbox (CLAUDE.md: "Agent-written code executes ONLY in the
Docker sandbox" — and the host process never loads a customer's raw data either, so profiling
follows the same rule as training). RawProfile/RawColumnStats are pure measurements: n_rows,
n_missing, target_corr, target_auc. They carry no judgment about which columns are leaks or
what the task type is — that is ProfileAssessment (foundry/models.py), an LLM call downstream in
foundry/teams/data_team.py that reads this profile as its typed context.

target_auc is the leakage tell: a single numeric column's own ROC AUC against the target. A
value near 1.0 means the column is (almost) the target in disguise. It is None for non-numeric
columns and for the target column itself; row-unique identifiers like a customer id are instead
caught by n_unique == n_rows, since an id column has no numeric relationship to flag.
"""

from __future__ import annotations

from string import Template

from pydantic import BaseModel

from foundry.config import settings
from foundry.datasets import DatasetSpec
from foundry.models import SandboxLimits
from foundry.tools import sandbox

PROFILE_SENTINEL = "FOUNDRY_PROFILE"
_SAMPLE_VALUES = 5


class ProfileError(RuntimeError):
    pass


class RawColumnStats(BaseModel):
    name: str
    dtype: str
    n_missing: int
    pct_missing: float
    n_unique: int
    is_numeric: bool
    sample_values: list[str]
    target_corr: float | None = None
    target_auc: float | None = None


class RawProfile(BaseModel):
    dataset_name: str
    n_rows: int
    n_cols: int
    target_column: str
    target_positive_rate: float | None = None
    columns: list[RawColumnStats]


# string.Template (not an f-string): the code body's own {...} dict/list literals would
# otherwise need doubling to escape f-string brace interpolation. $identifier substitution
# sidesteps that entirely.
_PROFILE_CODE_TEMPLATE = Template(
    '''\
import json

import pandas as pd
from sklearn.metrics import roc_auc_score

df = pd.read_csv("/data/$dataset_filename")
target = "$target_column"
n_rows, n_cols = df.shape

y = df[target]
target_positive_rate = None
if y.dropna().nunique() <= 2:
    target_positive_rate = float(y.dropna().mean())

columns = []
for col in df.columns:
    series = df[col]
    is_numeric = bool(pd.api.types.is_numeric_dtype(series))
    n_missing = int(series.isna().sum())
    n_unique = int(series.nunique(dropna=True))
    sample_values = [str(v) for v in series.dropna().unique()[:$sample_values]]

    target_corr = None
    target_auc = None
    if col != target and is_numeric:
        mask = series.notna() & y.notna()
        if mask.sum() > 1 and series[mask].nunique() > 1:
            target_corr = float(series[mask].corr(y[mask]))
            if y[mask].nunique() == 2:
                try:
                    target_auc = float(roc_auc_score(y[mask], series[mask]))
                except ValueError:
                    target_auc = None

    columns.append({
        "name": col,
        "dtype": str(series.dtype),
        "n_missing": n_missing,
        "pct_missing": float(n_missing / n_rows) if n_rows else 0.0,
        "n_unique": n_unique,
        "is_numeric": is_numeric,
        "sample_values": sample_values,
        "target_corr": target_corr,
        "target_auc": target_auc,
    })

result = {
    "dataset_name": "$dataset_filename",
    "n_rows": int(n_rows),
    "n_cols": int(n_cols),
    "target_column": target,
    "target_positive_rate": target_positive_rate,
    "columns": columns,
}
print("$sentinel " + json.dumps(result))
'''
)


def _build_profile_code(*, dataset_filename: str, target_column: str, sample_values: int) -> str:
    return _PROFILE_CODE_TEMPLATE.substitute(
        dataset_filename=dataset_filename,
        target_column=target_column,
        sample_values=sample_values,
        sentinel=PROFILE_SENTINEL,
    )


def profile(dataset: DatasetSpec, *, limits: SandboxLimits | None = None) -> RawProfile:
    code = _build_profile_code(
        dataset_filename=dataset.path.name,
        target_column=dataset.target_column,
        sample_values=_SAMPLE_VALUES,
    )
    result = sandbox.run(
        code,
        data_dir=dataset.path.parent,
        limits=limits or SandboxLimits(timeout_seconds=settings.profile_timeout_seconds),
    )
    if result.exit_code != 0:
        raise ProfileError(f"profiling failed (exit={result.exit_code}): {result.stderr}")

    lines = [line for line in result.stdout.splitlines() if line.startswith(PROFILE_SENTINEL)]
    if not lines:
        raise ProfileError(f"no {PROFILE_SENTINEL} line found in stdout: {result.stdout!r}")

    payload = lines[-1][len(PROFILE_SENTINEL) :].strip()
    return RawProfile.model_validate_json(payload)
