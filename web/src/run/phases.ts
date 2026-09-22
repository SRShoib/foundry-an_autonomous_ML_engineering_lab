/** The rail's phase ladder and team roster (docs/design-plan.md §5). Both are derived from the
 * event log plus the latest RunStatus — neither is a field the API returns — because they answer
 * two different questions and must not share one derivation:
 *
 * - the LADDER answers "how far has the pipeline got", and is a one-way ratchet. The graph loops
 *   back (the committed demo recording returns to data_team and modeling_team well after red_team
 *   first runs — see the seq trace in the M9c plan), so "current node" would walk the ladder
 *   backwards mid-run. Once a phase is reached it stays done. `principal` is pure routing overhead
 *   between phases and owns no ladder rung of its own.
 * - the ROSTER answers "who is working right now", so it tracks the most recent node instead, and
 *   covers all six teams — including principal, which the ladder has no room for.
 */
import type { ActivityEvent, RunStatus } from "../api/types";
import { TEAM_ORDER, teamForNode, type TeamId } from "./teams";

export type PhaseId = "data" | "modeling" | "running" | "audit" | "report";
export type ProgressState = "done" | "active" | "pending";

export interface Phase {
  id: PhaseId;
  label: string;
  teamId: TeamId;
}

export const PHASES: readonly Phase[] = [
  { id: "data", label: "data", teamId: "data_team" },
  { id: "modeling", label: "modeling", teamId: "modeling_team" },
  { id: "running", label: "running", teamId: "experiment_runner" },
  { id: "audit", label: "audit", teamId: "red_team" },
  { id: "report", label: "report", teamId: "reporter" },
];

export interface PhaseState {
  id: PhaseId;
  label: string;
  state: ProgressState;
}

export interface TeamProgress {
  state: ProgressState;
  /** Only set for experiment_runner: status.experiments.length. There is no concurrency signal in
   * the event log (events are one per completed node, never "N branches in flight"), so this is a
   * count of finished experiments, not the mock's live fan-out count. */
  count?: number;
}

function isTerminal(status: RunStatus | null): boolean {
  return status?.status === "completed" || status?.status === "failed";
}

/** The highest phase index any node event has ever reached. -1 before the first node event. */
function highWaterPhase(events: readonly ActivityEvent[]): number {
  let index = -1;
  for (const event of events) {
    if (event.kind !== "node") continue;
    const team = teamForNode(event.node);
    const phaseIndex = PHASES.findIndex((phase) => phase.teamId === team);
    if (phaseIndex > index) index = phaseIndex;
  }
  return index;
}

export function derivePhases(events: readonly ActivityEvent[], status: RunStatus | null): PhaseState[] {
  const highWater = highWaterPhase(events);
  const terminal = isTerminal(status);
  return PHASES.map((phase, index) => {
    const state: ProgressState =
      index < highWater ? "done" : index > highWater ? "pending" : terminal ? "done" : "active";
    return { id: phase.id, label: phase.label, state };
  });
}

export function deriveTeamProgress(
  events: readonly ActivityEvent[],
  status: RunStatus | null,
): Record<TeamId, TeamProgress> {
  const seen = new Set<TeamId>();
  let lastTeam: TeamId | null = null;
  for (const event of events) {
    if (event.kind !== "node") continue;
    const team = teamForNode(event.node);
    if (team === null) continue;
    seen.add(team);
    lastTeam = team;
  }
  const terminal = isTerminal(status);

  const result = {} as Record<TeamId, TeamProgress>;
  for (const team of TEAM_ORDER) {
    const state: ProgressState = !seen.has(team) ? "pending" : team === lastTeam && !terminal ? "active" : "done";
    result[team] =
      team === "experiment_runner" ? { state, count: status?.experiments.length ?? 0 } : { state };
  }
  return result;
}
