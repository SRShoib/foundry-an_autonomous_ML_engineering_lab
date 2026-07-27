"""The only module containing canned data (SPEC M2: "graph runs with NO api keys"). No
foundry/teams/* module imports this one — the dependency runs stubs -> teams, never the
reverse, so fixtures never leak into a production node's import path. Registration happens in
exactly two places: foundry/cli.py::main() (guarded by `settings.anthropic_api_key is None`)
and tests — never from foundry.llm.get_llm(), which would put fixtures in the hot path.

Each factory is read_context(prompt, <the node's context model>) -> build a deterministic
response -> return. Determinism is therefore structural (a pure function of the typed context),
not seeded — the same inputs always produce the same canned output.

TrainingCode is the interesting one: only the very first runner of the very first Send-fanned-out
batch (attempt 0, prior_experiments == 0, batch_index == 0 — see RunnerInput in
foundry/teams/experiment_runner.py) emits deliberately naive code (raw DataFrame straight to the
estimator, no imputation or encoding), which fails with `ValueError: could not convert string to
float` — the single most common real failure mode of LLM-authored sklearn code. Every other
attempt, and every other runner in that same parallel batch, emits the correct ColumnTransformer
pipeline. So the offline run genuinely exercises the self-debug loop exactly once, without paying
an extra container start per parallel branch.
"""

from __future__ import annotations

from string import Template
from typing import Literal, cast

from foundry.config import settings
from foundry.llm import StubClient, get_stub_client
from foundry.models import (
    ApproachMemo,
    CleaningPlan,
    CVStrategy,
    DataProfile,
    ExperimentPlan,
    ExperimentSpec,
    LeakageFinding,
    LeakageReport,
    LessonDraft,
    PrincipalDirective,
    ProfileAssessment,
    RedTeamVerdict,
    ReportNarrative,
    TrainingCode,
)
from foundry.prompting import read_context
from foundry.teams.experiment_runner import SUPPORTED_MODEL_FAMILIES, CodeRequest
from foundry.teams.lessons import LessonContext
from foundry.teams.modeling_team import PlanContext, ScoutContext
from foundry.teams.principal import SupervisorContext
from foundry.teams.red_team import RedTeamContext
from foundry.teams.reporter import ReportContext
from foundry.tools.profiler import RawProfile

# --- ProfileAssessment / LeakageReport -------------------------------------------------------

_LEAK_AUC_HIGH = 0.98
_LEAK_AUC_LOW = 0.02


def _is_leak_column(col: object, n_rows: int) -> bool:
    n_unique = col.n_unique  # type: ignore[attr-defined]
    target_auc = col.target_auc  # type: ignore[attr-defined]
    if n_unique == n_rows:
        return True
    return target_auc is not None and (target_auc > _LEAK_AUC_HIGH or target_auc < _LEAK_AUC_LOW)


def _profile_assessment(prompt: str) -> ProfileAssessment:
    raw = read_context(prompt, RawProfile)
    leak_columns = [col.name for col in raw.columns if _is_leak_column(col, raw.n_rows)]
    is_binary = raw.target_positive_rate is not None
    return ProfileAssessment(
        task_type="binary_classification" if is_binary else "regression",
        potential_leak_columns=leak_columns,
        notes=f"{len(leak_columns)} column(s) flagged as potential leaks out of {raw.n_cols}.",
    )


def _leakage_report(prompt: str) -> LeakageReport:
    raw = read_context(prompt, RawProfile)
    findings: list[LeakageFinding] = []
    for col in raw.columns:
        if col.n_unique == raw.n_rows:
            findings.append(
                LeakageFinding(
                    column=col.name,
                    reason="unique per row: a row identifier, not a signal",
                    severity="low",
                )
            )
        elif col.target_auc is not None and (
            col.target_auc > _LEAK_AUC_HIGH or col.target_auc < _LEAK_AUC_LOW
        ):
            findings.append(
                LeakageFinding(
                    column=col.name,
                    reason=f"single-column AUC {col.target_auc:.3f} against the target — "
                    "likely a target proxy",
                    severity="high",
                )
            )
    return LeakageReport(findings=findings)


# --- CleaningPlan / CVStrategy ----------------------------------------------------------------


def _cleaning_plan(prompt: str) -> CleaningPlan:
    data_profile = read_context(prompt, DataProfile)
    drop = [col.name for col in data_profile.columns if col.is_potential_leak]
    return CleaningPlan(
        drop_columns=drop,
        numeric_impute="median",
        categorical_impute="most_frequent",
        rationale=(
            "Median/most-frequent imputation is robust to the structural missingness typical "
            "of a raw operational extract; flagged leak columns are dropped."
        ),
    )


