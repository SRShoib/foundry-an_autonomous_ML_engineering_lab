import { describe, expect, it } from "vitest";

import { findGateGroups } from "./gates";
import type { ReplayFrame } from "../api/types";
import { loadDemoReplay } from "../test/demoReplay";
import { makeEvent, makeGate, makeRunStatus } from "../test/fixtures";

const frame = (seq: number, gate: "budget" | "final" | null): ReplayFrame => ({
  t_offset_s: seq,
  event: makeEvent(seq),
  status: makeRunStatus({ pending_approval: gate ? makeGate({ gate }) : null }),
});

describe("findGateGroups", () => {
  it("groups the interrupt and done frames of one pause into a single gate", () => {
    const groups = findGateGroups([
      frame(0, null),
      frame(1, "budget"),
      frame(2, "budget"),
      frame(3, null),
      frame(4, "final"),
      frame(5, "final"),
    ]);
    expect(groups).toEqual([
      { start: 1, end: 2, gate: "budget" },
      { start: 4, end: 5, gate: "final" },
    ]);
  });

  it("finds nothing in a run that never paused", () => {
    expect(findGateGroups([frame(0, null), frame(1, null)])).toEqual([]);
  });

  it("finds exactly the budget gate then the final gate in the committed demo", () => {
    const demo = loadDemoReplay();
    const groups = findGateGroups(demo.frames);
    expect(groups.map((g) => g.gate)).toEqual(["budget", "final"]);
    // and they line up one-to-one with what the recording operator decided
    expect(groups.map((g) => g.gate)).toEqual(demo.header.decisions.map((d) => d.gate));
    for (const group of groups) {
      // The interrupt event and the done event are appended a millisecond apart (the recorded
      // demo has them at 1.552s and 1.553s), so a group is one pause, not a stretch of time.
      const times = demo.frames.slice(group.start, group.end + 1).map((f) => f.t_offset_s);
      expect(Math.max(...times) - Math.min(...times)).toBeLessThan(0.05);
    }
  });
});
