"""Red team evidence collector (SPEC: "adversarial auditor of every leaderboard candidate: data
leakage, train/test contamination, improper CV..."). Runs in the sandbox exactly like
foundry/tools/profiler.py's `profile` — measurements are code-authored, never estimated by an
LLM (CLAUDE.md) — but audits the dataset AFTER foundry/teams/data_team.py's CleaningPlan has been
applied, so it sees exactly the columns a training run would actually see, not the raw extract.

The one real gap this closes: foundry/tools/profiler.py's `target_auc` (and therefore
foundry/stubs.py's leak heuristic keyed off it) is computed only for numeric columns — see its
own docstring. A categorical column that is just as much a target proxy (e.g. a post-hoc outcome
label) sails through the data team's scan untouched. `audit()` measures target association for
categorical columns too, via a simple in-sample target encoding (mean target rate per category,
scored back against the same rows) — deliberately the same naive, whole-dataset encoding a buggy
training pipeline would produce if it fit its encoder before splitting, so the audit's AUC picks
up exactly the leak a naive pipeline would exploit.

`duplicate_row_count`/`duplicate_row_rate` measure a second, independent failure mode: exact
duplicate feature+target rows, the signature of a join/export bug that lets the same record land
in both the train and test fold of an ungrouped CV split (SPEC's "train/test contamination" /
"improper CV").

One sandbox run per (dataset, cleaning_plan) — the evidence does not depend on which experiment
is being audited, only on what the training data looks like after cleaning — so
foundry/teams/red_team.py calls this once per audit pass and reuses the AuditReport across every
pending candidate in that pass.
"""

from __future__ import annotations

from string import Template

from pydantic import BaseModel

from foundry.config import settings
from foundry.datasets import DatasetSpec
from foundry.models import CleaningPlan, SandboxLimits
from foundry.tools import sandbox

AUDIT_SENTINEL = "FOUNDRY_AUDIT"


class AuditError(RuntimeError):
    pass


class AuditColumnStat(BaseModel):
    name: str
    is_numeric: bool
    target_auc: float | None = None


class AuditReport(BaseModel):
    dataset_name: str
    n_rows: int
    n_cols: int
    target_column: str
    columns: list[AuditColumnStat]
    duplicate_row_count: int
    duplicate_row_rate: float


# string.Template (not an f-string) — same reasoning as foundry/tools/profiler.py: the code
# body's own {...} dict/list literals would otherwise need doubling to escape f-string braces.
_AUDIT_CODE_TEMPLATE = Template(
    '''\
import json

import pandas as pd
from sklearn.metrics import roc_auc_score

df = pd.read_csv("/data/$dataset_filename")
target = "$target_column"
drop_cols = $drop_columns
df = df.drop(columns=[c for c in drop_cols if c in df.columns and c != target])

n_rows, n_cols = df.shape
y = df[target]

duplicate_row_count = int(df.duplicated().sum())
duplicate_row_rate = float(duplicate_row_count / n_rows) if n_rows else 0.0

columns = []
for col in df.columns:
    if col == target:
        continue
    series = df[col]
    is_numeric = bool(pd.api.types.is_numeric_dtype(series))
    target_auc = None
    mask = series.notna() & y.notna()
    if mask.sum() > 1 and y[mask].nunique() == 2:
        try:
            if is_numeric:
                if series[mask].nunique() > 1:
                    target_auc = float(roc_auc_score(y[mask], series[mask]))
            else:
                # In-sample target encoding: replace each category with its own mean target
                # rate, then score the encoding against the same rows. Deliberately naive (the
                # same whole-dataset fit/transform a buggy pipeline would do before splitting) so
                # this AUC surfaces exactly the leak such a pipeline would exploit.
                category_means = y[mask].groupby(series[mask]).transform("mean")
                if category_means.nunique() > 1:
                    target_auc = float(roc_auc_score(y[mask], category_means))
        except ValueError:
            target_auc = None

    columns.append({
        "name": col,
        "is_numeric": is_numeric,
        "target_auc": target_auc,
    })

result = {
    "dataset_name": "$dataset_filename",
    "n_rows": int(n_rows),
    "n_cols": int(n_cols),
    "target_column": target,
    "columns": columns,
    "duplicate_row_count": duplicate_row_count,
    "duplicate_row_rate": duplicate_row_rate,
}
print("$sentinel " + json.dumps(result))
'''
)


def _build_audit_code(
    *, dataset_filename: str, target_column: str, drop_columns: list[str]
) -> str:
    return _AUDIT_CODE_TEMPLATE.substitute(
        dataset_filename=dataset_filename,
        target_column=target_column,
        drop_columns=repr(drop_columns),
        sentinel=AUDIT_SENTINEL,
    )


def audit(
    dataset: DatasetSpec,
    cleaning_plan: CleaningPlan | None,
    *,
    limits: SandboxLimits | None = None,
) -> AuditReport:
    code = _build_audit_code(
        dataset_filename=dataset.path.name,
        target_column=dataset.target_column,
        drop_columns=cleaning_plan.drop_columns if cleaning_plan else [],
    )
    result = sandbox.run(
        code,
        data_dir=dataset.path.parent,
        limits=limits or SandboxLimits(timeout_seconds=settings.audit_timeout_seconds),
    )
    if result.exit_code != 0:
        raise AuditError(f"audit failed (exit={result.exit_code}): {result.stderr}")

    lines = [line for line in result.stdout.splitlines() if line.startswith(AUDIT_SENTINEL)]
    if not lines:
        raise AuditError(f"no {AUDIT_SENTINEL} line found in stdout: {result.stdout!r}")

    payload = lines[-1][len(AUDIT_SENTINEL) :].strip()
    return AuditReport.model_validate_json(payload)
