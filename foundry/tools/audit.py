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

M8: target association generalizes to every task type by binarizing the target before measuring
it, rather than gating the whole measurement on "target has exactly 2 unique values" (which made
this entire tool a silent no-op on M8's regression task — every target_auc would have stayed None
forever). A target that is already binary is used as-is (byte-identical AUCs on churn/churn_leaky
to every number data/samples/README.md already documents — verified by test, not assumed); any
other numeric target (a continuous regression target, or a numeric-coded multiclass label) is
split at its own median first, then scored with the exact same numeric/categorical AUC machinery
below. A non-numeric multiclass target has no well-defined median split, so every column's
target_auc stays None in that case, same as before this change. `audit_leak_auc_threshold`
therefore keeps one meaning across every task type instead of two.

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
y_raw = df[target]

duplicate_row_count = int(df.duplicated().sum())
duplicate_row_rate = float(duplicate_row_count / n_rows) if n_rows else 0.0

# Generalizes across every task type: a binary target is used as-is (byte-identical to the old
# behavior); any other numeric target (a continuous regression target, or a numeric-coded
# multiclass label) is binarized at its own median first, so the same leak floor applies
# uniformly. A non-numeric multiclass target has no well-defined median split, so y_bin stays
# None and every column's target_auc below stays None too, same as before this change.
y_bin = None
if pd.api.types.is_numeric_dtype(y_raw):
    if y_raw.dropna().nunique() == 2:
        y_bin = y_raw
    elif y_raw.dropna().nunique() > 2:
        y_bin = (y_raw > y_raw.median()).astype(int)

columns = []
for col in df.columns:
    if col == target:
        continue
    series = df[col]
    is_numeric = bool(pd.api.types.is_numeric_dtype(series))
    target_auc = None
    if y_bin is not None:
        mask = series.notna() & y_bin.notna()
        if mask.sum() > 1:
            try:
                if is_numeric:
                    if series[mask].nunique() > 1:
                        target_auc = float(roc_auc_score(y_bin[mask], series[mask]))
                else:
                    # In-sample target encoding: replace each category with its own mean target
                    # rate, then score the encoding against the same rows. Deliberately naive
                    # (the same whole-dataset fit/transform a buggy pipeline would do before
                    # splitting) so this AUC surfaces exactly the leak such a pipeline would
                    # exploit.
                    category_means = y_bin[mask].groupby(series[mask]).transform("mean")
                    if category_means.nunique() > 1:
                        target_auc = float(roc_auc_score(y_bin[mask], category_means))
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
