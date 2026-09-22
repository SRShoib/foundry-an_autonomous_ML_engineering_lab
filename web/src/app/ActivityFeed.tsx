import { useEffect, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";

import type { ActivityEvent } from "../api/types";
import { EmptyState } from "../components/states/EmptyState";
import { SkeletonLines } from "../components/states/Skeleton";
import { cn } from "../lib/cn";
import { formatTime, formatUsdPrecise } from "../lib/format";
import { TEAM_META, teamForEvent } from "../run/teams";

const EASE_OUT: readonly [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Above this many released events the feed switches from a plain list to a windowed one
 * (§7: "List is virtualized"). Below it every row renders — the demo recording's 33 events, and
 * jsdom's tests, never cross it, since a virtualizer measuring 0-height rows (jsdom lays out
 * nothing) cannot be asserted against meaningfully anyway. */
export const VIRTUALIZE_ABOVE = 60;
const ROW_ESTIMATE_PX = 56;
/** How far from the bottom (px) still counts as "at the bottom" for follow-mode. */
const FOLLOW_THRESHOLD_PX = 48;

export interface EntryMotion {
  /** false above ~20 events/s: opacity only, no vertical slide (§7). */
  slide: boolean;
  durationS: number;
  /** 0 when more than 6 events land in one flush — a stagger at that rate reads as chaos (§7). */
  staggerS: number;
}

/** §7's two feed-arrival thresholds, as one pure decision: "above about 20 per second,
 * opacity-only at 90ms" beats "more than 6 in one tick, no stagger", which beats the base case
 * (140ms slide with a small per-row stagger). 140ms and 90ms are the design plan's own literals for
 * this specific moment, not the general --dur-* scale (90ms happens to coincide with
 * --dur-instant). */
export function entryMotion(batchSize: number, ratePerSecond: number): EntryMotion {
  if (ratePerSecond >= 20) return { slide: false, durationS: 0.09, staggerS: 0 };
  if (batchSize > 6) return { slide: true, durationS: 0.14, staggerS: 0 };
  return { slide: true, durationS: 0.14, staggerS: 0.02 };
}

interface RowStyle {
  label: string;
  textClass: string;
  railClass: string;
  railWidthPx: number;
}

/** A team's own hue and glyph when the event is one of its turns; otherwise the status ramp — an
 * interrupt, a terminal `done`/`error`, or a `node` event for something with no team of its own
 * (`final_gate`, `lesson_writer`, or an unrecognised future node), which shows its own name rather
 * than inventing a team for it. */
export function feedRowStyle(event: ActivityEvent): RowStyle {
  const team = teamForEvent(event);
  if (team !== null) {
    const meta = TEAM_META[team];
    return { label: meta.label, textClass: meta.text, railClass: meta.railBg, railWidthPx: meta.railWidth === "thick" ? 5 : 3 };
  }
  if (event.kind === "interrupt") {
    return { label: "interrupt", textClass: "text-status-warn", railClass: "bg-status-warn", railWidthPx: 3 };
  }
  if (event.kind === "done") {
    return { label: "done", textClass: "text-status-ok", railClass: "bg-status-ok", railWidthPx: 3 };
  }
  if (event.kind === "error") {
    return { label: "error", textClass: "text-status-danger", railClass: "bg-status-danger", railWidthPx: 3 };
  }
  return {
    label: (event.node ?? "system").replace(/_/g, " "),
    textClass: "text-fg-muted",
    railClass: "bg-status-idle",
    railWidthPx: 3,
  };
}

/** The row's inner markup only — no wrapping `<li>` — so the two ways a row gets positioned
 * (framer-motion's enter animation below the virtualization threshold, react-virtual's own
 * transform above it) never have to fight over which one owns the element's `transform`. */
function FeedRowContent({ event, setsize, posinset }: { event: ActivityEvent; setsize: number; posinset: number }) {
  const style = feedRowStyle(event);
  return (
    <>
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0", style.railClass)} style={{ width: style.railWidthPx }} />
      <div className="flex items-baseline gap-2 pl-4 pr-3 text-sm">
        <span className={cn("num shrink-0 text-2xs", style.textClass)} aria-hidden="true">
          {String(event.seq).padStart(3, "0")}
        </span>
        <span className={cn("shrink-0 font-medium", style.textClass)}>{style.label}</span>
        <span className="min-w-0 flex-1 truncate text-fg">{event.summary}</span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between pl-[3.25rem] pr-3 text-xs text-fg-muted">
        <span className="num">{formatTime(event.ts)}</span>
        {event.spent_usd === null ? null : <span className="num text-fg-secondary">{formatUsdPrecise(event.spent_usd)}</span>}
      </div>
      <span className="sr-only">{`, item ${posinset} of ${setsize}`}</span>
    </>
  );
}

/** Below the virtualization threshold: every row is a real `motion.li`, so the newest batch can
 * play the §7 entrance animation (slide/opacity, gated by rate and batch size) while older rows —
 * `animate={false}` — render at rest with no transition at all, even when the list around them
 * re-renders. */
function AnimatedFeedRow({
  event,
  setsize,
  posinset,
  animate,
  profile,
  delayS,
}: {
  event: ActivityEvent;
  setsize: number;
  posinset: number;
  animate: boolean;
  profile: EntryMotion;
  delayS: number;
}) {
  const initial = animate ? (profile.slide ? { opacity: 0, y: 4 } : { opacity: 0 }) : false;
  return (
    <motion.li
      role="listitem"
      aria-setsize={setsize}
      aria-posinset={posinset}
      initial={initial}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: profile.durationS, ease: EASE_OUT, delay: animate ? delayS : 0 }}
      className="relative border-b border-line-hairline py-2"
    >
      <FeedRowContent event={event} setsize={setsize} posinset={posinset} />
    </motion.li>
  );
}

