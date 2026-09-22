import type { RunStatus } from "../api/types";
import { formatMetric } from "../lib/format";
import { extractHeadings } from "./headings";
import { LeaderboardChart } from "./LeaderboardChart";
import { Markdown } from "./Markdown";
import { ReportToc } from "./ReportToc";

/** docs/design-plan.md §6: "final report + model card as rendered markdown with plots ... single
 * centred column in Newsreader, 680px measure, sticky mini-TOC ... at 1100px and up." The TOC is
 * built from report_md's OWN `##` sections only — the model card is an appendix beneath it, not a
 * second indexed document. Shared by ReportRoute (a live run's own API-backed report) and
 * ReplayReportRoute (a recording's report, folded straight from its JSONL, no API involved). */
export function ReportBody({ status, reportMd }: { status: RunStatus; reportMd: string }) {
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
