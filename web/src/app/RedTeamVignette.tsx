import { motion, useReducedMotion } from "motion/react";

import type { Choreography } from "./useInvalidationChoreography";

/** docs/design-plan.md §8 (revised M9h): the screen-edge vignette of the red-team moment — a danger
 * tint that swells in from the viewport's edges and fades across the same 1400ms as the sequence.
 * It is the ONLY vignette in the app: M9h spreads boldness across material, brand and live state,
 * but the red-team invalidation is still the single loudest moment, and this is what makes it so.
 *
 * Gated exactly like the audit panel's own 2px fading rule: rendered only while a sequence is active
 * and keyed by the finding, so a fresh invalidation always restarts it and an idle mount (a page
 * load with pre-existing invalidations) never plays it. Decorative and inert (`aria-hidden`, no
 * pointer events). Under reduced motion it is not drawn at all: it carries no information the audit
 * panel, the connector and the live-region announcement do not (§7: no information is lost). */
export function RedTeamVignette({ choreography }: { choreography: Choreography }) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion === true || choreography.phase === "idle" || choreography.finding === null) return null;
  return (
    <motion.div
      key={choreography.finding.experiment_id}
      aria-hidden="true"
      data-vignette=""
      className="pointer-events-none fixed inset-0 z-20 shadow-vignette-danger"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 0] }}
      transition={{ duration: 1.4, times: [0, 0.25, 1], ease: "easeOut" }}
    />
  );
}
