import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { makeFinding, makeRunStatus } from "../test/fixtures";
import { RunsTable } from "./RunsTable";

function renderTable(runs: Parameters<typeof RunsTable>[0]["runs"]) {
  render(
    <MemoryRouter>
      <RunsTable runs={runs} />
    </MemoryRouter>,
  );
}

describe("RunsTable", () => {
  it("links the goal to the run and shows its dataset and spend", () => {
    renderTable([
      makeRunStatus({
        thread_id: "run-1",
        dataset_ref: "churn",
        goal: "predict churn",
        spent_usd: 12.84,
        budget_usd: 20,
      }),
    ]);
    expect(screen.getByRole("link", { name: "predict churn" })).toHaveAttribute("href", "/runs/run-1");
    expect(screen.getByRole("cell", { name: "churn" })).toBeInTheDocument();
    expect(screen.getByText("$12.84")).toBeInTheDocument();
  });

  it("falls back to an em dash for a rehydrated run with no goal, dataset or best metric yet", () => {
    renderTable([makeRunStatus({ thread_id: "run-1", goal: null, dataset_ref: null, updated_at: null })]);
    // status, dataset, best, ⊘, stopped, updated all read "—"; goal's link text does too
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole("link", { name: "—" })).toHaveAttribute("href", "/runs/run-1");
  });

  it("shows the best leaderboard entry's metric", () => {
    renderTable([
      makeRunStatus({
        leaderboard: [
          { experiment_id: "exp-1", mlflow_run_id: null, primary_metric_name: "roc_auc", primary_metric_value: 0.8814, rank: 1 },
        ],
      }),
    ]);
    expect(screen.getByText("0.8814")).toBeInTheDocument();
  });

  it("counts only invalidated findings, per RunStatus.invalidations being the full audit trail", () => {
    renderTable([
      makeRunStatus({
        invalidations: [makeFinding("exp-1", "invalidated"), makeFinding("exp-2", "valid")],
      }),
    ]);
    expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
  });
});
