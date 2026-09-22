import { useRef, useState, type ReactNode } from "react";

import type { ApprovalGate } from "../api/types";
import { ActivityFeed } from "../app/ActivityFeed";
import { AppFrame } from "../app/AppFrame";
import { BudgetMeter } from "../app/BudgetMeter";
import { InstrumentBar } from "../app/InstrumentBar";
import { Leaderboard } from "../app/Leaderboard";
import { MobileTabs, panelId, tabId, type Tab } from "../app/MobileTabs";
import { DivergenceNotice } from "../app/ReplayTransport";
import { RunRail } from "../app/RunRail";
import { TopBar, type Meta } from "../app/TopBar";
import { Button } from "../components/ui/Button";
import { LiveRegion } from "../components/ui/LiveRegion";
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
 * breakdown, the budget meter, and the leaderboard. What is still a raw stand-in — the gate dialogs
 * and the red-team finding — is M9d's. */
export function RunView({ goal, meta }: { goal?: string; meta: readonly Meta[] }) {
  const { source, state } = useRunSource();
  const feed = useEventFeed(state.events);
  const [tab, setTab] = useState<MobileTab>("activity");
  const mainRef = useRef<HTMLElement>(null);

  const status = state.status;
  const failed = status?.status === "failed";
  const gate = state.awaitingDecision ? status?.pending_approval : null;
  const hasNotices = state.divergence !== null || state.connection === "error" || failed || !!gate;
  const latest = state.events.at(-1)?.summary ?? "";
  const announcement = state.awaitingDecision
    ? `Approval needed: ${status?.pending_approval?.gate ?? "unknown"} gate`
    : latest;

  return (
    <AppFrame
      mobileView={tab === "activity" ? "main" : "dock"}
      mainRef={mainRef}
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
        <div className="flex flex-col gap-4">
          <div id={panelId("board")} className={cn("flex flex-col gap-4", tab === "audit" && "hidden frame:flex")}>
            <BudgetMeter status={status} />
            <Leaderboard status={status} />
          </div>
          {/* M9d's: the red-team finding, its evidence and remediation status. Left as a stand-in
              skeleton — the choreography that fills it (§8) is built together with this panel. */}
          <div id={panelId("audit")} className={cn(tab === "board" && "hidden frame:block")}>
            <Panel title="audit">
              <SkeletonLines lines={3} />
            </Panel>
          </div>
        </div>
      }
    >
      <div
        role="tabpanel"
        id={panelId("activity")}
        aria-labelledby={tabId("activity")}
        className="flex min-h-full flex-col"
      >
        <div className="flex items-baseline justify-between border-b border-line-hairline px-4 py-3">
          <h1 className="text-md font-medium text-fg">activity</h1>
          <span className="num text-xs text-fg-muted">{feed.visible.length} events</span>
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

          {gate && (
            <RawGate
              gate={gate.gate}
              reason={gate.reason}
              onDecide={(approved) =>
                void source.resume({
                  approved,
                  note: approved ? "approved in the operator console" : "rejected in the operator console",
                })
              }
            />
          )}
        </div>
        )}

        <ActivityFeed
          events={feed.visible}
          batchSize={feed.batchSize}
          ratePerSecond={feed.ratePerSecond}
          connected={state.connection === "open"}
          scrollElementRef={mainRef}
        />
      </div>

      <LiveRegion message={announcement} />
    </AppFrame>
  );
}

/** A deliberately raw stand-in for M9d's approval gates: it shows only what is needed to answer,
 * so a replay (or a live run) can be carried past a gate. The real gates — the de-energized deck,
 * the 400ms arm, Enter not submitting, a required rejection note — are M9d's, and are not
 * approximated here. */
function RawGate({
  gate,
  reason,
  onDecide,
}: {
  gate: ApprovalGate;
  reason: string;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <Panel title={`${gate} gate`} meta="waiting for you">
      <div className="flex flex-col gap-4">
        <p className="max-w-prose text-sm text-fg-secondary">{reason}</p>
        <div className="flex gap-3">
          <Button onClick={() => onDecide(false)}>Reject</Button>
          <Button onClick={() => onDecide(true)}>Approve</Button>
        </div>
      </div>
    </Panel>
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
