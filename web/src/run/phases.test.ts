import { describe, expect, it } from "vitest";

import { derivePhases, deriveTeamProgress, PHASES } from "./phases";
import type { ActivityEvent } from "../api/types";
import { makeEvent, makeExperiment, makeRunStatus } from "../test/fixtures";

/** Builds a node-kind event trail from a list of node names, seq-ordered — a terser version of the
 * committed demo recording's own sequence (data_team -> modeling_team -> ... -> red_team ->
 * data_team -> modeling_team -> ... again), which is the real case the ladder must not regress on. */
function trail(nodes: readonly string[]): ActivityEvent[] {
  return nodes.map((node, i) => makeEvent(i, { node }));
}

const stateOf = (events: readonly ActivityEvent[], status = makeRunStatus()) =>
  Object.fromEntries(derivePhases(events, status).map((p) => [p.id, p.state]));

describe("derivePhases", () => {
  it("is entirely pending before the first node event", () => {
    expect(stateOf([])).toEqual({ data: "pending", modeling: "pending", running: "pending", audit: "pending", report: "pending" });
  });

  it("marks the current phase active and leaves the rest pending", () => {
    expect(stateOf(trail(["principal", "data_team"]))).toMatchObject({ data: "active", modeling: "pending" });
  });

  it("marks earlier phases done once a later one is reached", () => {
    expect(stateOf(trail(["principal", "data_team", "principal", "modeling_team"]))).toMatchObject({
      data: "done",
      modeling: "active",
      running: "pending",
    });
  });

  it("never regresses when the graph loops back to an earlier team (the real demo's shape)", () => {
    const events = trail([
      "principal", "data_team", "principal", "modeling_team", "principal",
      "experiment_runner", "principal", "red_team",
      // red team routes back for remediation — the ladder must not walk backwards
      "principal", "data_team", "principal", "modeling_team", "principal", "experiment_runner",
    ]);
    expect(stateOf(events)).toEqual({
      data: "done",
      modeling: "done",
      running: "done",
      audit: "active",
      report: "pending",
    });
  });

  it("advances to report once reporter is reached", () => {
    const events = trail(["data_team", "modeling_team", "experiment_runner", "red_team", "reporter"]);
    expect(stateOf(events)).toMatchObject({ audit: "done", report: "active" });
  });

  it("does not move the ladder for nodes with no phase of their own (principal, final_gate, lesson_writer)", () => {
    const events = trail(["data_team", "modeling_team", "experiment_runner", "red_team", "reporter", "final_gate", "lesson_writer"]);
    expect(stateOf(events)).toMatchObject({ report: "active" });
  });

  it("ignores non-node events (interrupt/done/error carry no node)", () => {
    const events: ActivityEvent[] = [
      makeEvent(0, { node: "data_team" }),
      makeEvent(1, { kind: "interrupt", node: null }),
    ];
    expect(stateOf(events)).toMatchObject({ data: "active" });
  });

  it("collapses the active phase to done once the run is completed or failed, so nothing spins forever", () => {
    const events = trail(["data_team", "modeling_team", "experiment_runner"]);
    expect(stateOf(events, makeRunStatus({ status: "completed" }))).toMatchObject({ running: "done" });
    expect(stateOf(events, makeRunStatus({ status: "failed" }))).toMatchObject({ running: "done" });
  });

  it("covers exactly the five design-plan phases, in order", () => {
    expect(PHASES.map((p) => p.id)).toEqual(["data", "modeling", "running", "audit", "report"]);
  });
});

describe("deriveTeamProgress", () => {
  it("includes principal, which the phase ladder has no rung for", () => {
    const progress = deriveTeamProgress(trail(["principal"]), makeRunStatus());
    expect(progress.principal.state).toBe("active");
  });

  it("marks the most recent node's team active and every other seen team done", () => {
    const events = trail(["principal", "data_team", "principal", "modeling_team"]);
    const progress = deriveTeamProgress(events, makeRunStatus());
    expect(progress.modeling_team.state).toBe("active");
    expect(progress.data_team.state).toBe("done");
    expect(progress.principal.state).toBe("done");
    expect(progress.red_team.state).toBe("pending");
  });

  it("differs from the ladder on a loop-back: the roster tracks who acted MOST RECENTLY, not the high-water mark", () => {
    const events = trail(["red_team", "principal", "data_team"]);
    const progress = deriveTeamProgress(events, makeRunStatus());
    expect(progress.data_team.state).toBe("active");
    expect(progress.red_team.state).toBe("done"); // seen, but not the most recent
  });

  it("carries the finished-experiment count on the runner row only", () => {
    const status = makeRunStatus({ experiments: [makeExperiment("exp-001"), makeExperiment("exp-002")] });
    const progress = deriveTeamProgress(trail(["experiment_runner"]), status);
    expect(progress.experiment_runner.count).toBe(2);
    expect(progress.principal.count).toBeUndefined();
  });

  it("reports zero experiments rather than undefined when none have finished yet", () => {
    const progress = deriveTeamProgress([], makeRunStatus());
    expect(progress.experiment_runner.count).toBe(0);
  });

  it("marks the last-acting team done, not active, once the run is over", () => {
    const progress = deriveTeamProgress(trail(["reporter"]), makeRunStatus({ status: "completed" }));
    expect(progress.reporter.state).toBe("done");
  });
});
