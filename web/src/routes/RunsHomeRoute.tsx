import { Link } from "react-router";

import { useRuns } from "../api/queries";
import { RunStatusPill } from "../app/StatusPills";
import { PageFrame } from "../app/PageFrame";
import { EmptyState } from "../components/states/EmptyState";
import { QueryErrorState } from "../components/states/ErrorState";
import { SkeletonLines } from "../components/states/Skeleton";
import { Panel } from "../components/ui/Panel";
import { formatUsd, shortId } from "../lib/format";
import { DEMO_REPLAY, links } from "./routes";

/** M9b: the runs list is a plain list with real loading, empty and error states. The dense table
 * and the start-a-run panel of docs/design-plan.md §6 arrive with M9e. */
export function RunsHomeRoute() {
  const runs = useRuns();

  return (
    <PageFrame title="runs">
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
            hint="Start one with POST /runs on the API. The console's own start form arrives with the runs home screen."
          />
        )}
        {runs.isSuccess && runs.data.length > 0 && (
          <ul className="flex flex-col divide-y divide-line-hairline">
            {runs.data.map((run) => (
              <li key={run.thread_id} className="flex items-center justify-between gap-4 py-2">
                <Link to={links.run(run.thread_id)} className="num text-sm text-fg underline">
                  {shortId(run.thread_id)}
                </Link>
                <RunStatusPill status={run.status} />
                <span className="num text-sm text-fg-secondary">{formatUsd(run.spent_usd)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PageFrame>
  );
}
