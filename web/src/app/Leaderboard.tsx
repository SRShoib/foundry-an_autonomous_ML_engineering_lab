import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

import type { LeaderboardEntry, RunStatus } from "../api/types";
import { EmptyState } from "../components/states/EmptyState";
import { Panel } from "../components/ui/Panel";
import { formatMetric } from "../lib/format";
import { useAnimatedNumber } from "../lib/useAnimatedNumber";

const GAIN_TINT_S = 0.6; // §7: "a row that gained rank gets a 600ms decaying tint on its left edge"

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

function LeaderboardRow({ entry, justGained }: { entry: LeaderboardEntry; justGained: boolean }) {
  const value = useAnimatedNumber(entry.primary_metric_value);
  return (
    // §7: "380ms layout animation, --ease-in-out. Only moved rows animate" — `layout` is exactly
    // that: framer-motion animates a row's position only when it actually moves between renders.
    <motion.li
      layout
      transition={{ duration: 0.38, ease: [0.65, 0, 0.35, 1] }}
      className="relative flex items-baseline gap-3 border-b border-line-hairline py-2 last:border-b-0"
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
      <span className="num w-5 text-sm text-fg-muted">{entry.rank}</span>
      {/* No team hue anywhere here — §3.1: "never in a table". */}
      <span className="num flex-1 truncate text-sm text-fg">{entry.experiment_id}</span>
      <span className="num text-sm text-fg">{formatMetric(value)}</span>
    </motion.li>
  );
}

/** The dock's leaderboard panel (§5). Ranked entries only: `RunStatus.leaderboard` already excludes
 * anything the red team invalidated (foundry/leaderboard.py filters candidates before principal
 * writes it to state), and the invalidated-row treatment plus §8's choreography are M9d's — built
 * together with the audit panel they land in, not approximated here. */
export function Leaderboard({ status }: { status: RunStatus | null }) {
  const entries = status?.leaderboard ?? [];
  const sorted = [...entries].sort((a, b) => a.rank - b.rank);
  const gained = useRankGains(sorted);
  const metricName = sorted[0]?.primary_metric_name;

  return (
    <Panel title="leaderboard" meta={metricName === undefined ? undefined : metricName}>
      {sorted.length === 0 ? (
        <EmptyState
          title="No ranked experiments yet"
          hint="The leaderboard fills in once the modeling team's first experiment finishes and is audited."
        />
      ) : (
        <ol aria-label="Leaderboard" className="flex flex-col">
          {sorted.map((entry) => (
            <LeaderboardRow key={entry.experiment_id} entry={entry} justGained={gained.has(entry.experiment_id)} />
          ))}
        </ol>
      )}
    </Panel>
  );
}
