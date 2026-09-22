import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeGate } from "../test/fixtures";
import { GateDialog } from "./GateDialog";

describe("GateDialog", () => {
  it("renders the budget gate's hero figure, meters and pending specs", () => {
    const gate = makeGate({
      spent_usd: 12.84,
      budget_usd: 20,
      projected_usd: 4.56,
      pending_specs: [
        { experiment_id: "exp-005", model_family: "lightgbm", projected_cost_usd: 2.1 },
        { experiment_id: "exp-006", model_family: "xgboost", projected_cost_usd: 2.46 },
      ],
    });
    render(<GateDialog gate={gate} onDecide={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "budget gate" })).toBeInTheDocument();
    expect(screen.getByText("$17.40")).toBeInTheDocument(); // spent + projected
    expect(screen.getByText("exp-005")).toBeInTheDocument();
    expect(screen.getByText("lightgbm")).toBeInTheDocument();
    expect(screen.getByText("$2.1000")).toBeInTheDocument();
  });

  it("renders the final gate's winning experiment and invalidated count", () => {
    const gate = makeGate({
      gate: "final",
      best_experiment_id: "exp-003",
      best_metric_name: "roc_auc",
      best_metric_value: 0.8814,
      n_invalidated: 2,
    });
    render(<GateDialog gate={gate} onDecide={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "final gate" })).toBeInTheDocument();
    expect(screen.getByText("exp-003")).toBeInTheDocument();
    expect(screen.getByText(/0.8814/)).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("the final gate with no cleared experiment says so instead of showing a blank hero", () => {
    const gate = makeGate({ gate: "final", best_experiment_id: null });
    render(<GateDialog gate={gate} onDecide={vi.fn()} />);
    expect(screen.getByText("No experiment cleared the audit.")).toBeInTheDocument();
  });

  it("Approve is disabled until the 400ms arm fills, then calls onDecide", () => {
    vi.useFakeTimers();
    const onDecide = vi.fn();
    render(<GateDialog gate={makeGate()} onDecide={onDecide} />);

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(onDecide).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith({ approved: true, note: "" });

    vi.useRealTimers();
  });

  it("Enter on the armed Approve button does not activate it — only click or Space do", async () => {
    vi.useFakeTimers();
    const onDecide = vi.fn();
    render(<GateDialog gate={makeGate()} onDecide={onDecide} />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).not.toBeDisabled();
    approve.focus();
    await userEvent.keyboard("{Enter}");
    expect(onDecide).not.toHaveBeenCalled();

    await userEvent.keyboard(" ");
    expect(onDecide).toHaveBeenCalledWith({ approved: true, note: "" });
  });

  it("Reject requires a non-empty note", async () => {
    const onDecide = vi.fn();
    render(<GateDialog gate={makeGate()} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByText("A rejection needs a note.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("note"), "not ready");
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onDecide).toHaveBeenCalledWith({ approved: false, note: "not ready" });
  });

  it("is not dismissible: Escape does nothing", async () => {
    const onDecide = vi.fn();
    render(<GateDialog gate={makeGate()} onDecide={onDecide} />);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("focus moves to the heading on open", () => {
    render(<GateDialog gate={makeGate()} onDecide={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "budget gate" })).toHaveFocus();
  });
});
