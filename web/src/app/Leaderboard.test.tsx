import { render, screen, within } from "@testing-library/react";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Leaderboard } from "./Leaderboard";
import type { LeaderboardEntry } from "../api/types";
import { makeRunStatus } from "../test/fixtures";

const entry = (rank: number, id: string, value = 0.9): LeaderboardEntry => ({
  experiment_id: id,
  mlflow_run_id: `mlflow-${id}`,
  primary_metric_name: "roc_auc",
  primary_metric_value: value,
  rank,
});

describe("Leaderboard", () => {
  it("names the next thing that happens when there is nothing to rank yet", () => {
    render(<Leaderboard status={makeRunStatus()} />);
    expect(screen.getByText("No ranked experiments yet")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("also treats a null status (before the first RunStatus arrives) as empty", () => {
    render(<Leaderboard status={null} />);
    expect(screen.getByText("No ranked experiments yet")).toBeInTheDocument();
  });

  it("renders entries in rank order with no team colour anywhere", () => {
    const status = makeRunStatus({ leaderboard: [entry(2, "exp-002"), entry(1, "exp-001")] });
    render(<Leaderboard status={status} />);
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("exp-001"),
      expect.stringContaining("exp-002"),
    ]);
    expect(document.querySelector('[class*="team-"]')).toBeNull();
  });

  it("shows the shared metric name once, in the panel header, not per row", () => {
    const status = makeRunStatus({ leaderboard: [entry(1, "exp-001")] });
    render(<Leaderboard status={status} />);
    expect(screen.getByText("roc_auc")).toBeInTheDocument();
  });

  it("tints the left edge of a row whose rank just improved, and only that row", () => {
    vi.useFakeTimers();
    const status1 = makeRunStatus({ leaderboard: [entry(1, "exp-001"), entry(2, "exp-002")] });
    const { rerender } = render(<Leaderboard status={status1} />);

    const status2 = makeRunStatus({ leaderboard: [entry(1, "exp-002"), entry(2, "exp-001")] });
    act(() => rerender(<Leaderboard status={status2} />));

    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    const gainedRow = rows.find((r) => r.textContent?.includes("exp-002"));
    const otherRow = rows.find((r) => r.textContent?.includes("exp-001"));
    expect(gainedRow?.querySelector(".bg-status-info")).not.toBeNull();
    expect(otherRow?.querySelector(".bg-status-info")).toBeNull();

    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByText("exp-002").closest("li")?.querySelector(".bg-status-info")).toBeNull();
    vi.useRealTimers();
  });

  it("does not tint anything on first render — nothing has \"moved\" yet", () => {
    const status = makeRunStatus({ leaderboard: [entry(1, "exp-001")] });
    render(<Leaderboard status={status} />);
    expect(document.querySelector(".bg-status-info")).toBeNull();
  });
});
