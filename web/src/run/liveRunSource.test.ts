import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client";
import type { ActivityEvent } from "../api/types";
import { createLiveRunSource, type LiveDeps } from "./liveRunSource";
import { fakeApi, TEST_BASE_URL, type FakeRoutes } from "../test/fakeApi";
import { makeEvent, makeGate, makeRunStatus } from "../test/fixtures";
import { brokenBody, hangingBody, sseBody, sseText } from "../test/sseBody";

const events = (from: number, to: number): ActivityEvent[] =>
  Array.from({ length: to - from + 1 }, (_, i) => makeEvent(from + i));

function harness(routes: FakeRoutes, extra: Partial<LiveDeps> = {}) {
  const fake = fakeApi(routes);
  const sleeps: number[] = [];
  const source = createLiveRunSource("t-1", {
    api: createApiClient({ baseUrl: TEST_BASE_URL, fetch: fake.fetch }),
    fetch: fake.fetch,
    baseUrl: TEST_BASE_URL,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1, // no jitter: backoff waits equal their ceilings
    statusThrottleMs: 0,
    ...extra,
  });
  return { source, fake, sleeps, state: () => source.getSnapshot() };
}

const seqs = (state: { events: readonly ActivityEvent[] }): number[] => state.events.map((e) => e.seq);

afterEach(() => {
  vi.useRealTimers();
});

describe("streaming", () => {
  it("reads events in order, fetches the status, and closes when the run has completed", async () => {
    const { source, state } = harness({
      "GET /runs/t-1/events": () => ({ body: sseBody(sseText(events(0, 3))) }),
      "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed", spent_usd: 0.32 }) }),
    });
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));

    expect(seqs(state())).toEqual([0, 1, 2, 3]);
    expect(state().status?.spent_usd).toBe(0.32);
    expect(state()).toMatchObject({ mode: "live", transport: null, awaitingDecision: false });
  });

  it("parses the same events however the network splits the bytes, and ignores keepalives", async () => {
    const text = sseText(events(0, 4), { keepalive: true });
    for (const chunkSize of [1, 7, 64]) {
      const { source, state } = harness({
        "GET /runs/t-1/events": () => ({ body: sseBody(text, chunkSize) }),
        "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
      });
      source.start();
      await vi.waitFor(() => expect(state().connection).toBe("closed"));
      expect(seqs(state()), `chunk size ${chunkSize}`).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("drops a malformed frame without killing the stream", async () => {
    const text = `${sseText(events(0, 0))}data: {not json\n\n${sseText(events(1, 1))}`;
    const { source, state } = harness({
      "GET /runs/t-1/events": () => ({ body: sseBody(text) }),
      "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
    });
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(seqs(state())).toEqual([0, 1]);
  });

  it("hands every fresh status to onStatus, so the query cache holds the one copy", async () => {
    const onStatus = vi.fn();
    const { source, state } = harness(
      {
        "GET /runs/t-1/events": () => ({ body: sseBody(sseText(events(0, 0))) }),
        "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
      },
      { onStatus },
    );
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });
});

describe("a finite stream", () => {
  it("de-duplicates on seq, because every connection replays the whole history from 0", async () => {
    let connections = 0;
    const { source, state, fake } = harness({
      "GET /runs/t-1/events": () => ({
        body: sseBody(sseText(connections++ === 0 ? events(0, 2) : events(0, 5))),
      }),
      "GET /runs/t-1": () => ({
        json: makeRunStatus({ status: connections === 1 ? "running" : "completed" }),
      }),
    });
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));

    expect(fake.callsTo("GET /runs/t-1/events")).toHaveLength(2);
    expect(seqs(state())).toEqual([0, 1, 2, 3, 4, 5]); // no repeats
  });

  it("stops and waits for the operator when the run is paused at a gate", async () => {
    const paused = makeRunStatus({
      status: "awaiting_approval",
      pending_approval: makeGate({ gate: "budget" }),
    });
    const { source, state, fake } = harness({
      "GET /runs/t-1/events": () => ({ body: sseBody(sseText(events(0, 2))) }),
      "GET /runs/t-1": () => ({ json: paused }),
    });
    source.start();
    await vi.waitFor(() => expect(state().awaitingDecision).toBe(true));

    expect(state().connection).toBe("idle");
    expect(state().status?.pending_approval?.gate).toBe("budget");
    await new Promise((r) => setTimeout(r, 30)); // and it stays put: no reconnect
    expect(fake.callsTo("GET /runs/t-1/events")).toHaveLength(1);
  });

  it("posts the decision on resume, then reconnects and follows the resumed leg to the end", async () => {
    let resumed = false;
    const paused = makeRunStatus({
      status: "awaiting_approval",
      pending_approval: makeGate({ gate: "final" }),
    });
    const { source, state, fake } = harness({
      "GET /runs/t-1/events": () => ({
        body: sseBody(sseText(resumed ? events(0, 5) : events(0, 2))),
      }),
      "GET /runs/t-1": () => ({ json: resumed ? makeRunStatus({ status: "completed" }) : paused }),
      "POST /runs/t-1/resume": () => {
        resumed = true;
        return { status: 202, json: { thread_id: "t-1", status: "running" } };
      },
    });
    source.start();
    await vi.waitFor(() => expect(state().awaitingDecision).toBe(true));

    await source.resume({ approved: true, note: "ship it" });
    expect(fake.callsTo("POST /runs/t-1/resume")[0]?.body).toEqual({ approved: true, note: "ship it" });
    expect(state().awaitingDecision).toBe(false);

    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(seqs(state())).toEqual([0, 1, 2, 3, 4, 5]);
    expect(state().status?.status).toBe("completed");
  });

  it("surfaces a refused resume (the run is not paused) instead of swallowing it", async () => {
    const { source } = harness({
      "POST /runs/t-1/resume": () => ({
        status: 409,
        json: { detail: "thread_id 't-1' has no pending approval (status='completed')" },
      }),
    });
    await expect(source.resume({ approved: true, note: "" })).rejects.toThrow("no pending approval");
  });

  it("reports the run's own error verbatim when it failed", async () => {
    const { source, state } = harness({
      "GET /runs/t-1/events": () => ({ body: sseBody(sseText(events(0, 1))) }),
      "GET /runs/t-1": () => ({
        json: makeRunStatus({ status: "failed", error: "docker daemon went away" }),
      }),
    });
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(state().error).toBe("docker daemon went away");
  });
});

