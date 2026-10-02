import { Check } from "lucide-react";
import type { ReactNode } from "react";

import type { ActivityEvent, RunStatus } from "../api/types";
import { formatUsdPrecise } from "../lib/format";
import { cn } from "../lib/cn";
import { costRows } from "../run/costByAgent";
import { derivePhases, deriveTeamProgress, type ProgressState } from "../run/phases";
import { TEAM_META, TEAM_ORDER } from "../run/teams";

/** A rail section title: sentence case, `--text-sm` semibold in `--text-secondary` (M9h, was 12px
 * muted), trailing into a hairline that fades out so the unboxed rail still reads as sections. */
function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="flex items-center gap-3 text-sm font-semibold tracking-tight text-fg-secondary after:h-px after:flex-1 after:bg-line-hairline">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The small state mark on a roster row — §3.1's status ramp (a different question, "what state",
 * from the team hue, "who acted"). Decorative: the sr-only state word beside it carries the meaning,
 * so no state is carried by an icon or a colour alone (WCAG 1.4.1). */
function StateMark({ state }: { state: ProgressState }) {
  if (state === "done") {
    return <Check aria-hidden="true" strokeWidth={2.75} className="size-4 shrink-0 text-status-ok" />;
  }
  if (state === "active") {
    return (
      <span
        aria-hidden="true"
        className="spin-arc size-3.5 shrink-0 rounded-pill border-2 border-status-info/25 border-t-status-info"
      />
    );
  }
  return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-pill bg-status-idle" />;
}

function ProgressGlyph({ state }: { state: ProgressState }) {
  return (
    <span className="inline-flex items-center gap-1">
      <StateMark state={state} />
      <span className="sr-only">{state}</span>
    </span>
  );
}

/** The phase stepper's disc: a gradient disc with a check once done, a spinning arc while active, a
 * hollow ring until reached. */
function PhaseDisc({ state }: { state: ProgressState }) {
  if (state === "done") {
    return (
      <span
        aria-hidden="true"
        className="brand-fill-deep grid size-6 shrink-0 place-items-center rounded-pill text-accent-contrast shadow-highlight"
      >
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span aria-hidden="true" className="relative grid size-6 shrink-0 place-items-center">
        <span className="absolute inset-0 rounded-pill border-2 border-status-info/25" />
        <span className="spin-arc absolute inset-0 rounded-pill border-2 border-transparent border-t-status-info" />
        <span className="size-1.5 rounded-pill bg-status-info" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-pill border border-line-strong">
      <span className="size-1.5 rounded-pill bg-status-idle" />
    </span>
  );
}

/** docs/design-plan.md §5, restyled M9h as a vertical stepper: a connector between rungs fills with
 * the brand gradient as each phase completes. The ladder is a genuine one-way pipeline order, so its
 * rungs stay a sequence (the numbered-marker rule in the SPEC avoid-list is about content that is
 * NOT a sequence). */
export function PhaseLadder({ events, status }: { events: readonly ActivityEvent[]; status: RunStatus | null }) {
  const phases = derivePhases(events, status);
  return (
    <RailSection title="phase">
      <ol className="flex flex-col">
        {phases.map((phase, index) => {
          const last = index === phases.length - 1;
          return (
            <li
              key={phase.id}
              className={cn("relative flex items-center gap-3 text-sm", !last && "pb-3")}
            >
              {last ? null : (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-[11px] top-6 w-0.5 overflow-hidden rounded-pill bg-line-hairline"
                >
                  <span
                    className={cn(
                      "brand-fill block h-full w-full origin-top transition-transform duration-(--dur-slow) ease-out",
                      phase.state === "done" ? "scale-y-100" : "scale-y-0",
                    )}
                  />
                </span>
              )}
              <PhaseDisc state={phase.state} />
              <span className={phase.state === "pending" ? "text-fg-muted" : "text-fg"}>{phase.label}</span>
              <span className="sr-only">{phase.state}</span>
            </li>
          );
        })}
      </ol>
    </RailSection>
  );
}

export function TeamRoster({ events, status }: { events: readonly ActivityEvent[]; status: RunStatus | null }) {
  const progress = deriveTeamProgress(events, status);
  return (
    <RailSection title="teams">
      <ol className="flex flex-col gap-0.5">
        {TEAM_ORDER.map((team) => {
          const meta = TEAM_META[team];
          const Icon = meta.Icon;
          const { state, count } = progress[team];
          return (
            <li
              key={team}
              className={cn(
                "-mx-2 flex items-center gap-2.5 rounded-control px-2 py-1 text-sm transition-colors duration-(--dur-base) ease-out",
                // Only the team working RIGHT NOW is washed: "who is acting" is the roster's one question.
                state === "active" && meta.wash,
              )}
            >
              <span aria-hidden="true" className={cn("grid size-6 shrink-0 place-items-center rounded-chip", meta.chip)}>
                <Icon className="size-3.5" strokeWidth={2.25} />
              </span>
              <span className={cn("flex-1", state === "pending" ? "text-fg-muted" : "text-fg-secondary")}>
                {meta.label}
              </span>
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
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-baseline justify-between gap-2 border-b border-line-hairline py-1.5 text-sm last:border-b-0"
          >
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
          <p className="rounded-control bg-accent-soft px-3 py-2 text-sm text-fg ring-1 ring-inset ring-accent-hover/20">
            {goal}
          </p>
        </RailSection>
      )}
      <PhaseLadder events={events} status={status} />
      <TeamRoster events={events} status={status} />
      <CostByTeam costByAgent={status?.cost_by_agent ?? {}} />
    </div>
  );
}
