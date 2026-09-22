import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { AuditPanel } from "../app/AuditPanel";
import { ActivityFeed } from "../app/ActivityFeed";
import { AppFrame } from "../app/AppFrame";
import { BudgetMeter } from "../app/BudgetMeter";
import { ExperimentDrawer } from "../app/ExperimentDrawer";
import { GATE_HERO_LAYOUT_ID, GateDialog } from "../app/GateDialog";
import { InstrumentBar } from "../app/InstrumentBar";
import { InvalidationConnector } from "../app/InvalidationConnector";
import { Leaderboard } from "../app/Leaderboard";
import { MobileTabs, panelId, tabId, type Tab } from "../app/MobileTabs";
import { DivergenceNotice } from "../app/ReplayTransport";
import { RunRail } from "../app/RunRail";
import { TopBar, type Meta } from "../app/TopBar";
import { useInvalidationChoreography } from "../app/useInvalidationChoreography";
import { LiveRegion } from "../components/ui/LiveRegion";
import { Button } from "../components/ui/Button";
import { Panel } from "../components/ui/Panel";
import { ErrorState } from "../components/states/ErrorState";
import { Skeleton, SkeletonLines } from "../components/states/Skeleton";
import { cn } from "../lib/cn";
import { useRunSource } from "../run/RunSourceContext";
import { useEventFeed } from "../run/useEventFeed";

type MobileTab = "activity" | "board" | "audit";

const TABS: readonly Tab<MobileTab>[] = [
  { id: "activity", label: "activity" },
  { id: "board", label: "board" },
  { id: "audit", label: "audit" },
];

/** The view a run is watched through — live or replayed. It reads RunSourceState and nothing else,
 * which is the whole point: it has no idea which kind of source it has, and must not.
 *
 * M9b built the FRAME and proved the source streams through it. M9c filled it with the real
 * instruments: the feed's team rails and two-line rows, the rail's phase ladder/team roster/cost
 * breakdown, the budget meter, and the leaderboard. M9d built the last two SPEC screens this view
 * owns: the approval gates (GateDialog) and the red-team finding (AuditPanel, §8's choreography,
 * the leaderboard's flag/demote beats, the connector), plus the experiment drawer. M9f added the
 * last leg of SPEC's own verification path: a "View report" link once `report_md` exists, to
 * wherever the caller's `reportHref` points (a live run's API-backed report, or a replay's own,
 * folded straight from its recording — see LiveRunRoute.tsx / ReplayRoute.tsx). */
