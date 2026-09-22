import { useEvalResults } from "../api/queries";
import { PageFrame } from "../app/PageFrame";
import { QueryErrorState } from "../components/states/ErrorState";
import { SkeletonLines } from "../components/states/Skeleton";
import { formatMetric } from "../lib/format";

/** M9b: one line per eval result. The ablation table and its small-multiple charts
 * (docs/design-plan.md §6) arrive with M9e. The error state matters already: the API answers a
 * missing results file with "no eval results yet; run `make eval`", and shows it verbatim. */
export function EvalRoute() {
  const results = useEvalResults();

  return (
    <PageFrame title="eval results">
      {results.isPending && <SkeletonLines lines={6} />}
      {results.isError && <QueryErrorState error={results.error} title="No eval results to show" />}
      {results.isSuccess && (
        <ul className="flex flex-col divide-y divide-line-hairline">
          {results.data.map((row) => (
            <li
              key={`${row.dataset_ref}-${row.config}`}
              className="grid grid-cols-[1fr_1fr_auto] gap-4 py-2 text-sm"
            >
              <span className="text-fg">{row.dataset_ref}</span>
              <span className="text-fg-secondary">{row.config}</span>
              <span className="num text-fg">
                {row.primary_metric_value === null ? "none" : formatMetric(row.primary_metric_value)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PageFrame>
  );
}
