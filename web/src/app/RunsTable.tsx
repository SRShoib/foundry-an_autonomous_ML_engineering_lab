import { Link } from "react-router";

import type { RunStatus } from "../api/types";
import { links } from "../routes/routes";
import { formatAge, formatMetric, formatUsd } from "../lib/format";
import { invalidatedFindings } from "../run/invalidations";
import { InlineMeter } from "./InlineMeter";
import { RunStatusPill } from "./StatusPills";

const COLUMNS = ["status", "dataset", "goal", "spend", "best", "⊘", "stopped", "updated"] as const;

/** docs/design-plan.md §6's runs-home table: a dense table, deliberately not a card grid. Pure and
 * data-only — loading, empty and error states stay in routes/RunsHomeRoute.tsx, the same split
 * ExperimentDrawer.tsx uses against its route's useExperiments(). */
export function RunsTable({ runs }: { runs: readonly RunStatus[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-hairline text-left text-xs text-fg-muted">
            {COLUMNS.map((column) => (
              <th key={column} scope="col" className="py-2 pr-3 font-normal last:pr-0">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const best = run.leaderboard[0];
            const invalidatedCount = invalidatedFindings(run.invalidations).length;
            return (
              <tr key={run.thread_id} className="border-b border-line-hairline last:border-b-0">
                <td className="py-2 pr-3">
                  <RunStatusPill status={run.status} />
                </td>
                <td className="py-2 pr-3 text-fg">{run.dataset_ref ?? "—"}</td>
                <td className="max-w-64 truncate py-2 pr-3" title={run.goal ?? undefined}>
                  <Link to={links.run(run.thread_id)} className="text-fg-secondary underline">
                    {run.goal ?? "—"}
                  </Link>
                </td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <InlineMeter spent={run.spent_usd} cap={run.budget_usd} />
                    <span className="num whitespace-nowrap text-fg-secondary">
                      {formatUsd(run.spent_usd)}
                    </span>
                  </div>
                </td>
                <td className="num py-2 pr-3 text-fg">
                  {best === undefined ? "—" : formatMetric(best.primary_metric_value)}
                </td>
                <td className="num py-2 pr-3 text-fg">{invalidatedCount === 0 ? "—" : invalidatedCount}</td>
                <td className="py-2 pr-3 text-fg-secondary">{run.stop_reason ?? "—"}</td>
                <td className="num py-2 pr-0 text-fg-muted">{formatAge(run.updated_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
