import type { TaskResult } from "../api/types";
import { formatMetric, formatUsd } from "../lib/format";

const COLUMNS = ["task", "metric", "value", "target", "target met", "cost", "wall time", "⊘", "stopped"] as const;

/** docs/design-plan.md §6's eval results hero: the M8 ablation harness's per-task table, dense
 * and numeric — mirrors foundry/eval/report.py's render_per_task_table column-for-column, so this
 * table and the README's committed one never read differently for the same results.json. Only the
 * `full` config: render_per_task_table's own `_by_config(results, "full")` filter. */
export function EvalTable({ results }: { results: readonly TaskResult[] }) {
  const full = results.filter((r) => r.config === "full");
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
          {full.map((row) => (
            <tr
              key={row.dataset_ref}
              className="border-b border-line-hairline transition-colors duration-(--dur-quick) ease-out last:border-b-0 hover:bg-surface-raised"
            >
              <td className="py-2 pr-3 text-fg">{row.dataset_ref}</td>
              <td className="py-2 pr-3 text-fg-secondary">{row.primary_metric_name}</td>
              <td className="num py-2 pr-3 text-fg">
                {row.primary_metric_value === null ? "—" : formatMetric(row.primary_metric_value)}
              </td>
              <td className="num py-2 pr-3 text-fg-secondary">{formatMetric(row.target_value)}</td>
              <td className="py-2 pr-3 text-fg">{row.target_met ? "yes" : "no"}</td>
              <td className="num py-2 pr-3 text-fg">{formatUsd(row.cost_total_usd)}</td>
              <td className="num py-2 pr-3 text-fg-secondary">{row.wall_time_s.toFixed(1)}s</td>
              <td className="num py-2 pr-3 text-fg">{row.n_invalidated === 0 ? "—" : row.n_invalidated}</td>
              <td className="py-2 pr-0 text-fg-secondary">{row.stop_reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
