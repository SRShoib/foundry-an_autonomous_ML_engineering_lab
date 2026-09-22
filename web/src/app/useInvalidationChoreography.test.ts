import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeFinding } from "../test/fixtures";

// Same isolation as lib/useAnimatedNumber.test.ts: Motion's real useReducedMotion caches its
// answer in a module singleton, awkward to flip between tests, so it is mocked here instead.
const reducedMotion = vi.hoisted(() => ({ value: false as boolean }));
vi.mock("motion/react", () => ({
  useReducedMotion: () => reducedMotion.value,
}));

const { useInvalidationChoreography } = await import("./useInvalidationChoreography");

beforeEach(() => {
  reducedMotion.value = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useInvalidationChoreography", () => {
  it("starts idle with no findings", () => {
    const { result } = renderHook(({ findings }) => useInvalidationChoreography(findings), {
      initialProps: { findings: [] as ReturnType<typeof makeFinding>[] },
    });
    expect(result.current).toEqual({ phase: "idle", finding: null });
  });

  it("does not animate invalidations already present on the FIRST render", () => {
    const findings = [makeFinding("exp-1", "invalidated")];
    const { result } = renderHook(({ f }) => useInvalidationChoreography(f), { initialProps: { f: findings } });
    expect(result.current.phase).toBe("idle");
  });

  it("walks flag → demote → connect → finding at the 200/520/900ms boundaries for a NEW invalidation", () => {
    const { result, rerender } = renderHook(({ f }) => useInvalidationChoreography(f), {
      initialProps: { f: [] as ReturnType<typeof makeFinding>[] },
    });

    const finding = makeFinding("exp-1", "invalidated");
    act(() => rerender({ f: [finding] }));
    expect(result.current).toEqual({ phase: "flag", finding });

    tick(200);
    expect(result.current).toEqual({ phase: "demote", finding });

    tick(320); // 200 + 320 = 520
    expect(result.current).toEqual({ phase: "connect", finding });

    tick(380); // 520 + 380 = 900
    expect(result.current).toEqual({ phase: "finding", finding });

    // "finding" is the resting state — nothing further fires at the table's 1400ms mark.
    tick(500);
    expect(result.current).toEqual({ phase: "finding", finding });
  });

  it("reduced motion collapses straight to \"finding\", the connector drawn statically", () => {
    reducedMotion.value = true;
    const { result, rerender } = renderHook(({ f }) => useInvalidationChoreography(f), {
      initialProps: { f: [] as ReturnType<typeof makeFinding>[] },
    });
    const finding = makeFinding("exp-1", "invalidated");
    act(() => rerender({ f: [finding] }));
    expect(result.current).toEqual({ phase: "finding", finding });
  });

  it("an UNRELATED RunStatus update (a new array, same invalidated ids) does not cancel the in-flight sequence", () => {
    // Regression: a live run's RunStatus is a fresh object on every poll/SSE frame even when
    // invalidations themselves haven't changed (spent_usd ticking up, say) — the effect must key
    // off the SET of invalidated ids, not array identity, or every one of those unrelated updates
    // tears down the in-flight timers via cleanup and freezes the sequence wherever it was.
    const { result, rerender } = renderHook(({ f }) => useInvalidationChoreography(f), {
      initialProps: { f: [] as ReturnType<typeof makeFinding>[] },
    });
    const finding = makeFinding("exp-1", "invalidated");
    act(() => rerender({ f: [finding] }));
    expect(result.current.phase).toBe("flag");

    // A brand-new array, but the SAME content — simulates an unrelated status update arriving
    // mid-sequence.
    act(() => rerender({ f: [{ ...finding }] }));
    tick(900); // past connect, into finding — would still be stuck at "flag" before the fix
    expect(result.current.phase).toBe("finding");
  });

  it("a second, unrelated invalidation starts its own sequence", () => {
    const first = makeFinding("exp-1", "invalidated");
    const { result, rerender } = renderHook(({ f }) => useInvalidationChoreography(f), {
      initialProps: { f: [first] as ReturnType<typeof makeFinding>[] },
    });
    expect(result.current.phase).toBe("idle"); // first one was present on mount

    const second = makeFinding("exp-2", "invalidated");
    act(() => rerender({ f: [first, second] }));
    expect(result.current).toEqual({ phase: "flag", finding: second });
  });
});