describe("a broken connection", () => {
  it("backs off with jittered exponential waits, keeps its events, and recovers", async () => {
    let calls = 0;
    const { source, state, sleeps } = harness({
      "GET /runs/t-1/events": () => {
        calls += 1;
        if (calls === 1) return { body: brokenBody(sseText(events(0, 1))) }; // dies mid-stream
        if (calls <= 3) throw new TypeError("Failed to fetch"); // then cannot connect at all
        return { body: sseBody(sseText(events(0, 4))) };
      },
      "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
    });
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));

    expect(sleeps).toEqual([500, 1000, 2000]); // ceilings double; random()=1 means no jitter
    expect(seqs(state())).toEqual([0, 1, 2, 3, 4]); // what arrived before the drop was kept
    expect(state().error).toBeNull(); // recovered: the transport error is cleared
  });

  it("shows `reconnecting` and the reason while it waits", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { source, state } = harness(
      {
        "GET /runs/t-1/events": () => {
          throw new TypeError("Failed to fetch");
        },
      },
      {
        sleep: () => gate, // hold the first backoff open so the state can be observed
      },
    );
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("reconnecting"));
    expect(state().error).toBe("Failed to fetch");
    source.stop();
    release?.();
  });

  it("caps the wait at 8 seconds", async () => {
    let calls = 0;
    const { source, state, sleeps } = harness({
      "GET /runs/t-1/events": () => {
        if (++calls <= 8) throw new TypeError("down");
        return { body: sseBody(sseText(events(0, 0))) };
      },
      "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
    });
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });

  it("jitters between half and all of the ceiling", async () => {
    let calls = 0;
    const { source, state, sleeps } = harness(
      {
        "GET /runs/t-1/events": () => {
          if (++calls === 1) throw new TypeError("down");
          return { body: sseBody(sseText(events(0, 0))) };
        },
        "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
      },
      { random: () => 0 },
    );
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(sleeps).toEqual([250]);
  });

  it("does not retry a 404: the API saying no is not a fault", async () => {
    const { source, state, fake, sleeps } = harness({
      "GET /runs/t-1/events": () => ({ status: 404, json: { detail: "unknown thread_id 't-1'" } }),
    });
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("error"));

    expect(state().error).toBe("unknown thread_id 't-1'");
    expect(fake.callsTo("GET /runs/t-1/events")).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a 5xx", async () => {
    let calls = 0;
    const { source, state } = harness({
      "GET /runs/t-1/events": () => {
        if (++calls === 1) return { status: 503, json: { detail: "warming up" } };
        return { body: sseBody(sseText(events(0, 0))) };
      },
      "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
    });
    source.start();
    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(calls).toBe(2);
  });
});

