import { describe, expect, it, vi } from "vitest";

import { createReplayRunSource } from "./replayRunSource";
import type { RunSource } from "./RunSource";
import { foldFrames } from "../replay/fold";
import { FakeClock } from "../test/fakeClock";
import { loadDemoReplay } from "../test/demoReplay";
import { makeExperiment, makeReplay, type FrameSpec } from "../test/fixtures";

function setup(specs: readonly FrameSpec[], decisions: Parameters<typeof makeReplay>[1] = []) {
  const clock = new FakeClock();
  const source = createReplayRunSource(makeReplay(specs, decisions), clock);
  return { clock, source, state: () => source.getSnapshot() };
}

/** 0s, 1s, 2s, 3s — no gates. */
const STEADY: FrameSpec[] = [{ t: 0 }, { t: 1 }, { t: 2 }, { t: 3 }];

/** A budget gate at 1s and a final gate at 3s, each followed by a frame a few ms later. */
const GATED: FrameSpec[] = [
  { t: 0 },
  { t: 1, kind: "interrupt", gate: "budget" },
  { t: 1.001, kind: "done", gate: "budget" },
  { t: 1.004 },
  { t: 2 },
  { t: 3, kind: "interrupt", gate: "final" },
  { t: 3.001, kind: "done", gate: "final" },
  { t: 3.004 },
];

describe("timing", () => {
  it("applies frames at their recorded offsets at 1x", () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    clock.advance(0); // the t=0 frame is due at once, but arrives on the first timer tick
    expect(state().events).toHaveLength(1);

    clock.advance(900);
    expect(state().events).toHaveLength(1);
    clock.advance(100);
    expect(state().events).toHaveLength(2);
    clock.advance(1000);
    expect(state().events).toHaveLength(3);
  });

  it.each([
    [1, 3000],
    [4, 750],
    [16, 187.5],
  ] as const)("finishes a 3s run in the right wall time at %dx", (speed, wallMs) => {
    const { clock, source, state } = setup(STEADY);
    source.setSpeed(speed);
    source.start();

    clock.advance(wallMs - 1);
    expect(state().connection).toBe("open");
    clock.advance(2);
    expect(state().connection).toBe("closed");
    expect(state().events).toHaveLength(4);
  });

  it("applies every frame that falls due in one tick as a single state change", () => {
    // A stalled main thread lets a timer fire late, so a burst of frames is due all at once. They
    // must land as ONE update: a stream of separate updates would defeat the feed's batching.
    const burst = Array.from({ length: 10 }, (_, i) => ({ t: 1 + i * 0.001 }));
    const { clock, source, state } = setup([{ t: 0 }, ...burst]);
    source.start();
    clock.advance(0);
    const listener = vi.fn();
    source.subscribe(listener);

    clock.jump(1100);
    expect(state().events).toHaveLength(11);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not drift: elapsed comes from the clock, not from summing timer intervals", () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    // many tiny advances, none landing exactly on a frame boundary
    for (let i = 0; i < 300; i++) clock.advance(10);
    expect(state().events).toHaveLength(4);
    expect(state().transport?.elapsedS).toBeCloseTo(3, 5);
  });

  it("changing speed mid-playback rebases the clock instead of jumping", () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    clock.advance(1500); // elapsed 1.5s, 2 frames applied
    expect(state().events).toHaveLength(2);

    source.setSpeed(4);
    expect(state().transport?.elapsedS).toBeCloseTo(1.5, 5);
    clock.advance(125); // 0.5s of replay time at 4x → reaches t=2
    expect(state().events).toHaveLength(3);
  });

  it("pause freezes the clock and play continues from the same point", () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    clock.advance(1500);
    source.pause();
    expect(state().transport?.playing).toBe(false);
    expect(clock.pendingTimers).toBe(0);

    clock.advance(60_000);
    expect(state().events).toHaveLength(2); // nothing moved while paused
    expect(state().transport?.elapsedS).toBeCloseTo(1.5, 5);

    source.play();
    clock.advance(500);
    expect(state().events).toHaveLength(3);
  });

  it("restarts from the top when play is pressed at the end", () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    clock.advance(10_000);
    expect(state().connection).toBe("closed");

    source.play();
    clock.advance(0);
    expect(state().events).toHaveLength(1);
    expect(state().connection).toBe("open");
  });

  it("survives React StrictMode's start, stop, start without losing or repeating frames", () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    clock.advance(500);
    source.stop();
    source.start();
    clock.advance(500);
    expect(state().events).toHaveLength(2);
    expect(state().transport?.playing).toBe(true);
    expect(clock.pendingTimers).toBe(1);
  });

  it("does not resume playing on start() after an explicit pause", () => {
    const { source, state } = setup(STEADY);
    source.start();
    source.pause();
    source.stop();
    source.start();
    expect(state().transport?.playing).toBe(false);
  });
});