def _cv_strategy(prompt: str) -> CVStrategy:
    data_profile = read_context(prompt, DataProfile)
    n_splits = 5 if data_profile.n_rows >= 500 else 3
    if data_profile.task_type in ("binary_classification", "multiclass_classification"):
        return CVStrategy(
            kind="stratified_kfold",
            n_splits=n_splits,
            rationale="Stratified k-fold preserves the class balance in every fold.",
        )
    return CVStrategy(
        kind="kfold",
        n_splits=n_splits,
        rationale="Plain k-fold: no class balance to preserve for a regression target.",
    )


# --- ExperimentPlan -----------------------------------------------------------------------------

_ModelFamily = Literal[
    "logistic_regression", "random_forest", "gradient_boosting", "xgboost", "lightgbm", "mlp"
]
_FAMILY_SEQUENCE: list[_ModelFamily] = [
    "logistic_regression", "random_forest", "gradient_boosting"
]


def _experiment_plan(prompt: str) -> ExperimentPlan:
    """Proposes up to max_experiments_per_iteration DISTINCT families per pass (M4: one planning
    pass now fans out via Send, so a single-spec plan would leave the fan-out with nothing to
    parallelize) — falls back to repeating the last family once every family has been tried.

    M7: context.recommended_families (the literature scout's ApproachMemo — see _approach_memo
    below) are tried FIRST, ahead of the default escalation order, and context.avoid_families are
    dropped from both lists entirely. This is what makes SPEC's "run #2 differs because of run
    #1's lessons" observable with no API key: a family a prior run's Lesson recommends jumps the
    queue here, on top of the same default order M4 already had."""
    context = read_context(prompt, PlanContext)
    avoid = set(context.avoid_families)
    tried = set(context.prior_model_families)
    preferred: list[_ModelFamily] = [
        cast(_ModelFamily, f)
        for f in context.recommended_families
        if f in SUPPORTED_MODEL_FAMILIES and f not in tried and f not in avoid
    ]
    remaining: list[_ModelFamily] = [
        f for f in _FAMILY_SEQUENCE if f not in tried and f not in avoid and f not in preferred
    ]
    families = (preferred + remaining)[: settings.max_experiments_per_iteration] or [
        _FAMILY_SEQUENCE[-1]
    ]
    specs = [
        ExperimentSpec(
            experiment_id="stub",  # overwritten by foundry/teams/modeling_team.py's code guard
            model_family=family,
            hyperparams={},
            rationale=(
                f"Escalating from prior attempts ({context.prior_model_families}) to {family}."
            ),
            est_cost_usd=0.01,
        )
        for family in families
    ]
    return ExperimentPlan(specs=specs)


# --- TrainingCode ---------------------------------------------------------------------------

# (import line, constructor expression) — the expression may itself reference $random_seed,
# which is filled in by the same Template.substitute() call as the rest of the code body.
_ESTIMATORS: dict[str, tuple[str, str]] = {
    "logistic_regression": (
        "from sklearn.linear_model import LogisticRegression",
        "LogisticRegression(max_iter=1000, random_state=$random_seed)",
    ),
    "random_forest": (
        "from sklearn.ensemble import RandomForestClassifier",
        "RandomForestClassifier(random_state=$random_seed, n_jobs=1)",
    ),
    "gradient_boosting": (
        "from sklearn.ensemble import GradientBoostingClassifier",
        "GradientBoostingClassifier(random_state=$random_seed)",
    ),
    "mlp": (
        "from sklearn.neural_network import MLPClassifier",
        "MLPClassifier(max_iter=500, random_state=$random_seed)",
    ),
}


def _naive_code(request: CodeRequest) -> str:
    """Deliberately buggy: no imputation, no categorical encoding. Fails with
    `ValueError: could not convert string to float` the moment sklearn tries to coerce the
    raw DataFrame (still containing string columns) to a numeric array."""
    import_line, ctor_expr = _ESTIMATORS[request.model_family]
    body = f"""\
import json
import joblib
import pandas as pd
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import roc_auc_score
{import_line}

df = pd.read_csv("$dataset_path")
drop_cols = $drop_columns
df = df.drop(columns=[c for c in drop_cols if c in df.columns])
X = df.drop(columns=["$target_column"])
y = df["$target_column"]

model = {ctor_expr}
cv = StratifiedKFold(n_splits=$cv_n_splits, shuffle=True, random_state=$random_seed)
proba = cross_val_predict(model, X, y, cv=cv, method="predict_proba")[:, 1]
auc = roc_auc_score(y, proba)

model.fit(X, y)
joblib.dump(model, "model.pkl")
print("$sentinel " + json.dumps({{"$primary_metric": auc}}))
"""
    return Template(body).substitute(
        dataset_path=request.dataset_path,
        drop_columns=repr(request.drop_columns),
        target_column=request.target_column,
        cv_n_splits=request.cv_n_splits,
        random_seed=request.random_seed,
        sentinel=request.metrics_sentinel,
        primary_metric=request.primary_metric,
    )


