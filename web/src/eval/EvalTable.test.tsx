import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeTaskResult } from "../test/fixtures";
import { EvalTable } from "./EvalTable";

describe("EvalTable", () => {
  it("shows only the full config, mirroring render_per_task_table's own filter", () => {
    render(
      <EvalTable
        results={[
          makeTaskResult({ dataset_ref: "churn", config: "full" }),
          makeTaskResult({ dataset_ref: "churn", config: "no_red_team" }),
        ]}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + one data row
  });

  it("renders each task's metric, target, cost, wall time and invalidated count", () => {
    render(
      <EvalTable
        results={[
          makeTaskResult({
            dataset_ref: "churn", config: "full", primary_metric_value: 0.8519, target_value: 0.9,
            target_met: false, cost_total_usd: 0.18, wall_time_s: 287.1, n_invalidated: 2,
            stop_reason: "diminishing_returns",
          }),
        ]}
      />,
    );
    expect(screen.getByRole("cell", { name: "churn" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "0.8519" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "no" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "$0.18" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "287.1s" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "2" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "diminishing_returns" })).toBeInTheDocument();
  });
});
