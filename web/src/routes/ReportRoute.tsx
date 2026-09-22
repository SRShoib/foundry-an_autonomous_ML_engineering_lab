import { Link, useParams } from "react-router";

import type { RunStatus } from "../api/types";
import { useRun } from "../api/queries";
import { PageFrame } from "../app/PageFrame";
import { EmptyState } from "../components/states/EmptyState";
import { QueryErrorState } from "../components/states/ErrorState";
import { SkeletonLines } from "../components/states/Skeleton";
import { Button } from "../components/ui/Button";
import { formatMetric, shortId } from "../lib/format";
import { extractHeadings } from "../report/headings";
import { LeaderboardChart } from "../report/LeaderboardChart";
import { Markdown } from "../report/Markdown";
import { ReportToc } from "../report/ReportToc";
import { links } from "./routes";

/** docs/design-plan.md §6: "final report + model card as rendered markdown with plots ... single
 * centred column in Newsreader, 680px measure, sticky mini-TOC ... at 1100px and up." The TOC is
 * built from report_md's OWN `##` sections only — the model card is an appendix beneath it, not a
 * second indexed document. */
function ReportBody({ status, reportMd }: { status: RunStatus; reportMd: string }) {
  const headings = extractHeadings(reportMd);
  const best = [...status.leaderboard].sort((a, b) => a.rank - b.rank)[0];

  return (
    <div className="flex gap-8">
      <ReportToc headings={headings} />
      <div className="min-w-0 flex-1">
        {best !== undefined && (
          <div className="mb-2">
            <p className="num text-display text-fg">{formatMetric(best.primary_metric_value)}</p>
            <p className="text-xs text-fg-muted">
              {best.primary_metric_name} · {best.experiment_id}
            </p>
          </div>
        )}
        <LeaderboardChart leaderboard={status.leaderboard} />
        <Markdown>{reportMd}</Markdown>
        {status.model_card_md !== null && (
          <>
            <hr className="my-8 max-w-[42.5rem] border-line-hairline" />
            <Markdown>{status.model_card_md}</Markdown>
          </>
        )}
      </div>
    </div>
  );
}

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
        <ReportBody status={run.data} reportMd={run.data.report_md} />
      )}
    </PageFrame>
  );
}
