import { useId, useState } from "react";
import { useNavigate } from "react-router";

import { useDatasets, useStartRun } from "../api/queries";
import { links } from "../routes/routes";
import { Button } from "../components/ui/Button";
import { Panel } from "../components/ui/Panel";
import { Skeleton } from "../components/states/Skeleton";

const DEFAULT_BUDGET_USD = 20;
const inputClass =
  "min-h-11 rounded-control border border-line-control bg-surface-panel px-3 text-sm text-fg transition-colors duration-(--dur-quick) ease-out hover:border-accent frame:min-h-8";

/** docs/design-plan.md §6's start-a-run panel: a docked panel above the table, not a modal, with
 * three fields — dataset select (from the registry, `GET /datasets`), goal, budget. Submits via
 * the existing `useStartRun()` mutation (api/queries.ts) and lands the operator straight on the
 * new run's live view, the same screen the run's own activity feed opens onto. */
export function StartRunPanel() {
  const datasets = useDatasets();
  const startRun = useStartRun();
  const navigate = useNavigate();
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState(String(DEFAULT_BUDGET_USD));

  const datasetId = useId();
  const goalId = useId();
  const budgetId = useId();

  const selectedTask = taskKey ?? datasets.data?.[0]?.key;
  const selected = datasets.data?.find((d) => d.key === selectedTask);
  const budgetValue = Number(budget);
  const canSubmit = selectedTask !== undefined && Number.isFinite(budgetValue) && budgetValue > 0;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || selectedTask === undefined) return;
    startRun.mutate(
      { task: selectedTask, goal: goal.trim() === "" ? null : goal.trim(), budget_usd: budgetValue },
      { onSuccess: (response) => navigate(links.run(response.thread_id)) },
    );
  }

  return (
    <Panel title="start a run">
      {datasets.isPending && <Skeleton className="h-11 w-full" />}
      {datasets.isError && (
        <p className="text-sm text-status-danger">Could not load the dataset registry.</p>
      )}
      {datasets.isSuccess && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col flex-wrap gap-3 frame:flex-row frame:items-end">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={datasetId} className="text-xs text-fg-muted">
                dataset
              </label>
              <select
                id={datasetId}
                value={selectedTask ?? ""}
                onChange={(event) => setTaskKey(event.target.value)}
                className={inputClass}
              >
                {datasets.data.map((dataset) => (
                  <option key={dataset.key} value={dataset.key}>
                    {dataset.key}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-1 flex-col gap-1.5">
              <label htmlFor={goalId} className="text-xs text-fg-muted">
                goal
              </label>
              <input
                id={goalId}
                type="text"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder={selected === undefined ? "predict …" : `predict ${selected.name}`}
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={budgetId} className="text-xs text-fg-muted">
                budget
              </label>
              <input
                id={budgetId}
                type="number"
                min="0.01"
                step="0.01"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                className={`num w-28 ${inputClass}`}
              />
            </div>

            <Button type="submit" variant="primary" disabled={!canSubmit || startRun.isPending}>
              {startRun.isPending ? "Starting…" : "Start run"}
            </Button>
          </div>

          {selected !== undefined && (
            <p className="max-w-prose text-xs text-fg-muted">{selected.description}</p>
          )}
          {startRun.isError && (
            <p className="text-sm text-status-danger">{startRun.error.message}</p>
          )}
        </form>
      )}
    </Panel>
  );
}
