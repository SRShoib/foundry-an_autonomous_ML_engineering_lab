import { useState, type ReactNode } from "react";

import type { ApprovalGate } from "../api/types";
import { AppFrame } from "../app/AppFrame";
import { InstrumentBar } from "../app/InstrumentBar";
import { MobileTabs, panelId, tabId, type Tab } from "../app/MobileTabs";
import { DivergenceNotice } from "../app/ReplayTransport";
import { TopBar, type Meta } from "../app/TopBar";
import { Button } from "../components/ui/Button";
import { LiveRegion } from "../components/ui/LiveRegion";
import { Panel } from "../components/ui/Panel";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { Skeleton, SkeletonLines } from "../components/states/Skeleton";
import { cn } from "../lib/cn";
import { formatUsd } from "../lib/format";
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
 * M9b builds the FRAME and proves the source streams through it. What sits inside the frame is
 * deliberately raw and is replaced stage by stage: the feed rows and team rails (M9c), the phase
 * ladder, budget meter and leaderboard (M9c), the approval dialogs and red-team alert (M9d). */
export function RunView({ meta }: { meta: readonly Meta[] }) {
  const { source, state } = useRunSource();
  const feed = useEventFeed(state.events);
  const [tab, setTab] = useState<MobileTab>("activity");

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
      rail={
        <div className="flex flex-col gap-6">
          <Skeleton className="h-10" />
          <SkeletonLines lines={5} />
          <SkeletonLines lines={6} />
        </div>
      }
      dock={
        <div className="flex flex-col gap-4">
          <div id={panelId("board")} className={cn("flex flex-col gap-4", tab === "audit" && "hidden frame:flex")}>
            <Panel
              title="budget"
              meta={status ? <span className="num">{formatUsd(status.budget_usd)}</span> : undefined}
            >
              {status ? (
                <p className="num text-xl text-fg">{formatUsd(status.spent_usd)}</p>
              ) : (
                <Skeleton className="h-8 w-24" />
              )}
            </Panel>
            <Panel title="leaderboard">
              <SkeletonLines lines={4} />
            </Panel>
          </div>
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

        {/* M9c replaces this raw list with the real feed: team rails, two-line rows, virtualization. */}
        {feed.visible.length === 0 ? (
          <div className="px-4">
            {state.connection === "open" ? (
              <EmptyState
                title="No events yet"
                hint="Events appear here as the agent teams work, starting with the principal's first routing decision."
              />
            ) : (
              <SkeletonLines lines={6} className="py-4" />
            )}
          </div>
        ) : (
          <ol aria-label="Activity feed" className="flex flex-col">
            {feed.visible.map((event) => (
              <li
                key={event.seq}
                className="grid grid-cols-[3rem_1fr] gap-3 border-b border-line-hairline px-4 py-2"
              >
                <span className="num text-xs text-fg-muted">{String(event.seq).padStart(3, "0")}</span>
                <span className="text-sm text-fg">{event.summary}</span>
              </li>
            ))}
          </ol>
        )}
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
          <Panel title="budget">
            <Skeleton className="h-8 w-24" />
          </Panel>
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