export function RunView({
  goal,
  meta,
  reportHref,
}: {
  goal?: string;
  meta: readonly Meta[];
  /** Set once the run/replay has produced a report — see the "View report" link below. Absent for
   * routes with nowhere to send it (there is none today, but RunView shouldn't assume one exists). */
  reportHref?: string;
}) {
  const { source, state } = useRunSource();
  const feed = useEventFeed(state.events);
  const [tab, setTab] = useState<MobileTab>("activity");
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  const status = state.status;
  const failed = status?.status === "failed";
  const gate = state.awaitingDecision ? status?.pending_approval : null;
  const hasNotices = state.divergence !== null || state.connection === "error" || failed || !!gate;
  const latest = state.events.at(-1)?.summary ?? "";
  const announcement = state.awaitingDecision
    ? `Approval needed: ${status?.pending_approval?.gate ?? "unknown"} gate`
    : latest;

  // A gate always wins: if one becomes pending while the drawer is open (a replay auto-advances
  // to the final gate while the operator is still reading an experiment, say), close the drawer
  // rather than leave two Radix dialogs mounted at once — their portals collide, each one's own
  // overlay can intercept clicks meant for the other's content, and the gate is the one decision
  // that must always stay answerable (CLAUDE.md: "both interrupt() gates are real... never
  // skipped").
  useEffect(() => {
    if (gate) setSelectedExperimentId(null);
  }, [gate]);

  const choreography = useInvalidationChoreography(status?.invalidations ?? []);
  const selectedExperiment = useMemo(
    () => status?.experiments.find((e) => e.experiment_id === selectedExperimentId) ?? null,
    [status, selectedExperimentId],
  );
  const selectedPrimaryMetric = status?.leaderboard.find((e) => e.experiment_id === selectedExperimentId)
    ?.primary_metric_name;

  return (
    <AppFrame
      mobileView={tab === "activity" ? "main" : "dock"}
      mainRef={mainRef}
      deenergized={Boolean(gate)}
      topBar={
        <TopBar
          meta={meta}
          status={status?.status ?? null}
          connection={state.connection}
          mode={state.mode}
          transport
        />
      }
      instrument={
        <InstrumentBar
          status={status?.status ?? null}
          spentUsd={status?.spent_usd ?? 0}
          budgetUsd={status?.budget_usd ?? 0}
          connection={state.connection}
          mode={state.mode}
        />
      }
      tabs={<MobileTabs tabs={TABS} active={tab} onChange={setTab} label="Run view" />}
      rail={<RunRail {...(goal === undefined ? {} : { goal })} events={state.events} status={status} />}
      dock={
        <div ref={dockRef} className="relative flex flex-col gap-4">
          <div id={panelId("board")} className={cn("flex flex-col gap-4", tab === "audit" && "hidden frame:flex")}>
            <BudgetMeter status={status} {...(gate?.gate === "budget" ? {} : { heroLayoutId: GATE_HERO_LAYOUT_ID })} />
            <Leaderboard status={status} choreography={choreography} onOpen={setSelectedExperimentId} />
          </div>
          <div id={panelId("audit")} className={cn(tab === "board" && "hidden frame:block")}>
            <AuditPanel status={status} choreography={choreography} onOpen={setSelectedExperimentId} />
          </div>
          <InvalidationConnector containerRef={dockRef} choreography={choreography} />
        </div>
      }
    >
      <div
        role="tabpanel"
        id={panelId("activity")}
        aria-labelledby={tabId("activity")}
        className="flex min-h-full flex-col"
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-line-hairline px-4 py-3">
          <h1 className="text-md font-medium text-fg">activity</h1>
          <div className="flex items-baseline gap-3">
            {reportHref !== undefined && status !== null && status.report_md !== null && (
              <Button asChild variant="quiet">
                <Link to={reportHref}>View report</Link>
              </Button>
            )}
            <span className="num text-xs text-fg-muted">{feed.visible.length} events</span>
          </div>
        </div>

        {hasNotices && (
        <div className="flex flex-col gap-4 p-4">
          <DivergenceNotice divergence={state.divergence} />

          {state.connection === "error" && (
            <ErrorState
              title="The event stream failed"
              detail={state.error ?? "The stream closed without a reason."}
              fix="Check that this run exists and that the API is running (`make api`)."
            />
          )}
          {failed && (
            <ErrorState title="The run failed" detail={status?.error ?? "The run reported no error message."} />
          )}

        </div>
        )}

        <ActivityFeed
          events={feed.visible}
          batchSize={feed.batchSize}
          ratePerSecond={feed.ratePerSecond}
          connected={state.connection === "open"}
          scrollElementRef={mainRef}
          holdFollow={Boolean(gate)}
        />
      </div>

      {gate && <GateDialog gate={gate} onDecide={(decision) => void source.resume(decision)} />}

      {selectedExperiment && (
        <ExperimentDrawer
          key={selectedExperiment.experiment_id}
          experiment={selectedExperiment}
          {...(selectedPrimaryMetric === undefined ? {} : { primaryMetricName: selectedPrimaryMetric })}
          onClose={() => setSelectedExperimentId(null)}
        />
      )}

      <LiveRegion message={announcement} />
    </AppFrame>
  );
}

/** The frame with placeholders, for while a recording loads or if it cannot be loaded. It is the
 * SAME AppFrame as RunView — same rail, centre and dock — so nothing reflows when data arrives
 * (docs/design-plan.md §9: skeletons that match the real layout). */
export function RunViewSkeleton({ error }: { error?: ReactNode }) {
  return (
    <AppFrame
      topBar={<TopBar />}
      rail={
        <div className="flex flex-col gap-6">
          <Skeleton className="h-10" />
          <SkeletonLines lines={5} />
          <SkeletonLines lines={6} />
        </div>
      }
      dock={
        <div className="flex flex-col gap-4">
          <BudgetMeter status={null} />
          <Panel title="leaderboard">
            <SkeletonLines lines={4} />
          </Panel>
          <Panel title="audit">
            <SkeletonLines lines={3} />
          </Panel>
        </div>
      }
    >
      <div className="flex min-h-full flex-col">
        <div className="flex items-baseline justify-between border-b border-line-hairline px-4 py-3">
          <h1 className="text-md font-medium text-fg">activity</h1>
        </div>
        <div className="p-4">{error ?? <SkeletonLines lines={8} />}</div>
      </div>
    </AppFrame>
  );
}
