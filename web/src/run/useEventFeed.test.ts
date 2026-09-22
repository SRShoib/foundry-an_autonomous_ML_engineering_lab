import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEventFeed } from "./useEventFeed";
import type { ActivityEvent } from "../api/types";
import { makeEvent } from "../test/fixtures";

const events = (n: number): ActivityEvent[] => Array.from({ length: n }, (_, i) => makeEvent(i));

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useEventFeed", () => {
  it("shows nothing until the first flush, then everything that had arrived", () => {
    const { result } = renderHook(() => useEventFeed(events(5)));
    expect(result.current.visible).toHaveLength(0);
    tick(16);
    expect(result.current.visible).toHaveLength(5);
    expect(result.current.batchSize).toBe(5);
  });

  it("holds new events back until 100ms after the last flush, then releases them as one batch", () => {
    const { result, rerender } = renderHook(({ list }) => useEventFeed(list), {
      initialProps: { list: events(2) },
    });
    tick(16);
    expect(result.current.visible).toHaveLength(2);

    rerender({ list: events(5) });
    tick(48); // 64ms in: inside the 100ms window
    expect(result.current.visible).toHaveLength(2);

    rerender({ list: events(9) }); // more arrive before the window closes
    tick(64); // now past 100ms
    expect(result.current.visible).toHaveLength(9);
    expect(result.current.batchSize).toBe(7); // both arrivals landed in ONE render
  });

  it("renders once per flush however many events arrive in between", () => {
    let renders = 0;
    const { rerender } = renderHook(
      ({ list }) => {
        renders += 1;
        return useEventFeed(list);
      },
      { initialProps: { list: events(1) } },
    );
    tick(16);
    const before = renders;

    for (let n = 2; n <= 40; n++) rerender({ list: events(n) }); // 39 arrivals, back to back
    const afterArrivals = renders;
    tick(200);
    expect(renders - afterArrivals).toBeLessThanOrEqual(1); // one flush, one render
    expect(before).toBeGreaterThan(0);
  });

  it("reports the batch size so the feed can skip the stagger above 6", () => {
    const { result, rerender } = renderHook(({ list }) => useEventFeed(list), {
      initialProps: { list: events(1) },
    });
    tick(16);
    rerender({ list: events(4) });
    tick(120);
    expect(result.current.batchSize).toBe(3);
    rerender({ list: events(30) });
    tick(120);
    expect(result.current.batchSize).toBe(26);
  });

  it("snaps back at once when the source goes backwards (a scrub, or a different run)", () => {
    const { result, rerender } = renderHook(({ list }) => useEventFeed(list), {
      initialProps: { list: events(20) },
    });
    tick(16);
    expect(result.current.visible).toHaveLength(20);

    rerender({ list: events(6) });
    expect(result.current.visible).toHaveLength(6); // no tick needed
    expect(result.current.batchSize).toBe(0);
  });

  it("honours a custom interval", () => {
    const { result, rerender } = renderHook(({ list }) => useEventFeed(list, 400), {
      initialProps: { list: events(1) },
    });
    tick(16);
    rerender({ list: events(3) });
    tick(300);
    expect(result.current.visible).toHaveLength(1);
    tick(120);
    expect(result.current.visible).toHaveLength(3);
  });

  it("cancels its pending frame on unmount", () => {
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
    const { unmount } = renderHook(() => useEventFeed(events(3)));
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});
