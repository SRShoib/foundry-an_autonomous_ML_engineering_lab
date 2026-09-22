import type { TaskResult } from "../api/types";

/** Mirrors foundry/eval/report.py's `_by_config`: one TaskResult per dataset_ref for a given
 * `config`, keyed for the same "only datasets present in both configs" pairing every ablation
 * function below performs. */
function byConfig(results: readonly TaskResult[], config: string): Map<string, TaskResult> {
  return new Map(results.filter((r) => r.config === config).map((r) => [r.dataset_ref, r]));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export interface AblationGroup {
  category: string;
  series: readonly { label: string; value: number }[];
}

/** SPEC ablation "red team on/off": full (audited) vs no_red_team, per dataset's primary metric.
 * Mirrors render_red_team_table's config pair and dataset filter exactly. */
export function redTeamAblation(results: readonly TaskResult[]): AblationGroup[] {
  const on = byConfig(results, "full");
  const off = byConfig(results, "no_red_team");
  return [...on.entries()]
    .filter(([dataset]) => off.has(dataset))
    .map(([dataset, onResult]) => ({
      category: dataset,
      series: [
        { label: "red team on", value: onResult.primary_metric_value ?? 0 },
        { label: "red team off", value: off.get(dataset)?.primary_metric_value ?? 0 },
      ],
    }));
}

/** SPEC ablation "multi-agent vs single monolithic agent": mirrors render_monolith_table. */
export function monolithAblation(results: readonly TaskResult[]): AblationGroup[] {
  const hierarchical = byConfig(results, "full");
  const monolith = byConfig(results, "monolith");
  return [...hierarchical.entries()]
    .filter(([dataset]) => monolith.has(dataset))
    .map(([dataset, hierarchicalResult]) => ({
      category: dataset,
      series: [
        { label: "hierarchical", value: hierarchicalResult.primary_metric_value ?? 0 },
        { label: "monolith", value: monolith.get(dataset)?.primary_metric_value ?? 0 },
      ],
    }));
}

/** SPEC ablation "model-split vs uniform." render_model_split_table also projects a $/Mtok cost —
 * this deliberately does not (docs/design-plan.md §6's M9e plan: "no pricing math is reimplemented
 * client-side," since MODEL_PRICING and the role→model mapping are Python-side settings TaskResult
 * doesn't carry). What IS real and code-computed here is each role's CALL COUNT
 * (TaskResult.calls_by_agent), summed across every dataset both configs share — the split changes
 * WHICH model a role calls, not how many times it's called, so this is the honest signal to chart
 * without a fabricated price. */
export function modelSplitAblation(results: readonly TaskResult[]): AblationGroup[] {
  const split = byConfig(results, "full");
  const uniform = byConfig(results, "uniform_model");
  const datasets = [...split.keys()].filter((dataset) => uniform.has(dataset));
  const roles = ["principal", "red_team", "worker"] as const;
  return roles.map((role) => ({
    category: role,
    series: [
      {
        label: "model split",
        value: sum(datasets.map((dataset) => split.get(dataset)?.calls_by_agent[role] ?? 0)),
      },
      {
        label: "uniform model",
        value: sum(datasets.map((dataset) => uniform.get(dataset)?.calls_by_agent[role] ?? 0)),
      },
    ],
  }));
}

export interface MemoryComparison {
  dataset: string;
  firstFamilyRun1: string | null;
  firstFamilyRun2: string | null;
  differs: boolean;
}

/** SPEC ablation "memory on/off," rendered — like render_memory_table — as SPEC's own headline
 * demonstration (run #2 differing because of run #1's lessons), a categorical "did it differ", not
 * a magnitude. Charting it would imply a quantity that does not exist. */
export function memoryAblation(results: readonly TaskResult[]): MemoryComparison[] {
  const run1 = byConfig(results, "full");
  const run2 = byConfig(results, "memory_run_2");
  return [...run1.entries()]
    .filter(([dataset]) => run2.has(dataset))
    .map(([dataset, r1]) => {
      const r2 = run2.get(dataset);
      return {
        dataset,
        firstFamilyRun1: r1.first_model_family,
        firstFamilyRun2: r2?.first_model_family ?? null,
        differs: r1.first_model_family !== (r2?.first_model_family ?? null),
      };
    });
}
