import type { LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { useSpotlight } from "../../lib/useSpotlight";

interface PanelProps {
  title: string;
  /** A small lucide icon before the title — decorative, so the title still names the panel. */
  icon?: LucideIcon;
  /** Right-aligned in the title row. Wrap a measured value in `<span className="num">`; prose stays proportional. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  /** A DOM id for callers that need to measure or target this panel directly — M9d's red-team
   * connector (§8) locates the leaderboard panel this way. */
  id?: string;
}

/** A docked panel (docs/design-plan.md §3.3 and §12.5, revised M9h): opaque `--surface-panel` at
 * `--radius-panel` (14px), a gradient hairline ring instead of a flat grey border, a tinted layered
 * `--shadow-panel` at rest, and a cursor spotlight on pointer-fine devices. It stays opaque rather
 * than glass: a docked panel must read with nothing rendered behind it, and `backdrop-filter` is
 * budgeted for the top bar and the float layer.
 *
 * The title is sentence-case `--text-sm` semibold in `--text-secondary` — M9a–M9g's 12px muted title
 * gave the dock no hierarchy — with no tracked caps (§4). */
export function Panel({ title, icon: Icon, meta, children, className, id }: PanelProps) {
  const titleId = useId();
  const spotlight = useSpotlight<HTMLElement>();
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      {...spotlight}
      className={cn("gradient-border spotlight rounded-panel bg-surface-panel shadow-panel", className)}
    >
      <header className="flex items-center justify-between gap-3 px-4 pb-1 pt-3">
        <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold tracking-tight text-fg-secondary">
          {Icon === undefined ? null : <Icon aria-hidden="true" strokeWidth={2.25} className="size-4 shrink-0 text-fg-muted" />}
          {title}
        </h2>
        {meta === undefined ? null : <div className="text-xs text-fg-secondary">{meta}</div>}
      </header>
      <div className="px-4 pb-4 pt-2">{children}</div>
    </section>
  );
}
