import type { ActivityEvent, Replay, ReplayFrame, RunStatus } from "../api/types";
import { foldFrames } from "../replay/fold";
import { findGateGroups, type GateGroup } from "../replay/gates";
import {
  ExternalStore,
  type Decision,
  type RunSource,
  type RunSourceState,
  type Speed,
} from "./RunSource";

/** Injected so tests drive time by hand; the default is the real thing. */
export interface ReplayClock {
  /** Milliseconds, monotonic. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: ReplayClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A timer can fire a hair before its deadline; frames within this many seconds count as due, so
 * the player never spins on a 0 ms reschedule waiting for a frame 0.3 ms away. */
const DUE_EPSILON_S = 0.0005;

/**
 * Plays a recorded run back through the same RunSource interface a live stream uses, so no
 * component can tell the difference (docs/design-plan.md, SPEC "Replay mode").
 *
 * Time. `anchorElapsed` is replay-seconds at `anchorWall` (a clock reading, ms); while playing,
 * elapsed = anchorElapsed + (now - anchorWall) * speed. Changing speed or pausing rebases the
 * anchors rather than restarting, and every tick recomputes elapsed from the clock instead of
 * summing timer intervals, so timer error never accumulates. Frames that fall due in the same tick
 * are applied as one batch — which is exactly what 16x needs.
 *
 * Gates. Recording stores the operator's decision but the replay's operator makes their own: at a
 * gate the player stops the clock and waits in `awaitingDecision` until resume() is called. Every
 * frame in a gate group (the interrupt event and the done event, milliseconds apart) is applied
 * together, so the paused screen shows the same state the recording did.
 */
class ReplayRunSource extends ExternalStore<RunSourceState> implements RunSource {
  private readonly frames: readonly ReplayFrame[];
  private readonly folded: readonly RunStatus[];
  private readonly groups: readonly GateGroup[];
  private readonly recordedDecisions: Replay["header"]["decisions"];
  private readonly durationS: number;

  private cursor = 0;
  private resolved = 0;
  private atGate = false;
  private afterResume: RunStatus | null = null;
  private divergence: RunSourceState["divergence"] = null;

  private playing = false;
  private speed: Speed = 1;
  private anchorWall = 0;
  private anchorElapsed = 0;
  private timer: unknown;

  private started = false;
  private resumeOnStart = false;

  private eventsCache: readonly ActivityEvent[] = [];
  private eventsCursor = 0;

  private readonly clock: ReplayClock;

  constructor(replay: Replay, clock: ReplayClock) {
    super({
      mode: "replay",
      status: null,
      events: [],
      connection: "idle",
      error: null,
      awaitingDecision: false,
      divergence: null,
      transport: { playing: false, speed: 1, elapsedS: 0, durationS: replay.header.duration_s },
    });
    this.clock = clock;
    this.frames = replay.frames;
    this.folded = foldFrames(replay.frames);
    this.groups = findGateGroups(replay.frames);
    this.recordedDecisions = replay.header.decisions;
    this.durationS = Math.max(replay.header.duration_s, replay.frames.at(-1)?.t_offset_s ?? 0);
  }

  // --- RunSource ---------------------------------------------------------------------------

  start = (): void => {
    if (!this.started) {
      this.started = true;
      this.play();
    } else if (this.resumeOnStart) {
      this.resumeOnStart = false;
      this.play();
    }
    this.publish();
  };

  stop = (): void => {
    this.resumeOnStart = this.playing;
    this.pause();
  };

  play = (): void => {
    if (this.atGate) return; // a gate is answered with resume(), not by pressing play
    if (this.cursor >= this.frames.length && this.frames.length > 0) this.rewind();
    if (this.playing) return;
    this.playing = true;
    this.anchorWall = this.clock.now();
    this.schedule();
    this.publish();
  };

  pause = (): void => {
    if (!this.playing) return;
    this.anchorElapsed = this.elapsed();
    this.playing = false;
    this.clearTimer();
    this.publish();
  };

  setSpeed = (speed: Speed): void => {
    if (this.playing) {
      this.anchorElapsed = this.elapsed();
      this.anchorWall = this.clock.now();
    }
    this.speed = speed;
    if (this.playing) {
      this.clearTimer();
      this.schedule();
    }
    this.publish();
  };

