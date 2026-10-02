import { Ban, Trophy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import type { LeaderboardEntry, RunStatus } from "../api/types";
import { EmptyState } from "../components/states/EmptyState";
import { Panel } from "../components/ui/Panel";
import { cn } from "../lib/cn";
import { formatMetric } from "../lib/format";
import { useAnimatedNumber } from "../lib/useAnimatedNumber";
import { WASH } from "../lib/wash";
import type { Choreography } from "./useInvalidationChoreography";

const GAIN_TINT_S = 0.6; // §7: "a row that gained rank gets a 600ms decaying tint on its left edge"

/** The panel's own DOM id — there is only ever one Leaderboard on screen, so a static id is safe.
 * AuditPanel's connector (§8) measures from here, since the vacated leaderboard slot itself
 * (the row that used to occupy it) is already gone by the time the connector draws. */
export const LEADERBOARD_PANEL_ID = "leaderboard-panel";

/** Ids whose rank improved on the render that just happened, for the 600ms edge tint. Diffs by
 * VALUE (each id's rank number), never by array identity — a replay frame is a freshly parsed
 * object every time even when nothing in it changed, so identity would fire constantly.
 *
 * The effect depends on `signature`, a string built from entries, rather than on `entries` itself.
 * `entries` is a fresh array every render (the caller re-sorts a copy each time), so depending on
 * it directly re-runs this effect on EVERY render — including the one `setGained` itself causes —
 * which cancels the fade timer this same effect just set and, finding no fresh gain to reschedule
 * it with, leaves the tint stuck on forever. `signature` only changes when a rank actually does.
 *
 * A rank gain landing on an id already mid-fade replaces it outright rather than merging the two
 * timers; overlapping gains within 600ms of each other are rare enough that restarting the fade is
 * an acceptable simplification here. */
function useRankGains(entries: readonly LeaderboardEntry[]): ReadonlySet<string> {
  const previousRanks = useRef<Map<string, number>>(new Map());
  const [gained, setGained] = useState<ReadonlySet<string>>(new Set());
  const signature = entries.map((entry) => `${entry.experiment_id}:${entry.rank}`).join("|");

  useEffect(() => {
    const previous = previousRanks.current;
    const next = new Set<string>();
    for (const entry of entries) {
      const before = previous.get(entry.experiment_id);
      if (before !== undefined && entry.rank < before) next.add(entry.experiment_id);
    }
    previousRanks.current = new Map(entries.map((entry) => [entry.experiment_id, entry.rank]));
    if (next.size === 0) return;
    setGained(next);
    const timer = setTimeout(() => setGained(new Set()), GAIN_TINT_S * 1000);
    return () => clearTimeout(timer);
    // `entries` is intentionally not a dependency here — see the comment above `signature`.
  }, [signature]);

  return gained;
}

/** Every table row is the full width of the panel and carries the action verb only in its
 * accessible name (§'s avoid-list: state the action, never decorate with "→") — the visible row
 * stays exactly the dense id/metric line it always was. `relative overflow-hidden` so the row's data
 * bar (below) sits inside the button and is clipped to its rounded corners. */
function RowButton({
  experimentId,
  children,
  onOpen,
}: {
  experimentId: string;
  children: ReactNode;
  onOpen: (experimentId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(experimentId)}
      aria-label={`Open experiment ${experimentId}`}
      className="relative -mx-2 flex w-full items-center gap-3 overflow-hidden rounded-control px-2 py-1 text-left transition-colors duration-(--dur-quick) ease-out hover:bg-surface-raised"
    >
      {children}
    </button>
  );
}

/** The rank, as a chip. #1 takes the brand's deep gradient — the one place the leaderboard says
 * "winner" — and everything below it a neutral raised chip. Ranks are a real ordering
 * (`LeaderboardEntry.rank`), so the numbers stay (the SPEC avoid-list's numbered-marker rule is about
 * content that is NOT a sequence). No team hue anywhere here (§3.1: "never in a table"). */
function RankChip({ rank }: { rank: number }) {
  return (
    <span
      className={cn(
        "num relative grid size-6 shrink-0 place-items-center rounded-chip text-xs font-semibold",
        rank === 1 ? "brand-fill-deep text-accent-contrast shadow-highlight" : "bg-surface-raised text-fg-secondary",
      )}
    >
      {rank}
    </span>
  );
}

function LeaderboardRow({
  entry,
  best,
  justGained,
  onOpen,
}: {
  entry: LeaderboardEntry;
  /** The top-ranked metric value, which the row's data bar is drawn relative to. */
  best: number;
  justGained: boolean;
  onOpen: (experimentId: string) => void;
}) {
  const value = useAnimatedNumber(entry.primary_metric_value);
  // A bar proportional to the metric as a share of the best one: an honest, scale-free reading that
  // makes sense for any metric the run optimises. Decoration only — the number beside it is the value.
  const share = best > 0 ? Math.min(1, Math.max(0, entry.primary_metric_value / best)) : 0;
  return (
    // §7: "380ms layout animation, --ease-in-out. Only moved rows animate" — `layout` is exactly
    // that: framer-motion animates a row's position only when it actually moves between renders.
    <motion.li
      layout
      transition={{ duration: 0.38, ease: [0.65, 0, 0.35, 1] }}
      className="relative border-b border-line-hairline py-1.5 last:border-b-0"
    >
      {justGained && (
        <motion.span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-0.5 bg-status-info"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: GAIN_TINT_S }}
        />
      )}
      <RowButton experimentId={entry.experiment_id} onOpen={onOpen}>
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-accent-soft"
          style={{ width: `${share * 100}%` }}
        />
        <RankChip rank={entry.rank} />
        <span className="num relative flex-1 truncate text-sm text-fg">{entry.experiment_id}</span>
        <span className="num relative text-sm font-medium text-fg">{formatMetric(value)}</span>
      </RowButton>
    </motion.li>
  );
}

/** §8's flag beat (0–200ms): "the invalidated experiment's leaderboard row loses its rank number
 * to ⊘; its metric strikes through and desaturates. The row does not leave yet." Rendered only
 * while the choreography holds this experiment in "flag" or "demote" — RunStatus.leaderboard has
 * ALREADY dropped it by then, so Leaderboard keeps the last real entry it saw (see `lastKnown`
 * below) purely to have something to show here. Wrapped in AnimatePresence by the caller so its
 * removal (once the choreography moves past "demote") plays the "animates out of the ranked list"
 * beat instead of vanishing instantly. */
function FlaggedRow({ entry }: { entry: LeaderboardEntry }) {
  return (
    <motion.li
      layout
      initial={false}
      exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
      transition={{ duration: 0.32, ease: [0.65, 0, 0.35, 1] }}
      className={cn("flex items-center gap-3 border-b border-line-hairline py-2 last:border-b-0", WASH.danger)}
    >
      {/* M9h: lucide's `Ban` is the same ⊘ mark the design plan names, as an icon; the sr-only word
          beside it is what carries "invalidated" to assistive tech. */}
      <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-chip bg-status-danger/15 text-status-danger">
        <Ban className="size-3.5" strokeWidth={2.5} />
      </span>
      <span className="sr-only">invalidated</span>
      <span className="num flex-1 truncate text-sm text-fg-muted line-through decoration-status-danger">
        {entry.experiment_id}
      </span>
      <span className="num text-sm text-fg-muted line-through decoration-status-danger">
        {formatMetric(entry.primary_metric_value)}
      </span>
    </motion.li>
  );
}

interface LeaderboardProps {
  status: RunStatus | null;
  /** From useInvalidationChoreography, shared with AuditPanel so both animate the SAME sequence
   * for the SAME finding — RunView calls the hook once and passes the result to both. */
  choreography: Choreography;
  onOpen: (experimentId: string) => void;
}

/** The dock's leaderboard panel (§5). `RunStatus.leaderboard` already excludes anything the red
 * team invalidated (foundry/leaderboard.py filters candidates before principal writes it to
 * state) — the transient flagged row above is the one deliberate exception, reconstructed
 * client-side for §8's choreography. */
export function Leaderboard({ status, choreography, onOpen }: LeaderboardProps) {
  const entries = status?.leaderboard ?? [];
  const sorted = [...entries].sort((a, b) => a.rank - b.rank);
  const gained = useRankGains(sorted);
  const metricName = sorted[0]?.primary_metric_name;

  // Lags exactly one commit behind `sorted` — the render where an invalidated entry FIRST
  // disappears (RunStatus.leaderboard and RunStatus.invalidations update together, in the same
  // payload) is the one render where this ref still holds the board WITH it, which is exactly
  // when the flag beat below needs it.
  const lastBoard = useRef<readonly LeaderboardEntry[]>([]);
  useEffect(() => {
    // No dependency array: this must run after EVERY render (not just when `sorted`'s own
    // reference changes) so it always lags the CURRENT render by exactly one commit.
    lastBoard.current = sorted;
  });

  const showFlagged = choreography.phase === "flag" || choreography.phase === "demote";
  const flaggedEntry =
    showFlagged && choreography.finding !== null
      ? lastBoard.current.find((entry) => entry.experiment_id === choreography.finding?.experiment_id)
      : undefined;

  // Positioned by ID against whichever sibling used to follow it, never by comparing rank NUMBERS
  // — the surviving siblings are already renumbered by the time this renders, so "rank > flagged's
  // old rank" would misplace it the moment more than one entry sits below the vacated slot.
  const insertAt =
    flaggedEntry === undefined
      ? -1
      : (() => {
          const oldIndex = lastBoard.current.findIndex((e) => e.experiment_id === flaggedEntry.experiment_id);
          const nextSiblingId = lastBoard.current[oldIndex + 1]?.experiment_id;
          const newIndex = sorted.findIndex((e) => e.experiment_id === nextSiblingId);
          return newIndex;
        })();
  const before = flaggedEntry === undefined ? sorted : sorted.slice(0, insertAt === -1 ? sorted.length : insertAt);
  const after = flaggedEntry === undefined ? [] : sorted.slice(insertAt === -1 ? sorted.length : insertAt);

  const best = sorted[0]?.primary_metric_value ?? 0;

  return (
    <Panel
      id={LEADERBOARD_PANEL_ID}
      title="leaderboard"
      icon={Trophy}
      meta={metricName === undefined ? undefined : metricName}
    >
      {sorted.length === 0 && flaggedEntry === undefined ? (
        <EmptyState
          title="No ranked experiments yet"
          hint="The leaderboard fills in once the modeling team's first experiment finishes and is audited."
        />
      ) : (
        <ol aria-label="Leaderboard" className="flex flex-col">
          <AnimatePresence>
            {before.map((entry) => (
              <LeaderboardRow
                key={entry.experiment_id}
                entry={entry}
                best={best}
                justGained={gained.has(entry.experiment_id)}
                onOpen={onOpen}
              />
            ))}
            {flaggedEntry !== undefined && <FlaggedRow key={flaggedEntry.experiment_id} entry={flaggedEntry} />}
            {after.map((entry) => (
              <LeaderboardRow
                key={entry.experiment_id}
                entry={entry}
                best={best}
                justGained={gained.has(entry.experiment_id)}
                onOpen={onOpen}
              />
            ))}
          </AnimatePresence>
        </ol>
      )}
    </Panel>
  );
}