describe("lifecycle", () => {
  it("stop() aborts an in-flight stream and does not reconnect", async () => {
    let aborted = false;
    const fake = fakeApi({});
    const hangingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => (aborted = true));
      return new Response(hangingBody(init?.signal), { status: 200 });
    }) as typeof fetch;
    const source = createLiveRunSource("t-1", {
      api: createApiClient({ baseUrl: TEST_BASE_URL, fetch: fake.fetch }),
      fetch: hangingFetch,
      baseUrl: TEST_BASE_URL,
      statusThrottleMs: 0,
    });

    source.start();
    await vi.waitFor(() => expect(source.getSnapshot().connection).toBe("open"));
    source.stop();
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(source.getSnapshot().connection).toBe("idle");
    expect(fake.calls).toEqual([]);
  });

  it("start() is idempotent and restartable, as React StrictMode requires", async () => {
    const { source, state, fake } = harness({
      "GET /runs/t-1/events": () => ({ body: sseBody(sseText(events(0, 2))) }),
      "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
    });
    source.start();
    source.start(); // second call while the first loop runs: no second connection
    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(fake.callsTo("GET /runs/t-1/events")).toHaveLength(1);

    source.stop();
    source.start(); // mount, unmount, mount again
    await vi.waitFor(() => expect(fake.callsTo("GET /runs/t-1/events")).toHaveLength(2));
    await vi.waitFor(() => expect(state().connection).toBe("closed"));
    expect(seqs(state())).toEqual([0, 1, 2]); // still no duplicates
  });

  it("has inert transport controls", () => {
    const { source, state } = harness({});
    source.play();
    source.pause();
    source.setSpeed(4);
    source.seek(0.5);
    expect(state().transport).toBeNull();
  });
});

describe("status refresh", () => {
  it("coalesces a burst of events into one trailing refresh per throttle window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const burst = events(0, 9);
    const { source, fake } = harness(
      {
        "GET /runs/t-1/events": () => ({ body: sseBody(sseText(burst)) }),
        "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed" }) }),
      },
      { statusThrottleMs: 1000, sleep: async () => undefined },
    );
    source.start();
    await vi.advanceTimersByTimeAsync(50);

    // ten events arrived; the first refreshed immediately and the rest are waiting on ONE timer
    const statusCalls = () => fake.callsTo("GET /runs/t-1").length;
    expect(statusCalls()).toBeLessThanOrEqual(2);
    const before = statusCalls();
    await vi.advanceTimersByTimeAsync(1100);
    expect(statusCalls()).toBeLessThanOrEqual(before + 1);
    source.stop();
  });
});
