import { describe, expect, it } from "vitest";

import { foldFrames } from "./fold";
import type { ReplayFrame, RunStatus } from "../api/types";
import { loadDemoReplay } from "../test/demoReplay";
import { makeEvent, makeExperiment, makeFinding, makeRunStatus } from "../test/fixtures";

const frame = (status: RunStatus, seq: number): ReplayFrame => ({
  t_offset_s: seq,
  event: makeEvent(seq),
  status,
});

describe("foldFrames against the committed demo recording", () => {
  const demo = loadDemoReplay();
  const folded = foldFrames(demo.frames);

  it("reproduces header.final_status exactly — the cross-language conformance anchor", () => {
    // tests/test_demo_replay.py asserts the same equality with the Python fold on the same file.
    // If the two implementations ever disagree, one of these two tests fails on the real artifact.
    expect(demo.header.final_status).not.toBeNull();
    expect(folded.at(-1)).toEqual(demo.header.final_status);
  });

  it("yields one complete status per frame", () => {
    expect(folded).toHaveLength(demo.frames.length);
  });

  it("only ever grows the append-only channels and never returns a written field to empty", () => {
    let experiments = 0;
    let invalidations = 0;
    let sawReport = false;
    let sawProfile = false;
    for (const status of folded) {
      expect(status.experiments.length).toBeGreaterThanOrEqual(experiments);
      expect(status.invalidations.length).toBeGreaterThanOrEqual(invalidations);
      experiments = status.experiments.length;
      invalidations = status.invalidations.length;
      if (sawReport) expect(status.report_md).not.toBeNull();
      if (sawProfile) expect(status.data_profile).not.toBeNull();
      sawReport ||= status.report_md !== null;
      sawProfile ||= status.data_profile !== null;
    }
    expect(sawReport && sawProfile).toBe(true);
  });

  it("puts the leak in the frame where the red team found it, not one step later", () => {
    const firstAudit = demo.frames.findIndex((f) => f.event.node === "red_team");
    const before = folded[firstAudit - 1];
    const at = folded[firstAudit];
    expect(before?.invalidations).toEqual([]);
    expect(at?.invalidations.some((f) => f.verdict === "invalidated")).toBe(true);
  });

  it("recovers the agent-written code and MLflow ids from carried-forward experiments", () => {
    for (const experiment of folded.at(-1)?.experiments ?? []) {
      expect(experiment.code.length).toBeGreaterThan(0);
      expect(experiment.mlflow_run_id).toBeTruthy();
    }
  });
});

describe("foldFrames on a synthetic run", () => {
  it("carries an unchanged field forward and replaces a changed one", () => {
    const a = makeExperiment("exp-1");
    const b = makeExperiment("exp-2");
    const folded = foldFrames([
      frame(makeRunStatus(), 0),
      frame(makeRunStatus({ experiments: [a], report_md: "draft" }), 1),
      frame(makeRunStatus({ spent_usd: 0.5 }), 2), // everything carried forward
      frame(makeRunStatus({ experiments: [a, b] }), 3), // list grew
      frame(makeRunStatus({ report_md: "draft\n\nsigned" }), 4), // report extended
    ]);

    expect(folded.map((s) => s.experiments.length)).toEqual([0, 1, 1, 2, 2]);
    expect(folded.map((s) => s.report_md)).toEqual([
      null,
      "draft",
      "draft",
      "draft",
      "draft\n\nsigned",
    ]);
    expect(folded[2]?.spent_usd).toBe(0.5); // non-carry-forward fields stay per frame
  });

  it("carries the audit trail and the write-once fields", () => {
    const folded = foldFrames([
      frame(makeRunStatus({ invalidations: [makeFinding("exp-1")], model_card_md: "card" }), 0),
      frame(makeRunStatus(), 1),
    ]);
    expect(folded[1]?.invalidations).toHaveLength(1);
    expect(folded[1]?.model_card_md).toBe("card");
  });

  it("leaves a genuinely empty first frame empty", () => {
    const [first] = foldFrames([frame(makeRunStatus(), 0)]);
    expect(first).toMatchObject({
      experiments: [],
      invalidations: [],
      report_md: null,
      model_card_md: null,
      data_profile: null,
    });
  });

  it("does not mutate its input", () => {
    const input = [frame(makeRunStatus({ report_md: "r" }), 0), frame(makeRunStatus(), 1)];
    const snapshot = structuredClone(input);
    foldFrames(input);
    expect(input).toEqual(snapshot);
  });
});
