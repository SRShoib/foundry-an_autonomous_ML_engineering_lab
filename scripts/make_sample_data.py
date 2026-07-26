"""Regenerates data/samples/churn.csv (SPEC M8: "3 small bundled tabular tasks (data + ground
truth)"; M3 ships the first one). The CSV itself is committed — this script exists so the
generative model is reproducible and documented, not because the repo depends on regenerating
it at install time.

Every column is deliberately awkward in one specific way a real churn extract would be:
customer_id is a row-unique identifier (the leakage trap the data team must catch, not drop
silently), avg_monthly_gb is missing wherever internet_service is "none" (structural
missingness, not random — forces a real imputation strategy), and total_charges is blank for
brand-new customers (tenure_months == 1). The label is generated from a logistic model with a
genuine interaction term (new customers on month-to-month contracts churn disproportionately),
so a linear baseline captures most — but not all — of the signal; see data/samples/README.md
for the measured CV results this produces.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

SEED = 20260726
N_ROWS = 1200
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "samples" / "churn.csv"


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


def main() -> None:
    rng = np.random.default_rng(SEED)
    frame = make_churn_frame(rng)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(OUT_PATH, index=False)
    print(f"wrote {len(frame)} rows to {OUT_PATH}")
    print(f"churn rate: {frame['churned'].mean():.3f}")
    print(f"total_charges missing: {frame['total_charges'].isna().sum()}")
    print(f"avg_monthly_gb missing: {frame['avg_monthly_gb'].isna().sum()}")


if __name__ == "__main__":
    main()
