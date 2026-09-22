import { API_BASE, ApiError, unwrap, type ApiClient } from "../api/client";
import type { ActivityEvent, RunStatus } from "../api/types";
import { SseParser } from "../sse/parseSse";
import { ExternalStore, type Decision, type RunSource, type RunSourceState } from "./RunSource";

export interface LiveDeps {
  api: ApiClient;
  fetch?: typeof fetch;
  /** Where the event stream is read from. Default: the same `/api` prefix the client uses. */
  baseUrl?: string;
  /** Called with every fresh status, so the TanStack Query cache can hold the ONE copy of it. */
  onStatus?: (status: RunStatus) => void;
  /** Injected by tests; must resolve early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Status refetches are throttled to one per this many ms. Default 1000. */
  statusThrottleMs?: number;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;
/** Between an end-of-stream and reconnecting to a run that still reads `running`: a resumed leg is
 * the expected cause, but a run caught between legs must not be hammered with instant retries. */
const RECONNECT_PAUSE_MS = 250;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Reads a run's activity stream from the API. It uses fetch and a stream reader, NOT EventSource,
 * because foundry's stream is finite by design — it ends at every approval pause and at completion
 * (app/runs.py) — and EventSource would treat that normal end as an error and reconnect forever.
 *
 * Three behaviours are easy to get wrong, and each has a test:
 *
 * 1. De-duplication on `seq`. RunManager.stream replays a run's full history from seq 0 on EVERY
 *    connection, so a reconnect (or a resume) re-sends everything already seen.
 * 2. What an end-of-stream means. EOF is ambiguous, so the run's status is fetched: paused at a
 *    gate → stop and wait for the operator; running → a resumed leg started, reconnect at once;
 *    completed or failed → done. Only a genuine transport error backs off and retries.
 * 3. A throttled status refresh (one per second), so a burst of events is one request, not one each.
 */
class LiveRunSource extends ExternalStore<RunSourceState> implements RunSource {
  private readonly threadId: string;
  private readonly deps: LiveDeps;

  private controller: AbortController | null = null;
  private looping = false;
  private wanted = false;
  private lastSeq = -1;
  private attempt = 0;

  private lastStatusAt = -Infinity;
  private statusInFlight = false;
  private statusDirty = false;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(threadId: string, deps: LiveDeps) {
    super({
      mode: "live",
      status: null,
      events: [],
      connection: "idle",
      error: null,
      awaitingDecision: false,
      divergence: null,
      transport: null,
    });
    this.threadId = threadId;
    this.deps = deps;
  }

  // --- RunSource ---------------------------------------------------------------------------

  start = (): void => {
    this.wanted = true;
    if (this.looping) return;
    void this.connectLoop();
  };

  stop = (): void => {
    this.wanted = false;
    this.controller?.abort();
    this.controller = null;
    clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    if (this.state.connection !== "closed" && this.state.connection !== "error") {
      this.set({ connection: "idle" });
    }
  };

  resume = async (decision: Decision): Promise<void> => {
    unwrap(
      await this.deps.api.POST("/runs/{thread_id}/resume", {
        params: { path: { thread_id: this.threadId } },
        body: decision,
      }),
    );
    this.set({ awaitingDecision: false });
    // The stream closed when the run paused. Reconnect: it replays history (de-duplicated by seq)
    // and then follows the resumed leg live.
    if (this.wanted && !this.looping) void this.connectLoop();
  };

  // Transport controls are meaningless on a live run, which has no clock of its own.
  play = (): void => undefined;
  pause = (): void => undefined;
  setSpeed = (): void => undefined;
  seek = (): void => undefined;

  // --- connection loop ---------------------------------------------------------------------

