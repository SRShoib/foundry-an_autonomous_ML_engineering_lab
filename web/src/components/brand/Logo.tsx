import { useId } from "react";

import { cn } from "../../lib/cn";

const MARK_PX = { sm: 24, md: 30 } as const;

/** The mark: a geometric "F" in a gradient squircle. Drawn from token gradient stops
 * (`var(--brand-*)`), so it follows the theme; web/public/favicon.svg is the same drawing with
 * literal colours, because a favicon cannot read the page's custom properties. The gradient id comes
 * from `useId` — SVG ids are document-global and the top bar and an empty state can both show one. */
export function LogoMark({ size = 30, className }: { size?: number; className?: string }) {
  const gradientId = useId();
  const shineId = useId();
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--brand-1)" />
          <stop offset="0.55" stopColor="var(--brand-2)" />
          <stop offset="1" stopColor="var(--brand-3)" />
        </linearGradient>
        <linearGradient id={shineId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent-contrast)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--accent-contrast)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      <rect width="32" height="16" rx="9" fill={`url(#${shineId})`} />
      <g fill="var(--accent-contrast)">
        <rect x="9" y="7.5" width="13" height="3" rx="1.5" />
        <rect x="9" y="7.5" width="3" height="17" rx="1.5" />
        <rect x="9" y="14" width="9" height="3" rx="1.5" />
      </g>
    </svg>
  );
}

interface LogoProps {
  size?: keyof typeof MARK_PX;
  /** Show the "foundry" wordmark beside the mark. Off, the name is still available to assistive tech. */
  wordmark?: boolean;
  className?: string;
}

/** The brand lockup (docs/design-plan.md §12.4). The wordmark is gradient text at 16px, which is not
 * "large text", but WCAG 1.4.3 exempts logotypes — text that is part of a brand name — from the
 * contrast minimum. Nothing else in the console is allowed small gradient text. */
export function Logo({ size = "md", wordmark = true, className }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark size={MARK_PX[size]} />
      {wordmark ? (
        <span className="gradient-text text-md font-semibold tracking-tight">foundry</span>
      ) : (
        <span className="sr-only">foundry</span>
      )}
    </span>
  );
}
