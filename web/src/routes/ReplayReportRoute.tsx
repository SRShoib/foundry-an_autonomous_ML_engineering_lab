import { Link, useParams } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { PageFrame } from "../app/PageFrame";
import { EmptyState } from "../components/states/EmptyState";
import { QueryErrorState } from "../components/states/ErrorState";
import { SkeletonLines } from "../components/states/Skeleton";
import { Button } from "../components/ui/Button";
import { shortId } from "../lib/format";
import { foldFrames } from "../replay/fold";
import { loadReplay } from "../replay/loadReplay";
import { ReportBody } from "../report/ReportBody";
import { links } from "./routes";

/** The replay twin of ReportRoute: same layout and states, but the report comes straight out of the
 * recording's own JSONL (foldFrames, the same reconstruction ReplayRoute's player uses) rather than
 * the live API — so it renders with the API stopped, exactly like the rest of replay mode. */
export function ReplayReportRoute() {
  const { name = "" } = useParams();
  const replay = useQuery({
    queryKey: ["replay", name],
    queryFn: ({ signal }) => loadReplay(name, fetch, signal),
    staleTime: Infinity,
    retry: false,
  });

  return (
    <PageFrame title={`report for ${shortId(name)}`}>
      {replay.isPending && <SkeletonLines lines={8} />}
      {replay.isError && <QueryErrorState error={replay.error} title="Could not load this recording" />}
      {replay.isSuccess && (() => {
        const status = foldFrames(replay.data.frames).at(-1);
        return status === undefined || status.report_md === null ? (
          <EmptyState
            title="No report yet"
            hint="The reporter drafts it once the experiments have finished and the red team has audited them."
            action={
              <Button asChild>
                <Link to={links.replay(name)}>Open the run</Link>
              </Button>
            }
          />
        ) : (
          <ReportBody status={status} reportMd={status.report_md} />
        );
      })()}
    </PageFrame>
  );
}
