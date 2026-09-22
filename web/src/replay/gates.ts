import type { ReplayFrame } from "../api/types";

/** A run of consecutive frames that all carry a `pending_approval`. Recording emits two frames
 * for one pause — the `interrupt` event and the terminal `done` event — at the same instant, so
 * the player treats them as one gate: it applies the whole group, then waits for the operator. */
export interface GateGroup {
  /** Index of the first frame in the group. */
  start: number;
  /** Index of the last frame in the group (inclusive). */
  end: number;
  gate: "budget" | "final";
}

export function findGateGroups(frames: readonly ReplayFrame[]): GateGroup[] {
  const groups: GateGroup[] = [];
  let open: GateGroup | undefined;

  frames.forEach((frame, index) => {
    const pending = frame.status.pending_approval;
    if (pending === null) {
      open = undefined;
      return;
    }
    if (open === undefined) {
      open = { start: index, end: index, gate: pending.gate };
      groups.push(open);
    } else {
      open.end = index;
    }
  });
  return groups;
}
