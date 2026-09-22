/** M9d's experiment drawer needs a link to the MLflow run (design-plan.md §6's drawer header).
 * MLflow's tracking URL is a local dev service (foundry/config.py's `mlflow_tracking_uri`,
 * default http://localhost:5000) — not a secret, so it is a Vite build-time env var rather than a
 * new RunStatus field: a link to `docker-compose`'s own mlflow container does not justify widening
 * the API surface. */
const DEFAULT_MLFLOW_URL = "http://localhost:5000";

export function mlflowRunUrl(runId: string): string {
  const base = (import.meta.env.VITE_MLFLOW_URL ?? DEFAULT_MLFLOW_URL).replace(/\/+$/, "");
  return `${base}/#/experiments/0/runs/${runId}`;
}
