import { cn } from "../../lib/cn";

/** A muted block that holds the place of content (docs/design-plan.md §9): shimmer-free, because a
 * moving highlight on a dozen blocks is decoration, and sized to the real layout so nothing
 * reflows when the data arrives. Hidden from assistive tech — the region it sits in carries the
 * "loading" state. */
export function Skeleton({ className }: { className?: string }) {
  // --line-hairline, not --surface-inset: on the light theme's abyss ground (#EEF1F5) an inset
  // block (#EDF1F5) is invisible. Hairline shows on abyss, deck and panel in both themes.
  return <div aria-hidden="true" className={cn("rounded-panel bg-line-hairline", className)} />;
}

/** Placeholder lines for a text-shaped area. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
