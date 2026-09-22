import { Link } from "react-router";

import { useRuns } from "../api/queries";
import { RunsTable } from "../app/RunsTable";
import { StartRunPanel } from "../app/StartRunPanel";
import { PageFrame } from "../app/PageFrame";
import { EmptyState } from "../components/states/EmptyState";
import { QueryErrorState } from "../components/states/ErrorState";
import { SkeletonLines } from "../components/states/Skeleton";
import { Panel } from "../components/ui/Panel";
import { DEMO_REPLAY, links } from "./routes";

/** docs/design-plan.md §6: a start-a-run panel docked above a dense runs table — deliberately not
 * a card grid, not a modal. */
export function RunsHomeRoute() {
  const runs = useRuns();

  return (
    <PageFrame title="runs">
      <StartRunPanel />

      <Panel title="recorded runs">
        <div className="flex flex-col gap-1">
          <Link to={links.replay(DEMO_REPLAY)} className="text-md font-medium text-fg underline">
            {DEMO_REPLAY}
          </Link>
          <p className="max-w-prose text-sm text-fg-secondary">
            The red team catching a booby-trapped dataset, recorded against the real Docker sandbox.
            It plays back without the API running.
          </p>
        </div>
      </Panel>

      <Panel title="live runs" meta={runs.data ? <span className="num">{runs.data.length}</span> : undefined}>
        {runs.isPending && <SkeletonLines lines={3} />}
        {runs.isError && (
          <QueryErrorState error={runs.error} title="Could not list runs" />
        )}
        {runs.isSuccess && runs.data.length === 0 && (
          <EmptyState
            title="No runs yet"
            hint="Pick a dataset above to start one, or open the recorded demo."
          />
        )}
        {runs.isSuccess && runs.data.length > 0 && <RunsTable runs={runs.data} />}
      </Panel>
    </PageFrame>
  );
}