/** Above the virtualization threshold: a plain, absolutely-positioned `<li>` that react-virtual
 * owns the transform of. No entrance animation here — mixing react-virtual's placement transform
 * with framer-motion's own would have both fighting over the same CSS property, and a feed dense
 * enough to need virtualization is exactly the "favour correctness over decoration" case §7's own
 * high-rate rule (opacity-only above 20/s) already anticipates. */
function VirtualFeedRow({
  event,
  setsize,
  posinset,
  start,
  dataIndex,
  measureRef,
}: {
  event: ActivityEvent;
  setsize: number;
  posinset: number;
  start: number;
  dataIndex: number;
  measureRef: (el: Element | null) => void;
}) {
  return (
    <li
      role="listitem"
      aria-setsize={setsize}
      aria-posinset={posinset}
      data-index={dataIndex}
      ref={measureRef}
      className="absolute left-0 top-0 w-full border-b border-line-hairline py-2"
      style={{ transform: `translateY(${start}px)` }}
    >
      <FeedRowContent event={event} setsize={setsize} posinset={posinset} />
    </li>
  );
}

export interface ActivityFeedProps {
  /** The released (batched) events — `useEventFeed(...).visible`. */
  events: readonly ActivityEvent[];
  batchSize: number;
  ratePerSecond: number;
  /** `state.connection === "open"`: distinguishes "connected, genuinely nothing yet" from
   * "still connecting", which get an empty state and a loading skeleton respectively. */
  connected: boolean;
  /** AppFrame's own `<main>` — the one scrolling channel (§2) — shared via `mainRef` rather than
   * the feed nesting a second scroller inside it. */
  scrollElementRef: RefObject<HTMLElement | null>;
}

/** The centre column's body (§5): a two-line grid row per event, team-hue rails, batched arrival
 * motion, and follow-mode with a "▼ live" control to re-engage it once the operator has scrolled
 * away. Virtualized once the released feed passes VIRTUALIZE_ABOVE. */
export function ActivityFeed({ events, batchSize, ratePerSecond, connected, scrollElementRef }: ActivityFeedProps) {
  const [following, setFollowing] = useState(true);
  const shouldVirtualize = events.length > VIRTUALIZE_ABOVE;

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? events.length : 0,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
  });

  useEffect(() => {
    const element = scrollElementRef.current;
    if (element === null) return;
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      setFollowing(distance <= FOLLOW_THRESHOLD_PX);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [scrollElementRef]);

  useEffect(() => {
    if (!following) return;
    const element = scrollElementRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [events.length, following, scrollElementRef]);

  function goLive(): void {
    setFollowing(true);
    const element = scrollElementRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }

  if (events.length === 0) {
    return (
      <div className="px-4">
        {connected ? (
          <EmptyState
            title="No events yet"
            hint="Events appear here as the agent teams work, starting with the principal's first routing decision."
          />
        ) : (
          <SkeletonLines lines={6} className="py-4" />
        )}
      </div>
    );
  }

  const profile = entryMotion(batchSize, ratePerSecond);
  const newestFrom = Math.max(0, events.length - batchSize);

  return (
    <div className="relative">
      {shouldVirtualize ? (
        <ol
          aria-label="Activity feed"
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const event = events[virtualRow.index];
            if (event === undefined) return null;
            return (
              <VirtualFeedRow
                key={event.seq}
                event={event}
                setsize={events.length}
                posinset={virtualRow.index + 1}
                start={virtualRow.start}
                dataIndex={virtualRow.index}
                measureRef={virtualizer.measureElement}
              />
            );
          })}
        </ol>
      ) : (
        <ol aria-label="Activity feed" className="flex flex-col">
          {events.map((event, index) => {
            const isNew = index >= newestFrom;
            return (
              <AnimatedFeedRow
                key={event.seq}
                event={event}
                setsize={events.length}
                posinset={index + 1}
                animate={isNew}
                profile={profile}
                delayS={profile.staggerS * (index - newestFrom)}
              />
            );
          })}
        </ol>
      )}

      {following ? null : (
        <button
          type="button"
          onClick={goLive}
          className="sticky bottom-3 left-1/2 num inline-flex -translate-x-1/2 items-center gap-1.5 rounded-pill border border-line-control bg-surface-raised px-3 py-1.5 text-xs text-fg shadow-float"
        >
          <span aria-hidden="true">▼</span> live
        </button>
      )}
    </div>
  );
}
