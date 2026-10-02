import { useCallback, useEffect, useRef, type PointerEvent } from "react";

/** docs/design-plan.md §7 "Panel spotlight" (M9h): a radial highlight that follows the pointer
 * inside a panel. The hook only WRITES two CSS variables, `--mx` and `--my`, on the element the
 * handlers are spread onto; the `spotlight` utility (styles/base.css) draws the gradient from them.
 * Deliberately no React state: a pointer move fires dozens of times a second and must never
 * re-render the panel (or the feed row, or the table) it sits on.
 *
 * Writes are batched to one per animation frame. Touch is ignored — there is no hover to follow, and
 * the CSS side is `@media (hover: hover)` anyway, so this is belt and braces rather than the only
 * guard. The last position is left in place on leave, so the highlight fades out where it was
 * instead of snapping to a corner.
 *
 * Spread the returned handlers onto the element that carries the `spotlight` class. */
export function useSpotlight<T extends HTMLElement>(): {
  onPointerMove: (event: PointerEvent<T>) => void;
  onPointerLeave: () => void;
} {
  const frame = useRef(0);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onPointerMove = useCallback((event: PointerEvent<T>) => {
    if (event.pointerType === "touch") return;
    // Read before the frame: React's synthetic event is not safe to touch after the handler returns.
    const element = event.currentTarget;
    const { clientX, clientY } = event;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      element.style.setProperty("--mx", `${clientX - rect.left}px`);
      element.style.setProperty("--my", `${clientY - rect.top}px`);
    });
  }, []);

  const onPointerLeave = useCallback(() => cancelAnimationFrame(frame.current), []);

  return { onPointerMove, onPointerLeave };
}
