import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/** docs/design-plan.md §7: "Metric values: 400ms count-up on change, --ease-instrument" — used for
 * the budget readout and, later, leaderboard metrics. `<MotionConfig reducedMotion="user">`
 * (App.tsx) only governs Motion COMPONENTS; this is a plain number tweened with rAF, so it checks
 * `useReducedMotion()` itself and snaps straight to the target when the operator has asked for it.
 *
 * `--ease-instrument` is `cubic-bezier(0.34, 0.8, 0.28, 1)` (tokens.css) — reimplemented here as a
 * cubic Bézier solve rather than imported, because this file has no CSS to read the token from and
 * the four control points are simple enough to keep as a literal, checked once by a snapshot test
 * that reads the real token.
 */

const EASE_INSTRUMENT = [0.34, 0.8, 0.28, 1] as const;
const DUR_METRIC_MS = 400;

function cubicBezier(t: number, [x1, y1, x2, y2]: readonly [number, number, number, number]): number {
  // Newton's method against the parametric X curve, then reads Y at the matching t — the standard
  // De Casteljau-free solve used by every CSS easing polyfill.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const sampleDX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;

  let u = t;
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(u) - t;
    if (Math.abs(dx) < 1e-4) break;
    const derivative = sampleDX(u);
    if (Math.abs(derivative) < 1e-6) break;
    u -= dx / derivative;
  }
  return sampleY(u);
}

/** Tweens `value` over `--dur-metric` (400ms) whenever it changes, easing with `--ease-instrument`.
 * Renders the target immediately on mount (there is nothing to count up FROM yet) and on any change
 * while reduced motion is on.
 *
 * `current` mirrors `display` on every frame, not only on completion — so a value that changes
 * again mid-tween (the budget meter's spend ticking up again before the previous count-up
 * finished) retargets smoothly from wherever the animation actually is, rather than jumping back
 * to whatever `value` was when the LAST completed tween started. */
export function useAnimatedNumber(value: number, durationMs = DUR_METRIC_MS): number {
  const reducedMotion = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const current = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    if (reducedMotion === true || value === current.current) {
      current.current = value;
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const startValue = current.current;
    const delta = value - startValue;

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const next = startValue + delta * cubicBezier(t, EASE_INSTRUMENT);
      current.current = next;
      setDisplay(next);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, durationMs, reducedMotion]);

  return display;
}
