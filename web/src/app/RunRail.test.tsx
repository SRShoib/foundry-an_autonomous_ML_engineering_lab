import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CostByTeam, PhaseLadder, RunRail, TeamRoster } from "./RunRail";
import { makeEvent, makeExperiment, makeRunStatus } from "../test/fixtures";

describe("RunRail", () => {
  it("shows the goal when the source knows it, and nothing when it does not", () => {
    const { rerender } = render(<RunRail goal="predict churn" events={[]} status={null} />);
    expect(screen.getByText("goal")).toBeInTheDocument();
    expect(screen.getByText("predict churn")).toBeInTheDocument();

    rerender(<RunRail events={[]} status={null} />);
    expect(screen.queryByText("goal")).not.toBeInTheDocument();
  });

  it("renders the phase ladder, team roster and cost sections together", () => {
    render(<RunRail events={[]} status={makeRunStatus()} />);
    expect(screen.getByText("phase")).toBeInTheDocument();
    expect(screen.getByText("teams")).toBeInTheDocument();
    expect(screen.getByText("cost by team")).toBeInTheDocument();
  });
});

describe("PhaseLadder", () => {
  it("lists all five phases with a visible label and an sr-only state word each", () => {
    render(<PhaseLadder events={[makeEvent(0, { node: "data_team" })]} status={makeRunStatus()} />);
    for (const label of ["data", "modeling", "running", "audit", "report"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    const active = screen.getByText("data").closest("li");
    expect(active).not.toBeNull();
    expect(within(active as HTMLElement).getByText("active")).toHaveClass("sr-only");
  });
});

describe("TeamRoster", () => {
  it("lists all six teams, including principal, which the ladder has no rung for", () => {
    render(<TeamRoster events={[makeEvent(0, { node: "principal" })]} status={makeRunStatus()} />);
    for (const label of ["principal", "data", "modeling", "runner", "red team", "reporter"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows the finished-experiment count only on the runner row", () => {
    const status = makeRunStatus({ experiments: [makeExperiment("exp-001"), makeExperiment("exp-002")] });
    render(<TeamRoster events={[makeEvent(0, { node: "experiment_runner" })]} status={status} />);
    const runnerRow = screen.getByText("runner").closest("li");
    expect(within(runnerRow as HTMLElement).getByText("2")).toBeInTheDocument();
  });
});

describe("CostByTeam", () => {
  it("shows all four roles to four decimal places, zero-filled if unspent", () => {
    render(<CostByTeam costByAgent={{ principal: 0.07 }} />);
    expect(screen.getByText("$0.0700")).toBeInTheDocument();
    expect(screen.getByText("workers")).toBeInTheDocument();
    expect(screen.getAllByText("$0.0000")).toHaveLength(3); // worker, red team, sandbox unspent
  });
});