  private async connectLoop(): Promise<void> {
    this.looping = true;
    try {
      while (this.wanted) {
        const controller = new AbortController();
        this.controller = controller;
        this.set({ connection: this.attempt === 0 ? "connecting" : "reconnecting" });
        try {
          await this.readStream(controller.signal);
          if (!this.wanted || controller.signal.aborted) return;

          this.attempt = 0;
          const status = await this.fetchStatus(controller.signal);
          if (status.status === "running") {
            await (this.deps.sleep ?? abortableSleep)(RECONNECT_PAUSE_MS, controller.signal);
            continue; // a resumed leg is under way: follow it
          }
          if (status.status === "awaiting_approval") {
            this.set({ connection: "idle" });
            return; // wait for the operator; resume() reconnects
          }
          this.set({ connection: "closed" });
          return;
        } catch (error) {
          if (!this.wanted || controller.signal.aborted) return;
          if (error instanceof ApiError && error.status < 500) {
            // The API said no (an unknown run, say). Retrying cannot change that.
            this.set({ connection: "error", error: error.detail });
            this.wanted = false;
            return;
          }
          this.attempt += 1;
          this.set({
            connection: "reconnecting",
            error: error instanceof Error ? error.message : "stream interrupted",
          });
          await this.backoff(controller.signal);
        }
      }
    } finally {
      this.looping = false;
    }
  }

  private async backoff(signal: AbortSignal): Promise<void> {
    const random = this.deps.random ?? Math.random;
    const sleep = this.deps.sleep ?? abortableSleep;
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.attempt - 1));
    await sleep(ceiling * (0.5 + random() * 0.5), signal); // jitter: half to full of the ceiling
  }

  private async readStream(signal: AbortSignal): Promise<void> {
    const fetchFn = this.deps.fetch ?? fetch;
    const base = this.deps.baseUrl ?? API_BASE;
    const response = await fetchFn(`${base}/runs/${encodeURIComponent(this.threadId)}/events`, {
      signal,
      headers: { accept: "text/event-stream" },
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      const hasDetail = typeof body === "object" && body !== null && "detail" in body;
      throw new ApiError(
        response.status,
        hasDetail
          ? String((body as { detail: unknown }).detail)
          : response.statusText || `HTTP ${response.status}`,
        hasDetail,
      );
    }
    if (!response.body) throw new Error("the event stream has no body");

    this.set({ connection: "open", error: null });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        this.ingest(message.data);
      }
    }
  }

  private ingest(data: string): void {
    let event: ActivityEvent;
    try {
      event = JSON.parse(data) as ActivityEvent;
    } catch {
      return; // a malformed frame is dropped, never fatal to a live run
    }
    if (event.seq <= this.lastSeq) return; // history replayed on reconnect
    this.lastSeq = event.seq;
    this.set({ events: [...this.state.events, event] });
    this.requestStatus();
  }

  // --- status ------------------------------------------------------------------------------

  private requestStatus(): void {
    const throttle = this.deps.statusThrottleMs ?? 1000;
    const wait = this.lastStatusAt + throttle - Date.now();
    if (this.statusInFlight || wait > 0) {
      // Coalesce: one trailing refresh covers every event that arrived in the meantime.
      this.statusDirty = true;
      if (!this.statusTimer && !this.statusInFlight) {
        this.statusTimer = setTimeout(() => {
          this.statusTimer = undefined;
          this.requestStatus();
        }, Math.max(0, wait));
      }
      return;
    }
    void this.fetchStatus().catch(() => undefined);
  }

  private async fetchStatus(signal?: AbortSignal): Promise<RunStatus> {
    this.statusInFlight = true;
    this.statusDirty = false;
    this.lastStatusAt = Date.now();
    try {
      const status = unwrap(
        await this.deps.api.GET("/runs/{thread_id}", {
          params: { path: { thread_id: this.threadId } },
          ...(signal ? { signal } : {}),
        }),
      );
      this.set({
        status,
        awaitingDecision: status.status === "awaiting_approval",
        error: status.error,
      });
      this.deps.onStatus?.(status);
      return status;
    } finally {
      this.statusInFlight = false;
      if (this.statusDirty && this.wanted) this.requestStatus();
    }
  }
}

export function createLiveRunSource(threadId: string, deps: LiveDeps): RunSource {
  return new LiveRunSource(threadId, deps);
}
