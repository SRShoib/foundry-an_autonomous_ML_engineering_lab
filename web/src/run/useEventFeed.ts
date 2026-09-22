import { useEffect, useRef, useState } from "react";

import type { ActivityEvent } from "../api/types";

export interface EventFeed {
  /** The events to render, released on the flush cadence rather than as they arrive. */
  visible: readonly ActivityEvent[];
  /** How many events arrived in the flush that just happened. The feed's entry animation reads
   * this: docs/design-plan.md §7 says more than 6 in one tick means NO per-row stagger, because a
   * stagger at that rate reads as chaos. It lives here so the rule is derived once, not per row. */
  batchSize: number;
  /** This flush's batch size scaled to a per-second rate — §7's other threshold: "above about 20
   * per second, opacity-only at 90ms" (a busy run, or a replay at 16x). 0 for the first flush and
   * for a backwards jump, where there is no prior flush to measure a rate against. */
  ratePerSecond: number;
}

/**
 * Releases events to the screen on a rAF tick gated to `intervalMs` (default 100, design-plan §7:
 * "events flush on a 100ms rAF tick"). At the rates a replay at 16x, or a busy run, produces,
 * rendering each event as it arrives would re-render the feed dozens of times a second; batching
 * them is what keeps it smooth. Every event that arrives between two flushes lands in one render.
 *
 * A source can also go BACKWARDS — the operator scrubs a replay to an earlier point, or the
 * component moves to another run — and then there is nothing to batch: the feed snaps to the new
 * length at once rather than waiting out a tick with a stale tail on screen.
 */
export function useEventFeed(events: readonly ActivityEvent[], intervalMs = 100): EventFeed {
  const [released, setReleased] = useState({ count: 0, batchSize: 0, ratePerSecond: 0 });
  const lastFlush = useRef(-Infinity);

  useEffect(() => {
    if (events.length < released.count) {
      lastFlush.current = -Infinity;
      setReleased({ count: events.length, batchSize: 0, ratePerSecond: 0 });
      return;
    }
    if (events.length === released.count) return;

    let frame = 0;
    const flush = (): void => {
      const now = performance.now();
      if (now - lastFlush.current < intervalMs) {
        frame = requestAnimationFrame(flush);
        return;
      }
      const elapsedMs = now - lastFlush.current; // Infinity on the very first flush
      lastFlush.current = now;
      setReleased((previous) => {
        const batchSize = events.length - previous.count;
        const ratePerSecond = Number.isFinite(elapsedMs) && elapsedMs > 0 ? (batchSize / elapsedMs) * 1000 : 0;
        return { count: events.length, batchSize, ratePerSecond };
      });
    };
    frame = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(frame);
  }, [events, released.count, intervalMs]);

  return { visible: events.slice(0, released.count), batchSize: released.batchSize, ratePerSecond: released.ratePerSecond };
}
