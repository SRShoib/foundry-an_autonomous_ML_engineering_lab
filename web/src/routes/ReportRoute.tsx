import { Link, useParams } from "react-router";

import { useRun } from "../api/queries";
import { PageFrame } from "../app/PageFrame";
import { EmptyState } from "../components/states/EmptyState";
import { QueryErrorState } from "../components/states/ErrorState";
import { SkeletonLines } from "../components/states/Skeleton";
import { Button } from "../components/ui/Button";
import { shortId } from "../lib/format";
import { links } from "./routes";

/** M9b: the report as preformatted text. Rendered markdown, the plots and the sticky table of
 * contents (docs/design-plan.md §6, in Newsreader) arrive with M9e. */
export function ReportRoute() {
  const { threadId = "" } = useParams();
  const run = useRun(threadId);

  return (
    <PageFrame title={`report for run ${shortId(threadId)}`}>
      {run.isPending && <SkeletonLines lines={8} />}
      {run.isError && <QueryErrorState error={run.error} title="Could not load this run" />}
      {run.isSuccess && run.data.report_md === null && (
        <EmptyState
          title="No report yet"
          hint="The reporter drafts it once the experiments have finished and the red team has audited them."
          action={
            <Button asChild>
              <Link to={links.run(threadId)}>Open the run</Link>
            </Button>
          }
        />
      )}
      {run.isSuccess && run.data.report_md !== null && (
        <pre className="whitespace-pre-wrap font-mono text-sm text-fg">{run.data.report_md}</pre>
      )}
    </PageFrame>
  );
}