def _pipeline_code(request: CodeRequest) -> str:
    """The corrected version: impute + encode via a ColumnTransformer, then cross-validate.
    Scoped to binary classification with stratified k-fold — M3 ships exactly one bundled
    dataset; a regression/kfold variant is future work when M8 adds more tasks."""
    import_line, ctor_expr = _ESTIMATORS[request.model_family]
    body = f"""\
import json
import joblib
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import roc_auc_score
{import_line}

df = pd.read_csv("$dataset_path")
drop_cols = $drop_columns
df = df.drop(columns=[c for c in drop_cols if c in df.columns])
X = df.drop(columns=["$target_column"])
y = df["$target_column"]

numeric_cols = X.select_dtypes(include="number").columns.tolist()
categorical_cols = [c for c in X.columns if c not in numeric_cols]

pre = ColumnTransformer([
    ("num", Pipeline([
        ("impute", SimpleImputer(strategy="$numeric_impute")),
        ("scale", StandardScaler()),
    ]), numeric_cols),
    ("cat", Pipeline([
        ("impute", SimpleImputer(strategy="$categorical_impute")),
        ("ohe", OneHotEncoder(handle_unknown="ignore")),
    ]), categorical_cols),
])

model = Pipeline([("pre", pre), ("clf", {ctor_expr})])
cv = StratifiedKFold(n_splits=$cv_n_splits, shuffle=True, random_state=$random_seed)
proba = cross_val_predict(model, X, y, cv=cv, method="predict_proba")[:, 1]
auc = roc_auc_score(y, proba)

model.fit(X, y)
joblib.dump(model, "model.pkl")
print("$sentinel " + json.dumps({{"$primary_metric": auc}}))
"""
    return Template(body).substitute(
        dataset_path=request.dataset_path,
        drop_columns=repr(request.drop_columns),
        target_column=request.target_column,
        numeric_impute=request.numeric_impute,
        categorical_impute=request.categorical_impute,
        cv_n_splits=request.cv_n_splits,
        random_seed=request.random_seed,
        sentinel=request.metrics_sentinel,
        primary_metric=request.primary_metric,
    )


def _training_code(prompt: str) -> TrainingCode:
    # batch_index == 0 as well as prior_experiments == 0: under M4's Send fan-out, every runner
    # in the FIRST batch shares prior_experiments == 0 (none of its siblings have finished yet
    # when the batch launches — see foundry/teams/principal.py's _fanout), so without also
    # gating on batch_index every parallel branch would emit the deliberately-buggy naive code
    # and burn N extra containers instead of exactly one.
    request = read_context(prompt, CodeRequest)
    if request.attempt == 0 and request.prior_experiments == 0 and request.batch_index == 0:
        return TrainingCode(
            code=_naive_code(request),
            reasoning=(
                "First attempt: fit directly on the raw columns to establish a baseline; "
                "will iterate on encoding/imputation if this fails."
            ),
        )
    return TrainingCode(
        code=_pipeline_code(request),
        reasoning=(
            "Impute and encode via a ColumnTransformer pipeline, then cross-validate with "
            f"{request.cv_kind} ({request.cv_n_splits} splits)."
        ),
    )


# --- PrincipalDirective -------------------------------------------------------------------------


def _principal_directive(prompt: str) -> PrincipalDirective:
    context = read_context(prompt, SupervisorContext)
    if (
        context.best_metric_so_far is not None
        and context.best_metric_so_far >= context.target_value
    ):
        return PrincipalDirective(
            should_continue=False, stop_reason="target_met", rationale="Target metric reached."
        )
    if context.n_experiments_successful >= 2:
        return PrincipalDirective(
            should_continue=False,
            stop_reason="diminishing_returns",
            rationale=(
                f"{context.n_experiments_successful} experiments completed; further model "
                "families are unlikely to meaningfully improve on the current best."
            ),
        )
    return PrincipalDirective(
        should_continue=True,
        rationale="Still within budget and iteration limits.",
        focus="try the next untried model family",
    )


# --- RedTeamVerdict --------------------------------------------------------------------------


