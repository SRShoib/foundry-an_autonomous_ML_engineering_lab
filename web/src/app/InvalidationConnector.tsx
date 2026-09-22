import { useEffect, useState, type RefObject } from "react";
import { motion } from "motion/react";

import { LEADERBOARD_PANEL_ID } from "./Leaderboard";
import type { Choreography } from "./useInvalidationChoreography";

interface LinePoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface ConnectorProps {
  /** The dock's own positioning context — both anchors' rects are measured relative to this, and
   * the SVG is absolutely positioned to fill it. */
  containerRef: RefObject<HTMLElement | null>;
  choreography: Choreography;
}

/** §8's "only drawn connector in the entire app": an SVG path from the leaderboard panel (the
 * vacated slot's own row is already gone by "connect" — see Leaderboard.tsx's `FlaggedRow`
 * comment) down to the matching entry in AuditPanel, drawn during "connect" and left in place
 * through "finding". `pathLength` is Motion's own abstraction over stroke-dasharray/dashoffset. */
export function InvalidationConnector({ containerRef, choreography }: ConnectorProps) {
  const [points, setPoints] = useState<LinePoints | null>(null);
  const active = choreography.phase === "connect" || choreography.phase === "finding";
  const experimentId = choreography.finding?.experiment_id;

  // A plain effect, not useLayoutEffect: containerRef is attached to an ANCESTOR host node
  // (RunView's dock wrapper) outside this component's own subtree, and React commits refs and
  // fires layout effects bottom-up in the same pass — a child's layout effect can run before an
  // ancestor's own ref is attached in that same commit. A normal effect, firing after paint, has
  // no such ordering hazard; the one-frame delay is invisible against a 500ms+ draw-in.
  useEffect(() => {
    if (!active || experimentId === undefined) {
      setPoints(null);
      return;
    }
    const container = containerRef.current;
    const top = document.getElementById(LEADERBOARD_PANEL_ID);
    const bottom = container?.querySelector(`[data-audit-entry="${experimentId}"]`);
    if (container === null || top === null || bottom === null || bottom === undefined) {
      setPoints(null);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const topRect = top.getBoundingClientRect();
    const bottomRect = bottom.getBoundingClientRect();
    setPoints({
      x1: topRect.left + topRect.width / 2 - containerRect.left,
      y1: topRect.bottom - containerRect.top,
      x2: bottomRect.left + bottomRect.width / 2 - containerRect.left,
      y2: bottomRect.top - containerRect.top,
    });
  }, [active, experimentId, containerRef]);

  if (points === null) return null;

  return (
    // Below the `frame:` breakpoint the board and audit sections are never both visible at once
    // (AppFrame renders both regions once and merely hides one — see its own docstring), so the
    // connector — meaningful only when both ends are actually on screen — is CSS-hidden there
    // rather than guessing at "visible" from a getBoundingClientRect that is all zeroes for a
    // display:none element (and, in jsdom, for a perfectly normal one too).
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 hidden h-full w-full overflow-visible frame:block"
    >
      <motion.line
        key={experimentId}
        x1={points.x1}
        y1={points.y1}
        x2={points.x2}
        y2={points.y2}
        className="stroke-team-redteam"
        strokeWidth={2}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
  );
}
