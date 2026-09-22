import { useEffect, useRef, useState } from "react";

interface LiveRegionProps {
  message: string;
  /** Minimum gap between announcements. A run can emit dozens of events a second; a screen reader
   * reading each one would be unusable, so only the LATEST message is spoken per interval. */
  intervalMs?: number;
  /** Everything is polite and throttled, except the red-team invalidation, which is announced once
   * and assertively (docs/design-plan.md §8). */
  politeness?: "polite" | "assertive";
}

/** The throttled aria-live region of §10. Visually hidden: it exists to be heard. */
export function LiveRegion({ message, intervalMs = 2000, politeness = "polite" }: LiveRegionProps) {
  const [announced, setAnnounced] = useState("");
  const lastAnnouncedAt = useRef(-Infinity);

  useEffect(() => {
    if (message === "") return;
    const announce = (): void => {
      lastAnnouncedAt.current = performance.now();
      setAnnounced(message);
    };
    const wait = lastAnnouncedAt.current + intervalMs - performance.now();
    if (wait <= 0) {
      announce();
      return;
    }
    const timer = setTimeout(announce, wait);
    return () => clearTimeout(timer);
  }, [message, intervalMs]);

  return (
    <div role="status" aria-live={politeness} aria-atomic="true" className="sr-only">
      {announced}
    </div>
  );
}