  seek = (fraction: number): void => {
    const target = Math.min(1, Math.max(0, fraction)) * this.durationS;
    const wasPlaying = this.playing;
    this.clearTimer();

    let cursor = this.frames.filter((f) => f.t_offset_s <= target + DUE_EPSILON_S).length;
    // A gate counts as passed only once the run has carried on beyond it. Landing on the pause
    // itself lands AT the gate — otherwise "jump to the budget gate" could never stop on it.
    this.resolved = this.groups.filter((g) => cursor > g.end + 1).length;
    const gate = this.groups[this.resolved];
    this.atGate = false;
    if (gate !== undefined && cursor > gate.start) {
      cursor = gate.end + 1;
      this.atGate = true;
    }

    this.cursor = cursor;
    this.afterResume = null;
    this.divergence = null;
    this.anchorElapsed = this.atGate && gate ? this.timeOf(gate.end) : target;
    this.playing = wasPlaying && !this.atGate && cursor < this.frames.length;
    if (this.playing) {
      this.anchorWall = this.clock.now();
      this.schedule();
    }
    this.publish();
  };

  resume = async (decision: Decision): Promise<void> => {
    const gate = this.groups[this.resolved];
    if (!this.atGate || gate === undefined) return;

    const recorded = this.recordedDecisions[this.resolved];
    if (recorded !== undefined && recorded.gate === gate.gate && recorded.approved !== decision.approved) {
      // The recording only has the future in which its operator's answer was given. Carry on down
      // it, and say so, rather than silently ignoring the click or pretending it changed anything.
      this.divergence = {
        seq: this.frames[gate.end]?.event.seq ?? 0,
        gate: gate.gate,
        recordedApproved: recorded.approved,
        operatorApproved: decision.approved,
      };
    }

    const paused = this.folded[gate.end];
    // The gate frames still say "awaiting approval". Until the next recorded frame lands (it is
    // milliseconds away), show the honest minimum: the operator answered and the run is moving.
    this.afterResume = paused ? { ...paused, status: "running", pending_approval: null } : null;
    this.resolved += 1;
    this.atGate = false;
    this.playing = true;
    this.anchorElapsed = this.timeOf(gate.end);
    this.anchorWall = this.clock.now();
    this.schedule();
    this.publish();
  };

  // --- clock -------------------------------------------------------------------------------

  private elapsed(): number {
    if (!this.playing) return this.anchorElapsed;
    const advanced = ((this.clock.now() - this.anchorWall) / 1000) * this.speed;
    return Math.min(this.durationS, this.anchorElapsed + advanced);
  }

  private timeOf(index: number): number {
    return this.frames[index]?.t_offset_s ?? 0;
  }

  private schedule(): void {
    this.clearTimer();
    const next = this.frames[this.cursor];
    if (next === undefined) return;
    const waitS = Math.max(0, next.t_offset_s - this.elapsed());
    this.timer = this.clock.setTimeout(this.tick, (waitS * 1000) / this.speed);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tick = (): void => {
    this.timer = undefined;
    if (!this.playing) return;

    const elapsed = this.elapsed();
    while (this.cursor < this.frames.length && this.timeOf(this.cursor) <= elapsed + DUE_EPSILON_S) {
      const index = this.cursor;
      const gate = this.groups[this.resolved];
      this.afterResume = null;
      this.cursor = index + 1;
      if (gate !== undefined && index === gate.start) {
        this.cursor = gate.end + 1;
        this.atGate = true;
        break;
      }
    }

    const gate = this.groups[this.resolved];
    if (this.atGate && gate !== undefined) {
      this.playing = false;
      this.anchorElapsed = this.timeOf(gate.end);
    } else if (this.cursor >= this.frames.length) {
      this.playing = false;
      this.anchorElapsed = this.durationS;
    } else {
      this.schedule();
    }
    this.publish();
  };

  private rewind(): void {
    this.cursor = 0;
    this.resolved = 0;
    this.atGate = false;
    this.afterResume = null;
    this.divergence = null;
    this.anchorElapsed = 0;
  }

  // --- state -------------------------------------------------------------------------------

  private events(): readonly ActivityEvent[] {
    // Reuse the array while nothing new has been applied: consumers compare it by identity.
    if (this.cursor !== this.eventsCursor) {
      this.eventsCache = this.frames.slice(0, this.cursor).map((f) => f.event);
      this.eventsCursor = this.cursor;
    }
    return this.eventsCache;
  }

  private publish(): void {
    const finished = this.cursor >= this.frames.length && !this.atGate;
    this.set({
      status: this.cursor === 0 ? null : (this.afterResume ?? this.folded[this.cursor - 1] ?? null),
      events: this.events(),
      connection: !this.started ? "idle" : finished ? "closed" : "open",
      awaitingDecision: this.atGate,
      divergence: this.divergence,
      transport: {
        playing: this.playing,
        speed: this.speed,
        elapsedS: this.elapsed(),
        durationS: this.durationS,
      },
    });
  }
}

export function createReplayRunSource(replay: Replay, clock: ReplayClock = realClock): RunSource {
  return new ReplayRunSource(replay, clock);
}
