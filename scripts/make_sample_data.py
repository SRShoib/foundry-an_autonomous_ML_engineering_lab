"""Regenerates data/samples/churn.csv and data/samples/churn_leaky.csv (SPEC M8: "3 small bundled
tabular tasks (data + ground truth)"; M3 ships the first one). Both CSVs are committed — this
script exists so the generative model is reproducible and documented, not because the repo
depends on regenerating either at install time.

churn.csv: every column is deliberately awkward in one specific way a real churn extract would
be: customer_id is a row-unique identifier (the leakage trap the data team must catch, not drop
silently), avg_monthly_gb is missing wherever internet_service is "none" (structural
missingness, not random — forces a real imputation strategy), and total_charges is blank for
brand-new customers (tenure_months == 1). The label is generated from a logistic model with a
genuine interaction term (new customers on month-to-month contracts churn disproportionately),
so a linear baseline captures most — but not all — of the signal; see data/samples/README.md
for the measured CV results this produces.

churn_leaky.csv (M5's red-team fixture, not a showcase task): the same generative model, plus one
categorical column, `retention_call_outcome`, standing in for a retention call that only ever
happens AFTER the churn decision is already made — a real, common shape of post-hoc leakage.
`churned == 1` rows get `churn_confirmed` 90% of the time and `not_contacted` 10%; `churned == 0`
rows get `saved` 90% of the time and `not_contacted` 10%. Two of the three categories therefore
determine the label almost exactly, while `not_contacted` stays genuinely ambiguous — strong but
imperfect leakage, not a literal `churned` copy. It is invisible to foundry/tools/profiler.py's
leak heuristic (target_auc is computed only for numeric columns) and survives cleaning
untouched; foundry/tools/audit.py's target-encoded AUC is what actually catches it — see
data/samples/README.md for the measured numbers.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

SEED = 20260726
N_ROWS = 1200
LEAKY_SEED = 20260727
LEAKY_N_ROWS = 300
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "samples" / "churn.csv"
LEAKY_OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "samples" / "churn_leaky.csv"


def make_churn_frame(rng: np.random.Generator, n_rows: int = N_ROWS) -> pd.DataFrame:
    customer_id = [f"CUST-{i:05d}" for i in range(1, n_rows + 1)]
    tenure_months = rng.integers(1, 73, size=n_rows)
    monthly_charges = np.round(rng.uniform(18.50, 118.75, size=n_rows), 2)

    contract_type = rng.choice(
        ["month_to_month", "one_year", "two_year"], size=n_rows, p=[0.55, 0.25, 0.20]
    )
    payment_method = rng.choice(
        ["electronic_check", "mailed_check", "bank_transfer", "credit_card"],
        size=n_rows,
        p=[0.35, 0.20, 0.22, 0.23],
    )
    internet_service = rng.choice(
        ["dsl", "fiber_optic", "none"], size=n_rows, p=[0.38, 0.44, 0.18]
    )

    num_support_tickets = np.clip(rng.poisson(1.6, size=n_rows), 0, 12)
    is_senior = rng.binomial(1, 0.16, size=n_rows)
    has_dependents = rng.binomial(1, 0.30, size=n_rows)

    total_charges = tenure_months * monthly_charges * rng.uniform(0.97, 1.03, size=n_rows)
    total_charges = np.round(total_charges, 2)
    new_customer = tenure_months == 1
    total_charges = total_charges.astype(object)
    total_charges[new_customer] = np.nan

    avg_monthly_gb = np.round(rng.gamma(3.0, 40.0, size=n_rows), 1)
    avg_monthly_gb = avg_monthly_gb.astype(object)
    avg_monthly_gb[internet_service == "none"] = np.nan

    month_to_month = contract_type == "month_to_month"
    electronic_check = payment_method == "electronic_check"
    fiber = internet_service == "fiber_optic"
    new_on_mtm = (tenure_months < 12) & month_to_month

    logit = (
        -3.4
        - 0.055 * tenure_months
        + 0.030 * monthly_charges
        + 1.5 * month_to_month
        + 0.8 * electronic_check
        + 0.7 * fiber
        + 0.28 * num_support_tickets
        - 0.6 * has_dependents
        + 0.4 * is_senior
        + 1.4 * new_on_mtm
        + rng.normal(0, 0.25, size=n_rows)
    )
    prob = 1 / (1 + np.exp(-logit))
    churned = rng.binomial(1, prob)

    return pd.DataFrame(
        {
            "customer_id": customer_id,
            "tenure_months": tenure_months,
            "monthly_charges": monthly_charges,
            "total_charges": total_charges,
            "contract_type": contract_type,
            "payment_method": payment_method,
            "internet_service": internet_service,
            "num_support_tickets": num_support_tickets,
            "avg_monthly_gb": avg_monthly_gb,
            "is_senior": is_senior,
            "has_dependents": has_dependents,
            "churned": churned,
        }
    )


def add_retention_call_leak(frame: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    """Adds `retention_call_outcome` — a post-hoc, categorical target proxy (see module
    docstring). Strong (90/10) but deliberately imperfect, so it is genuine leakage rather than
    a literal copy of the label."""
    frame = frame.copy()
    churned = frame["churned"].to_numpy()
    outcome = np.empty(len(frame), dtype=object)

    churned_mask = churned == 1
    outcome[churned_mask] = rng.choice(
        ["churn_confirmed", "not_contacted"], size=int(churned_mask.sum()), p=[0.9, 0.1]
    )
    outcome[~churned_mask] = rng.choice(
        ["saved", "not_contacted"], size=int((~churned_mask).sum()), p=[0.9, 0.1]
    )
    frame["retention_call_outcome"] = outcome
    return frame


def main() -> None:
    rng = np.random.default_rng(SEED)
    frame = make_churn_frame(rng)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(OUT_PATH, index=False)
    print(f"wrote {len(frame)} rows to {OUT_PATH}")
    print(f"churn rate: {frame['churned'].mean():.3f}")
    print(f"total_charges missing: {frame['total_charges'].isna().sum()}")
    print(f"avg_monthly_gb missing: {frame['avg_monthly_gb'].isna().sum()}")

    leaky_rng = np.random.default_rng(LEAKY_SEED)
    leaky_frame = make_churn_frame(leaky_rng, n_rows=LEAKY_N_ROWS)
    leaky_frame = add_retention_call_leak(leaky_frame, leaky_rng)
    LEAKY_OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    leaky_frame.to_csv(LEAKY_OUT_PATH, index=False)
    print(f"wrote {len(leaky_frame)} rows to {LEAKY_OUT_PATH}")
    print(f"churn rate: {leaky_frame['churned'].mean():.3f}")
    print(leaky_frame["retention_call_outcome"].value_counts())


if __name__ == "__main__":
    main()
