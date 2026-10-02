/** docs/design-plan.md §12.3: the ambient layer behind the frame — the aurora gradients plus a fine
 * grain tile. Purely decorative, so it is `aria-hidden`, takes no pointer events, and holds nothing
 * focusable. The ROOT that hosts it must be `isolate` (AppFrame and PageFrame both are): without a
 * stacking context of its own, `-z-10` would paint this layer BEHIND the root's background and it
 * would simply not show.
 *
 * Only `transform` animates (the `aurora-drift` utility), on one layer, with no blur filter, so it
 * stays on the compositor. It is switched off under prefers-reduced-motion by the utility itself. The
 * layer is inset -15% so the drift never exposes an edge. */
export function AmbientBackground() {
  return (
    <div
      aria-hidden="true"
      data-ambient=""
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div className="aurora aurora-drift absolute -inset-[15%]" />
      <div className="grain absolute inset-0" />
    </div>
  );
}
