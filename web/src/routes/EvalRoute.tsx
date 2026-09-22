import type { TaskResult } from "../api/types";
import { useEvalResults } from "../api/queries";
import { PageFrame } from "../app/PageFrame";
import { QueryErrorState } from "../components/states/ErrorState";
import { SkeletonLines } from "../components/states/Skeleton";
import { Panel } from "../components/ui/Panel";
import { AblationChart } from "../eval/AblationChart";
import {
  memoryAblation,
  modelSplitAblation,
  monolithAblation,
  redTeamAblation,
  type AblationGroup,
} from "../eval/ablations";
import { EvalTable } from "../eval/EvalTable";

/** docs/design-plan.md §6: "the M8 ablation table as the hero, dense and numeric. Charts are small
 * multiples, one compact chart per ablation, rather than one large combined chart." */
function AblationPanel({ title, groups }: { title: string; groups: AblationGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <Panel title={title}>
      <AblationChart groups={groups} />
    </Panel>
  );
}

function MemoryPanel({ results }: { results: readonly TaskResult[] }) {
  const comparisons = memoryAblation(results);
  if (comparisons.length === 0) return null;
  return (
    <Panel title="ablation: memory on/off">
      <ul className="flex flex-col divide-y divide-line-hairline text-sm">
        {comparisons.map((row) => (
          <li key={row.dataset} className="flex items-center justify-between gap-4 py-2">
            <span className="text-fg">{row.dataset}</span>
            <span className="text-fg-secondary">
              run #1 planned <span className="num">{row.firstFamilyRun1 ?? "—"}</span>, run #2{" "}
              <span className="num">{row.firstFamilyRun2 ?? "—"}</span>
            </span>
            <span className={row.differs ? "text-status-info" : "text-fg-muted"}>
              {row.differs ? "differs" : "same"}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function EvalRoute() {
  const results = useEvalResults();

  return (
    <PageFrame title="eval results">
      {results.isPending && <SkeletonLines lines={6} />}
      {results.isError && <QueryErrorState error={results.error} title="No eval results to show" />}
      {results.isSuccess && (
        <>
          <Panel title="per-task results" meta={<span className="num">{results.data.length} rows</span>}>
            <EvalTable results={results.data} />
          </Panel>
          <AblationPanel title="ablation: red team on/off" groups={redTeamAblation(results.data)} />
          <MemoryPanel results={results.data} />
          <AblationPanel
            title="ablation: multi-agent vs. monolithic"
            groups={monolithAblation(results.data)}
          />
          <AblationPanel title="ablation: model split vs. uniform" groups={modelSplitAblation(results.data)} />
        </>
      )}
    </PageFrame>
  );
}
