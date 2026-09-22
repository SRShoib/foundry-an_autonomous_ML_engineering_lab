import type { ActivityEvent, ApprovalGate, RunStatus } from "../api/types";

/** The one interface every screen reads a run through. There are two implementations — a live SSE
 * stream and a recorded replay — and no component may know which it has: they read
 * RunSourceState and nothing else. The only thing that differs is `transport`, which is null when
 * live and drives the replay controls otherwise.
 *
 * It is consumed with useSyncExternalStore (subscribe / getSnapshot), so `getSnapshot` MUST return
 * the same object until something actually changes — a fresh object per call is an infinite render
 * loop. ExternalStore below guarantees that. */

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

export type Speed = 1 | 4 | 16;
export const SPEEDS: readonly Speed[] = [1, 4, 16];

export interface TransportState {
  playing: boolean;
  speed: Speed;
  elapsedS: number;
  durationS: number;
}

/** Replay only. The operator answered a gate differently from the recording. The player carries on
 * along the only future it recorded, and says so, rather than pretending or ignoring the click. */
export interface Divergence {
  /** seq of the last event before the gate, so a UI can point at where the paths split. */
  seq: number;
  gate: ApprovalGate;
  recordedApproved: boolean;
  operatorApproved: boolean;
}

export interface RunSourceState {
  mode: "live" | "replay";
  /** Always a complete RunStatus — a replay's carry-forward encoding is already folded away. */
  status: RunStatus | null;
  /** Append-only and ordered by seq. */
  events: readonly ActivityEvent[];
  connection: ConnectionState;
  /** `RunStatus.error` verbatim, or a transport failure message. */
  error: string | null;
  /** The run is paused at a gate and nothing further happens until the operator answers. */
  awaitingDecision: boolean;
  divergence: Divergence | null;
  transport: TransportState | null;
}

export interface Decision {
  approved: boolean;
  note: string;
}

export interface RunSource {
  subscribe(onChange: () => void): () => void;
  getSnapshot(): RunSourceState;
  /** Idempotent, and restartable after stop() — React StrictMode mounts, unmounts and remounts. */
  start(): void;
  stop(): void;
  resume(decision: Decision): Promise<void>;
  /** Transport controls. No-ops on a live source, which has no clock of its own. */
  play(): void;
  pause(): void;
  setSpeed(speed: Speed): void;
  /** Jump to a fraction (0..1) of the recording's duration. */
  seek(fraction: number): void;
}

/** A tiny immutable store: every change replaces `state` with a new object and notifies. */
export abstract class ExternalStore<S> {
  private snapshot: S;
  private readonly listeners = new Set<() => void>();

  protected constructor(initial: S) {
    this.snapshot = initial;
  }

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  };

  getSnapshot = (): S => this.snapshot;

  protected set(patch: Partial<S>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  protected get state(): S {
    return this.snapshot;
  }
}
