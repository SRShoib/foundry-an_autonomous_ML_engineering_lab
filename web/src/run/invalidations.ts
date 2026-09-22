import type { RedTeamFinding } from "../api/types";

/** `RunStatus.invalidations` is the FULL audit trail (app/schemas.py: "a `valid` verdict for
 * every audited experiment too, not only the invalidated ones") — every consumer that means
 * "what did the red team invalidate" must filter on verdict, never assume the list already is. */
export function invalidatedFindings(findings: readonly RedTeamFinding[]): RedTeamFinding[] {
  return findings.filter((finding) => finding.verdict === "invalidated");
}

/** Invalidated findings in `current` whose experiment_id was NOT yet invalidated in `previous` —
 * the ones a choreography must animate as new, as opposed to ones already settled on screen.
 * Mirrors app/Leaderboard.tsx's useRankGains: diffs by id, not by array identity, because a replay
 * frame (or a fresh RunStatus poll) is a new object every time even when nothing changed. */
export function newlyInvalidated(
  current: readonly RedTeamFinding[],
  previous: readonly RedTeamFinding[],
): RedTeamFinding[] {
  const previousIds = new Set(invalidatedFindings(previous).map((finding) => finding.experiment_id));
  return invalidatedFindings(current).filter((finding) => !previousIds.has(finding.experiment_id));
}
