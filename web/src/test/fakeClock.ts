import type { ReplayClock } from "../run/replayRunSource";

/** A clock tests advance by hand. `advance(ms)` fires every timer that falls due, in order, and
 * timers scheduled while firing are honoured too — so a player that reschedules itself from inside
 * its own tick behaves exactly as it would against real time, minus the waiting. */
export class FakeClock implements ReplayClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), run: callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Models a stalled main thread: time leaps forward first, THEN every overdue timer fires — late,
   * all at the new time. This is the only situation in which several recorded frames fall due in
   * the same tick, so it is what the batching tests need; `advance` fires timers on time. */
  jump(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.timers].find(([, timer]) => timer.at <= this.time);
      if (!due) break;
      this.timers.delete(due[0]);
      due[1].run();
    }
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      this.time = Math.max(this.time, nextAt);
      timer?.run();
    }
    this.time = end;
  }
}
