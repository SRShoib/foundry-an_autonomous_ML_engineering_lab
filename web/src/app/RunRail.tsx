import type { ReactNode } from "react";

import type { ActivityEvent, RunStatus } from "../api/types";
import { formatUsdPrecise } from "../lib/format";
import { cn } from "../lib/cn";
import { costRows } from "../run/costByAgent";
import { derivePhases, deriveTeamProgress, type ProgressState } from "../run/phases";
import { TEAM_META, TEAM_ORDER } from "../run/teams";

/** §3.1's status ramp — a different question ("what state") from the team hue ("who acted"), so a
 * phase or roster row's progress glyph never borrows a team colour. */
const STATE_TONE: Record<ProgressState, string> = {
  done: "text-status-ok",
  active: "text-status-info",
  pending: "text-status-idle",
};
const STATE_GLYPH: Record<ProgressState, string> = { done: "✓", active: "◐", pending: "·" };

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-medium text-fg-muted">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** aria-hidden progress glyph plus an always-visible label, so the state is never carried by colour
 * or glyph alone (WCAG 1.4.1) — and an sr-only word spells the state out for assistive tech, which
 * neither the glyph nor the bare label name says on its own. */
function ProgressGlyph({ state }: { state: ProgressState }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden="true" className={cn("text-sm", STATE_TONE[state])}>
        {STATE_GLYPH[state]}
      </span>
      <span className="sr-only">{state}</span>
    </span>
  );
}

export function PhaseLadder({ events, status }: { events: readonly ActivityEvent[]; status: RunStatus | null }) {
  const phases = derivePhases(events, status);
  return (
    <RailSection title="phase">
      <ol className="flex flex-col gap-1.5">
        {phases.map((phase) => (
          <li key={phase.id} className="flex items-center justify-between gap-2 text-sm text-fg-secondary">
            <span>{phase.label}</span>
            <ProgressGlyph state={phase.state} />
          </li>
        ))}
      </ol>
    </RailSection>
  );
}

export function TeamRoster({ events, status }: { events: readonly ActivityEvent[]; status: RunStatus | null }) {
  const progress = deriveTeamProgress(events, status);
  return (
    <RailSection title="teams">
      <ol className="flex flex-col gap-1.5">
        {TEAM_ORDER.map((team) => {
          const meta = TEAM_META[team];
          const { state, count } = progress[team];
          return (
            <li key={team} className="flex items-center gap-2 text-sm">
              <span aria-hidden="true" className={cn("text-xs", meta.text)}>
                {meta.glyph}
              </span>
              <span className="flex-1 text-fg-secondary">{meta.label}</span>
              {count === undefined ? null : <span className="num text-xs text-fg-muted">{count}</span>}
              <ProgressGlyph state={state} />
            </li>
          );
        })}
      </ol>
    </RailSection>
  );
}

export function CostByTeam({ costByAgent }: { costByAgent: Record<string, number> }) {
  const rows = costRows(costByAgent);
  return (
    <RailSection title="cost by team">
      <dl className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.id} className="flex items-baseline justify-between gap-2 text-sm">
            <dt className="text-fg-secondary">{row.label}</dt>
            {/* 4dp: the sandbox role's total is fractions of a cent (the demo recording's real
                total is $0.000371), and 2dp would render every one of its rows as a useless $0.00. */}
            <dd className="num text-fg">{formatUsdPrecise(row.usd)}</dd>
          </div>
        ))}
      </dl>
    </RailSection>
  );
}

export interface RunRailProps {
  /** Known for a replay (the header carries it) and unknown for a live run (RunStatus carries
   * neither goal nor dataset — a declined M9b addition; see the M9c plan's "known gap"). Nothing is
   * invented when it is absent. */
  goal?: string;
  events: readonly ActivityEvent[];
  status: RunStatus | null;
}

/** The rail's full contents (docs/design-plan.md §5): goal, phase ladder, team roster, cost by
 * team. Plain sections, not `Panel`s — in the mock only the DOCK's budget/leaderboard/audit are
 * bordered panels; the rail is one continuous, unboxed column, which `AppFrame`'s `aside` already
 * labels as "Run summary". */
export function RunRail({ goal, events, status }: RunRailProps) {
  return (
    <div className="flex flex-col gap-6">
      {goal === undefined ? null : (
        <RailSection title="goal">
          <p className="text-sm text-fg">{goal}</p>
        </RailSection>
      )}
      <PhaseLadder events={events} status={status} />
      <TeamRoster events={events} status={status} />
      <CostByTeam costByAgent={status?.cost_by_agent ?? {}} />
    </div>
  );
}