describe("gates", () => {
  it("stops at a gate, applies the whole group, and waits for the operator", () => {
    const { clock, source, state } = setup(GATED, [
      { gate: "budget", approved: true },
      { gate: "final", approved: true },
    ]);
    source.start();
    clock.advance(1500);

    expect(state().awaitingDecision).toBe(true);
    expect(state().transport?.playing).toBe(false);
    expect(state().status?.pending_approval?.gate).toBe("budget");
    // both frames of the pause, the interrupt and the done event, are on screen together
    expect(state().events.map((e) => e.kind)).toEqual(["node", "interrupt", "done"]);
    expect(clock.pendingTimers).toBe(0);

    clock.advance(60_000); // however long the operator deliberates, nothing moves
    expect(state().events).toHaveLength(3);
  });

  it("refuses to play through a gate: it is answered with resume(), not play", () => {
    const { clock, source, state } = setup(GATED);
    source.start();
    clock.advance(1500);
    source.play();
    expect(state().awaitingDecision).toBe(true);
    expect(state().transport?.playing).toBe(false);
  });

  it("carries on after resume, showing the honest minimum until the next frame lands", async () => {
    const { clock, source, state } = setup(GATED, [{ gate: "budget", approved: true }]);
    source.start();
    clock.advance(1500);

    await source.resume({ approved: true, note: "" });
    expect(state().awaitingDecision).toBe(false);
    expect(state().status).toMatchObject({ status: "running", pending_approval: null });
    expect(state().transport?.playing).toBe(true);

    clock.advance(10); // the recorded frame just after the gate lands
    expect(state().events).toHaveLength(4);
    expect(state().status?.pending_approval).toBeNull();
  });

  it("runs through both gates to the end", async () => {
    const { clock, source, state } = setup(GATED, [
      { gate: "budget", approved: true },
      { gate: "final", approved: true },
    ]);
    source.start();
    clock.advance(1500);
    await source.resume({ approved: true, note: "" });
    clock.advance(5000);
    expect(state().status?.pending_approval?.gate).toBe("final");
    expect(state().awaitingDecision).toBe(true);

    await source.resume({ approved: true, note: "" });
    clock.advance(100);
    expect(state().connection).toBe("closed");
    expect(state().events).toHaveLength(GATED.length);
    expect(state().divergence).toBeNull();
  });

  it("flags a divergence when the operator rejects what the recording approved", async () => {
    const { clock, source, state } = setup(GATED, [{ gate: "budget", approved: true }]);
    source.start();
    clock.advance(1500);
    await source.resume({ approved: false, note: "too expensive" });

    expect(state().divergence).toEqual({
      seq: 2,
      gate: "budget",
      recordedApproved: true,
      operatorApproved: false,
    });
    // ...and it carries on down the only future that exists
    clock.advance(10);
    expect(state().events).toHaveLength(4);
  });

  it("does not flag a divergence when the operator agrees with the recording", async () => {
    const { clock, source, state } = setup(GATED, [{ gate: "budget", approved: false }]);
    source.start();
    clock.advance(1500);
    await source.resume({ approved: false, note: "" });
    expect(state().divergence).toBeNull();
  });

  it("ignores resume() when there is no gate to answer", async () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    clock.advance(500);
    await source.resume({ approved: true, note: "" });
    expect(state().events).toHaveLength(1);
    expect(state().transport?.playing).toBe(true);
  });
});

