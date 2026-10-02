import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ChipTone = "ok" | "warn" | "danger" | "info" | "idle" | "brand" | "neutral";

/** Class strings spelled out in full, never built from a template, so Tailwind's scanner sees every
 * one. The wash is 15% of the tone and the ring 30% — the same 15% styles/tokenGroups.ts's CHIP_ALPHA
 * holds to AA. `mark` colours the dot or icon only. */
const TONE: Record<ChipTone, { box: string; mark: string }> = {
  ok: { box: "bg-status-ok/15 ring-status-ok/30", mark: "text-status-ok" },
  warn: { box: "bg-status-warn/15 ring-status-warn/30", mark: "text-status-warn" },
  danger: { box: "bg-status-danger/15 ring-status-danger/30", mark: "text-status-danger" },
  info: { box: "bg-status-info/15 ring-status-info/30", mark: "text-status-info" },
  idle: { box: "bg-status-idle/15 ring-status-idle/30", mark: "text-status-idle" },
  brand: { box: "bg-brand-1/15 ring-brand-1/30", mark: "text-brand-1" },
  neutral: { box: "bg-surface-raised ring-line-strong", mark: "text-fg-muted" },
};

interface ChipProps {
  tone: ChipTone;
  /** A lucide icon for the mark. Without one, a dot. */
  icon?: LucideIcon;
  /** The dot emits a slow ring: "this is happening right now". Reserved for live and running (§7). */
  live?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}

/** A tinted pill: a tone-coloured mark and a TEXT label (docs/design-plan.md §12.5). The label is
 * always `--text-primary`, never the tone colour: tone text on its own tint falls under 4.5:1 on the
 * light theme (§11), whereas the mark is a graphic and only needs 3:1. Colour is also never the only
 * carrier of the state — the label is always there (WCAG 1.4.1). */
export function Chip({ tone, icon: Icon, live = false, title, className, children }: ChipProps) {
  const { box, mark } = TONE[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-xs font-medium text-fg ring-1 ring-inset",
        box,
        className,
      )}
    >
      {Icon === undefined ? (
        <span
          aria-hidden="true"
          data-live={live ? "" : undefined}
          className={cn("size-1.5 rounded-pill bg-current", mark, live && "ping-ring")}
        />
      ) : (
        <Icon aria-hidden="true" strokeWidth={2.25} className={cn("size-3.5 shrink-0", mark)} />
      )}
      <span>{children}</span>
    </span>
  );
}
