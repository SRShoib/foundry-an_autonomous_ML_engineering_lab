import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

import type { RedTeamFinding } from "../api/types";
import { invalidatedFindings, newlyInvalidated } from "../run/invalidations";

/** design-plan.md §8's 1400ms sequence, as a monotonic state machine rather than the design
 * table's literal overlapping windows (0–200 flag, 200–520 demote, 400–900 connect, 700–900
 * finding): each later phase is a strict SUPERSET of the earlier ones' visuals in the consuming
 * components (AuditPanel draws the connector in both "connect" AND "finding", say), so a single
 * "current phase" name at a time is enough to drive every beat and stays trivially testable
 * against the four boundary timestamps. */
export type ChoreographyPhase = "idle" | "flag" | "demote" | "connect" | "finding";

export interface Choreography {
  phase: ChoreographyPhase;
  /** The finding this sequence is FOR. Stays set through "finding" (the resting state) so the
   * audit panel keeps rendering its expansion after the timers have all fired; only a fresh
   * invalidation replaces it. */
  finding: RedTeamFinding | null;
}

const FLAG_MS = 200;
const DEMOTE_MS = 520;
const CONNECT_MS = 900;
// The table's fourth boundary, 1400ms, is where "finding" finishes EXPANDING, not a further phase
// transition — "finding" (set at CONNECT_MS below) is already the resting state, so no timer
// fires at 1400ms itself.

const IDLE: Choreography = { phase: "idle", finding: null };

/** Fires once per NEWLY invalidated finding (never for ones already invalidated when this hook
 * first mounts — same "don't animate the initial state" rule as Leaderboard.tsx's useRankGains).
 * `prefers-reduced-motion` collapses straight to "finding": "the connector drawn statically", no
 * intermediate beats, per §7. Runs on a real clock (setTimeout), not rAF, so
 * test/fakeClock.ts-driven tests can assert each boundary directly with vi.advanceTimersByTime. */
export function useInvalidationChoreography(findings: readonly RedTeamFinding[]): Choreography {
  // Seeded from the FIRST render's own findings (not []), so anything already invalidated when
  // this hook mounts — a reload mid-run, a replay opened partway through — is never mistaken for
  // a fresh invalidation to animate.
  const previous = useRef<readonly RedTeamFinding[]>(findings);
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState<Choreography>(IDLE);

  // `findings` is a fresh array every render — a live run's RunStatus is a new object on every
  // poll/SSE frame even when invalidations themselves are unchanged (spent_usd ticking up, say).
  // Depending on it directly would re-run this effect, and tear down its own in-flight timers via
  // the cleanup below, on every one of those unrelated updates — freezing the sequence at
  // whichever phase happened to be active when the next unrelated update arrived, sometimes
  // before "flag" even finished. `signature` only changes when the set of invalidated ids does
  // (same fix app/Leaderboard.tsx's useRankGains already applies to its own array prop).
  const signature = invalidatedFindings(findings)
    .map((finding) => finding.experiment_id)
    .join("|");

  useEffect(() => {
    const fresh = newlyInvalidated(findings, previous.current);
    previous.current = findings;
    const next = fresh[0];
    if (next === undefined) return;

    if (reducedMotion === true) {
      setState({ phase: "finding", finding: next });
      return;
    }

    setState({ phase: "flag", finding: next });
    const timers = [
      setTimeout(() => setState({ phase: "demote", finding: next }), FLAG_MS),
      setTimeout(() => setState({ phase: "connect", finding: next }), DEMOTE_MS),
      setTimeout(() => setState({ phase: "finding", finding: next }), CONNECT_MS),
    ];
    return () => timers.forEach(clearTimeout);
    // `findings` is intentionally not a dependency here — see the comment above `signature`.
  }, [signature, reducedMotion]);

  return state;
}