describe("seek", () => {
  it("jumps to a point in the run and keeps playing from there", () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    source.seek(2 / 3); // 2s of a 3s run
    expect(state().events).toHaveLength(3);
    clock.advance(1000);
    expect(state().events).toHaveLength(4);
  });

  it("stays paused if it was paused", () => {
    const { clock, source, state } = setup(STEADY);
    source.start();
    source.pause();
    source.seek(1);
    expect(state().events).toHaveLength(4);
    clock.advance(10_000);
    expect(state().transport?.playing).toBe(false);
  });

  it("lands AT a gate when seeking to it, so the gate can be jumped to and answered", async () => {
    const { source, state } = setup(GATED, [{ gate: "budget", approved: true }]);
    source.start();
    source.seek(1 / 3.004);
    expect(state().awaitingDecision).toBe(true);
    expect(state().status?.pending_approval?.gate).toBe("budget");
    await source.resume({ approved: true, note: "" });
    expect(state().awaitingDecision).toBe(false);
  });

  it("treats a gate the run has carried on beyond as already answered", () => {
    const { clock, source, state } = setup(GATED, [
      { gate: "budget", approved: true },
      { gate: "final", approved: true },
    ]);
    source.start();
    source.seek(2 / 3.004); // past the budget gate, before the final one
    expect(state().awaitingDecision).toBe(false);

    clock.advance(2000); // plays on and stops at the FINAL gate, not the budget gate again
    expect(state().status?.pending_approval?.gate).toBe("final");
  });

  it("seeking backwards to before a gate makes it stop again", () => {
    const { clock, source, state } = setup(GATED);
    source.start();
    source.seek(1); // to the very end
    expect(state().connection).toBe("closed");
    source.seek(0.1);
    expect(state().awaitingDecision).toBe(false);
    source.play();
    clock.advance(2000);
    expect(state().status?.pending_approval?.gate).toBe("budget");
  });

  it("clamps out-of-range fractions", () => {
    const { source, state } = setup(STEADY);
    source.start();
    source.seek(-3);
    expect(state().events).toHaveLength(1);
    source.seek(9);
    expect(state().events).toHaveLength(4);
  });
});

describe("state", () => {
  it("returns the same snapshot object until something changes (useSyncExternalStore's contract)", () => {
    const { clock, source } = setup(STEADY);
    source.start();
    const first = source.getSnapshot();
    expect(source.getSnapshot()).toBe(first);
    clock.advance(1000);
    expect(source.getSnapshot()).not.toBe(first);
  });

  it("keeps the events array stable across changes that add no event", () => {
    const { source, state } = setup(STEADY);
    source.start();
    const events = state().events;
    source.setSpeed(4);
    expect(state().events).toBe(events);
  });

  it("reports itself as a replay with a transport, and never an error", () => {
    const { source, state } = setup(STEADY);
    source.start();
    expect(state()).toMatchObject({ mode: "replay", error: null });
    expect(state().transport).toMatchObject({ speed: 1, durationS: 3 });
  });

  it("is idle, with no status, before start()", () => {
    const { state } = setup(STEADY);
    expect(state()).toMatchObject({ connection: "idle", status: null, events: [] });
  });

  it("copes with an empty recording", () => {
    const { source, state } = setup([]);
    source.start();
    expect(state().connection).toBe("closed");
    expect(state().status).toBeNull();
  });

  it("folds carry-forward fields, so the status is always complete", () => {
    const a = makeExperiment("exp-1");
    const { clock, source, state } = setup([
      { t: 0 },
      { t: 1, status: { experiments: [a] } },
      { t: 2, status: { spent_usd: 0.5 } }, // experiments blanked in the recording
    ]);
    source.start();
    clock.advance(2000);
    expect(state().status?.experiments).toEqual([a]);
    expect(state().status?.spent_usd).toBe(0.5);
  });
});

describe("the committed demo recording", () => {
  it("plays through both gates at 16x and lands exactly on the recorded final status", async () => {
    const demo = loadDemoReplay();
    const clock = new FakeClock();
    const source: RunSource = createReplayRunSource(demo, clock);
    source.setSpeed(16);
    source.start();

    const gates: string[] = [];
    for (let guard = 0; guard < 10 && source.getSnapshot().connection !== "closed"; guard++) {
      clock.advance(60_000);
      const gate = source.getSnapshot().status?.pending_approval?.gate;
      if (source.getSnapshot().awaitingDecision && gate) {
        gates.push(gate);
        await source.resume({ approved: true, note: "" });
      }
    }

    expect(gates).toEqual(["budget", "final"]);
    expect(source.getSnapshot().connection).toBe("closed");
    expect(source.getSnapshot().events).toHaveLength(demo.frames.length);
    expect(source.getSnapshot().status).toEqual(demo.header.final_status);
    expect(source.getSnapshot().divergence).toBeNull();
  });

  it("shows the leaderboard losing the leaked experiments at the red-team frame", () => {
    const demo = loadDemoReplay();
    const folded = foldFrames(demo.frames);
    const firstAudit = demo.frames.findIndex((f) => f.event.node === "red_team");
    const clock = new FakeClock();
    const source = createReplayRunSource(demo, clock);
    source.start();
    source.seek(demo.frames[firstAudit]!.t_offset_s / demo.header.duration_s);

    expect(source.getSnapshot().status?.invalidations).toEqual(folded[firstAudit]?.invalidations);
    expect(source.getSnapshot().status?.invalidations.some((f) => f.verdict === "invalidated")).toBe(true);
  });
});
