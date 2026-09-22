import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";

interface PanelProps {
  title: string;
  /** Right-aligned in the title row. Wrap a measured value in `<span className="num">`; prose stays proportional. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  /** A DOM id for callers that need to measure or target this panel directly — M9d's red-team
   * connector (§8) locates the leaderboard panel this way. */
  id?: string;
}

/** A docked panel: nearly square (--radius-panel, 3px), separated by a border and a surface hue,
 * and carrying NO shadow — elevation in the docked layer is never a shadow (§3.3). The title is
 * sentence-case --text-xs in --text-muted at normal tracking, not a tracked-out caps eyebrow (§4). */
export function Panel({ title, meta, children, className, id }: PanelProps) {
  const titleId = useId();
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn("rounded-panel border border-line-strong bg-surface-panel", className)}
    >
      <header className="flex items-baseline justify-between gap-3 border-b border-line-hairline px-4 py-2">
        <h2 id={titleId} className="text-xs font-medium text-fg-muted">
          {title}
        </h2>
        {meta === undefined ? null : <div className="text-xs text-fg-secondary">{meta}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