def _red_team_verdict(prompt: str) -> RedTeamVerdict:
    """Deliberately agrees with the measured evidence rather than being adversarially permissive
    — the code floor in foundry/teams/red_team.py's `_apply_floor` is what the booby-trap tests
    exercise against a hostile "always valid" fake LLM; this stub exists so the offline
    (no-API-key) path renders a believable audit trail, not to stress the floor itself."""
    context = read_context(prompt, RedTeamContext)
    if (
        context.worst_column_target_auc is not None
        and context.worst_column_target_auc >= settings.audit_leak_auc_threshold
    ):
        return RedTeamVerdict(
            verdict="invalidated",
            category="leakage",
            explanation=(
                f"Column {context.worst_column_name!r} measures target-association AUC "
                f"{context.worst_column_target_auc:.3f} on {context.experiment_id}'s training "
                "data — a likely target proxy."
            ),
            recommendation=f"Drop column {context.worst_column_name!r} and retrain.",
        )
    if context.duplicate_row_rate >= settings.audit_duplicate_row_rate:
        return RedTeamVerdict(
            verdict="invalidated",
            category="contamination",
            explanation=(
                f"{context.duplicate_row_rate:.1%} of rows are exact duplicates — likely "
                "train/test contamination under an ungrouped CV split."
            ),
            recommendation="Deduplicate the dataset or switch to a grouped CV strategy.",
        )
    if context.primary_metric_value >= settings.audit_suspicious_metric_ceiling:
        return RedTeamVerdict(
            verdict="invalidated",
            category="validation_overfitting",
            explanation=(
                f"{context.primary_metric} of {context.primary_metric_value:.4f} is implausibly "
                "close to perfect for real, noisy tabular data."
            ),
            recommendation="Re-examine the validation protocol before trusting this result.",
        )
    return RedTeamVerdict(
        verdict="valid",
        category="validation_overfitting",
        explanation="No leakage, contamination, or implausible-metric evidence found.",
        recommendation="No action needed.",
    )


# --- ReportNarrative -----------------------------------------------------------------------------


def _report_narrative(prompt: str) -> ReportNarrative:
    context = read_context(prompt, ReportContext)
    summary = (
        f"Ran {context.n_experiments} experiment(s) on {context.dataset_name} for the goal "
        f"'{context.goal}', {context.n_successful} of which completed successfully, over "
        f"{context.iteration_count} principal iteration(s). Stopped due to: "
        f"{context.stop_reason}."
    )
    if context.leaderboard:
        top = context.leaderboard[0]
        recommendation = (
            f"{top.experiment_id} is the strongest candidate on {top.primary_metric_name}; "
            "promote it and consider a wider hyperparameter sweep around it in a follow-up run."
        )
    else:
        recommendation = (
            "No experiment succeeded; investigate the self-debug traceback before re-running."
        )
    return ReportNarrative(summary=summary, recommendation=recommendation)


# --- ApproachMemo (M7) -----------------------------------------------------------------------


def _approach_memo(prompt: str) -> ApproachMemo:
    """Deterministic over context.past_best_family — itself code-computed by
    foundry/teams/modeling_team.py::_best_past_family from PAST runs' persisted Lesson records,
    never estimated here. Recommends nothing when there is no prior lesson (run #1 on a fresh
    dataset), so _experiment_plan's default escalation order is unaffected; recommends the past
    winner first otherwise, which is exactly what makes a second run's plan differ."""
    context = read_context(prompt, ScoutContext)
    if context.past_best_family and context.past_best_family not in context.prior_model_families:
        return ApproachMemo(
            summary=(
                f"{len(context.past_lessons)} prior lesson(s) on this dataset favor "
                f"{context.past_best_family}; try it first."
            ),
            recommended_families=[cast(_ModelFamily, context.past_best_family)],
        )
    return ApproachMemo(
        summary="No prior lesson recommends a specific family for this dataset; defaulting to "
        "the standard escalation order.",
    )


# --- LessonDraft (M7) -------------------------------------------------------------------------


def _lesson_draft(prompt: str) -> LessonDraft:
    context = read_context(prompt, LessonContext)
    if context.best_metric_value is None:
        return LessonDraft(
            text=(
                f"No experiment succeeded on this dataset (stop reason: {context.stop_reason}); "
                "investigate the self-debug traceback before the next run."
            )
        )
    text = (
        f"The best run reached {context.primary_metric}={context.best_metric_value:.4f} over "
        f"{context.n_successful}/{context.n_experiments} successful experiment(s)"
    )
    if context.n_invalidated:
        text += f", after the red team invalidated {context.n_invalidated} candidate(s)"
    text += f"; stop reason: {context.stop_reason}."
    return LessonDraft(text=text)


# --- registration ---------------------------------------------------------------------------


def register_canned_responses(client: StubClient) -> None:
    client.register(ProfileAssessment, _profile_assessment)
    client.register(LeakageReport, _leakage_report)
    client.register(CleaningPlan, _cleaning_plan)
    client.register(CVStrategy, _cv_strategy)
    client.register(ApproachMemo, _approach_memo)
    client.register(ExperimentPlan, _experiment_plan)
    client.register(TrainingCode, _training_code)
    client.register(PrincipalDirective, _principal_directive)
    client.register(RedTeamVerdict, _red_team_verdict)
    client.register(ReportNarrative, _report_narrative)
    client.register(LessonDraft, _lesson_draft)


def install_canned_responses() -> None:
    register_canned_responses(get_stub_client())
