import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Framer Motion's real useReducedMotion caches its answer in a module-level singleton initialised
// once per process, which makes it awkward to flip between tests. Mocking it here keeps this file's
// two branches (motion on / motion off) independent and deterministic.
const reducedMotion = vi.hoisted(() => ({ value: false as boolean }));
vi.mock("motion/react", () => ({
  useReducedMotion: () => reducedMotion.value,
}));

const { useAnimatedNumber } = await import("./useAnimatedNumber");

beforeEach(() => {
  reducedMotion.value = false;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useAnimatedNumber", () => {
  it("shows the initial value immediately — there is nothing to count up from yet", () => {
    const { result } = renderHook(() => useAnimatedNumber(12.84));
    expect(result.current).toBe(12.84);
  });

  it("tweens toward a new value over 400ms and lands exactly on it", () => {
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v), { initialProps: { v: 0 } });
    rerender({ v: 100 });
    tick(200);
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(100);
    tick(400);
    expect(result.current).toBeCloseTo(100, 5);
  });

  it("keeps tweening toward the same target rather than resetting when nothing changed", () => {
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v), { initialProps: { v: 0 } });
    rerender({ v: 50 });
    tick(200);
    const mid = result.current;
    rerender({ v: 50 }); // identical value: React skips the effect, the tween just continues
    tick(100);
    expect(result.current).toBeGreaterThan(mid);
    expect(result.current).toBeLessThanOrEqual(50);
  });

  it("retargets mid-flight when the value changes again before finishing", () => {
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v), { initialProps: { v: 0 } });
    rerender({ v: 100 });
    tick(200);
    const mid = result.current;
    rerender({ v: 10 }); // spend drops back? never happens for a budget meter, but the hook must cope
    tick(600); // generous slack past the 400ms duration for fake rAF's own scheduling latency
    expect(result.current).toBeCloseTo(10, 5);
    expect(mid).toBeGreaterThan(10);
  });

  it("snaps straight to the target with no tween when reduced motion is on", () => {
    reducedMotion.value = true;
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v), { initialProps: { v: 0 } });
    rerender({ v: 42 });
    expect(result.current).toBe(42);
  });

  it("honours a custom duration", () => {
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v, 100), { initialProps: { v: 0 } });
    rerender({ v: 10 });
    tick(250); // slack past the 100ms duration, same reasoning as above
    expect(result.current).toBeCloseTo(10, 5);
  });
});
