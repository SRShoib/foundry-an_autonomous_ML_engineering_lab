import type {
  ActivityEvent,
  AuditEvidence,
  DatasetOption,
  ExperimentResult,
  PendingApproval,
  RedTeamFinding,
  Replay,
  ReplayFrame,
  RunStatus,
  TaskResult,
} from "../api/types";

/** Small factories for tests. Every one is typed from the generated schema, so a field added to the
 * API forces these to be updated rather than silently going stale. */

export function makeRunStatus(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    thread_id: "t-1",
    status: "running",
    stop_reason: null,
    spent_usd: 0,
    budget_usd: 20,
    leaderboard: [],
    pending_approval: null,
    report_md: null,
    error: null,
    experiments: [],
    invalidations: [],
    model_card_md: null,
    data_profile: null,
    cost_by_agent: {},
    goal: "predict churn",
    dataset_ref: "churn",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeEvent(seq: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    thread_id: "t-1",
    seq,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    kind: "node",
    node: "principal",
    summary: `event ${seq}`,
    spent_usd: null,
    ...overrides,
  };
}

export function makeExperiment(id: string, overrides: Partial<ExperimentResult> = {}): ExperimentResult {
  return {
    experiment_id: id,
    mlflow_run_id: `mlflow-${id}`,
    status: "success",
    metrics: { roc_auc: 0.9 },
    cost_usd: 0.1,
    duration_s: 1,
    attempts: 1,
    error: null,
    code: `# ${id}`,
    stdout: "out",
    stderr: "",
    spec: null,
    attempt_history: [],
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<AuditEvidence> = {}): AuditEvidence {
  return {
    worst_column: "signup_bonus",
    worst_column_target_auc: 0.97,
    duplicate_row_rate: 0.01,
    reported_metric_name: "roc_auc",
    reported_metric_value: 0.995,
    ...overrides,
  };
}

export function makeFinding(
  experimentId: string,
  verdict: RedTeamFinding["verdict"] = "invalidated",
  overrides: Partial<RedTeamFinding> = {},
): RedTeamFinding {
  return {
    experiment_id: experimentId,
    category: "leakage",
    verdict,
    explanation: "e",
    recommendation: "r",
    evidence: verdict === "invalidated" ? makeEvidence() : null,
    ...overrides,
  };
}

export function makeTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    dataset_ref: "churn",
    config: "full",
    approach: "hierarchical",
    thread_id: "eval-churn-full",
    stop_reason: "diminishing_returns",
    primary_metric_name: "roc_auc",
    primary_metric_value: 0.85,
    target_value: 0.9,
    target_met: false,
    n_experiments: 3,
    n_successful: 3,
    n_invalidated: 0,
    cost_total_usd: 0.18,
    cost_by_agent: {},
    calls_by_agent: {},
    wall_time_s: 287,
    winning_model_family: "logistic_regression",
    first_model_family: "logistic_regression",
    error: null,
    ...overrides,
  };
}

export function makeDatasetOption(overrides: Partial<DatasetOption> = {}): DatasetOption {
  return {
    key: "churn",
    name: "churn",
    task_type: "binary_classification",
    primary_metric: "roc_auc",
    description: "Synthetic telecom churn dataset.",
    ...overrides,
  };
}

export function makeGate(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    thread_id: "t-1",
    gate: "budget",
    reason: "projected over cap",
    spent_usd: 0.2,
    budget_usd: 1,
    projected_usd: 0.9,
    best_experiment_id: null,
    best_metric_name: null,
    best_metric_value: null,
    n_invalidated: 0,
    pending_specs: [],
    ...overrides,
  };
}

export interface FrameSpec {
  t: number;
  node?: string | null;
  kind?: ActivityEvent["kind"];
  status?: Partial<RunStatus>;
  gate?: PendingApproval["gate"];
}

/** Builds a Replay from terse frame specs. `gate` marks a frame as part of a paused gate; the
 * decisions the recording operator "made" are given separately, in gate order. */
export function makeReplay(
  specs: readonly FrameSpec[],
  decisions: readonly { gate: PendingApproval["gate"]; approved: boolean }[] = [],
): Replay {
  const frames: ReplayFrame[] = specs.map((spec, seq) => ({
    t_offset_s: spec.t,
    event: makeEvent(seq, { node: spec.node ?? "principal", kind: spec.kind ?? "node" }),
    status: makeRunStatus({
      ...(spec.gate ? { status: "awaiting_approval", pending_approval: makeGate({ gate: spec.gate }) } : {}),
      ...spec.status,
    }),
  }));
  const duration = frames.at(-1)?.t_offset_s ?? 0;
  return {
    header: {
      version: 1,
      name: "test",
      thread_id: "t-1",
      task: "churn",
      goal: "g",
      budget_usd: 1,
      recorded_at: "2026-01-01T00:00:00Z",
      duration_s: duration,
      gate_wait_s: 0,
      n_frames: frames.length,
      decisions: decisions.map((d, i) => ({ ...d, note: "", t_offset_s: 0, wait_s: i })),
      final_status: null,
    },
    frames,
  };
}
