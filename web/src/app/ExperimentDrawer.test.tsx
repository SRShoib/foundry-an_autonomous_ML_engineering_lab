import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeExperiment } from "../test/fixtures";
import { ExperimentDrawer } from "./ExperimentDrawer";

describe("ExperimentDrawer", () => {
  it("shows the header's metric, duration, cost and attempt count", () => {
    const experiment = makeExperiment("exp-003", { duration_s: 12.3, cost_usd: 0.912, attempts: 2 });
    render(<ExperimentDrawer experiment={experiment} primaryMetricName="roc_auc" onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "exp-003" })).toBeInTheDocument();
    expect(screen.getByText("roc_auc 0.9000")).toBeInTheDocument();
    expect(screen.getByText("12.3s")).toBeInTheDocument();
    expect(screen.getByText("$0.9120")).toBeInTheDocument();
    expect(screen.getByText("2 attempts")).toBeInTheDocument();
  });

  it("links to MLflow only when a run id exists", () => {
    const withRun = makeExperiment("exp-001", { mlflow_run_id: "run-42" });
    const { rerender } = render(<ExperimentDrawer experiment={withRun} onClose={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open in MLflow" })).toHaveAttribute(
      "href",
      "http://localhost:5000/#/experiments/0/runs/run-42",
    );

    rerender(<ExperimentDrawer experiment={makeExperiment("exp-002", { mlflow_run_id: null })} onClose={vi.fn()} />);
    expect(screen.queryByRole("link", { name: "Open in MLflow" })).not.toBeInTheDocument();
  });

  it("the spec tab shows hyperparameters and estimated vs actual cost", async () => {
    const experiment = makeExperiment("exp-001", {
      cost_usd: 0.5,
      spec: {
        experiment_id: "exp-001",
        model_family: "lightgbm",
        hyperparams: { max_depth: 6, learning_rate: 0.1 },
        rationale: "a reasonable default",
        est_cost_usd: 0.4,
      },
    });
    render(<ExperimentDrawer experiment={experiment} onClose={vi.fn()} />);
    expect(screen.getByText("lightgbm")).toBeInTheDocument();
    expect(screen.getByText("max_depth")).toBeInTheDocument();
    expect(screen.getByText("a reasonable default")).toBeInTheDocument();
    expect(screen.getByText("$0.4000 → $0.5000")).toBeInTheDocument();
  });

  it("the spec tab names what's missing on a pre-M9d checkpoint", () => {
    render(<ExperimentDrawer experiment={makeExperiment("exp-001", { spec: null })} onClose={vi.fn()} />);
    expect(screen.getByText(/No spec recorded/)).toBeInTheDocument();
  });

  it("switches to the code, output and attempts tabs", async () => {
    const experiment = makeExperiment("exp-001", {
      code: "print('training')",
      stdout: "loss: 0.1",
      stderr: "warn: deprecated",
      attempt_history: [
        { attempt: 0, outcome: "failed_execution", code: "bad code", stdout: "", stderr: "boom", error: "boom" },
        { attempt: 1, outcome: "success", code: "good code", stdout: "ok", stderr: "", error: null },
      ],
    });
    render(<ExperimentDrawer experiment={experiment} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("tab", { name: "code" }));
    expect(screen.getByText("print('training')")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "output" }));
    expect(screen.getByText("loss: 0.1")).toBeInTheDocument();
    expect(screen.getByText("warn: deprecated")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "attempts" }));
    expect(screen.getByText(/attempt 1/).closest("p")).toHaveTextContent("attempt 1 — failed execution");
    expect(screen.getByText(/attempt 2/).closest("p")).toHaveTextContent("attempt 2 — succeeded");
    expect(screen.getByText("bad code")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("the attempts tab names what's missing on a pre-M9d checkpoint", async () => {
    render(<ExperimentDrawer experiment={makeExperiment("exp-001", { attempt_history: [] })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "attempts" }));
    expect(screen.getByText(/No per-attempt history recorded/)).toBeInTheDocument();
  });

  it("closes on Escape and on the Close button", async () => {
    const onClose = vi.fn();
    render(<ExperimentDrawer experiment={makeExperiment("exp-001")} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
