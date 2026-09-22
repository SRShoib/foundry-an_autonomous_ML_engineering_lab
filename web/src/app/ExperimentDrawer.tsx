import { useState } from "react";

import type { AttemptRecord, ExperimentResult } from "../api/types";
import { Dialog, DialogTitle } from "../components/ui/Dialog";
import { Tabs, panelId, tabId, type Tab } from "../components/ui/Tabs";
import { cn } from "../lib/cn";
import { formatUsdPrecise } from "../lib/format";
import { mlflowRunUrl } from "../lib/mlflow";

type DrawerTab = "spec" | "code" | "output" | "attempts";

const TABS: readonly Tab<DrawerTab>[] = [
  { id: "spec", label: "spec" },
  { id: "code", label: "code" },
  { id: "output", label: "output" },
  { id: "attempts", label: "attempts" },
];

const OUTCOME_LABEL: Record<AttemptRecord["outcome"], string> = {
  success: "succeeded",
  failed_execution: "failed execution",
  failed_metrics: "failed — no valid metrics",
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="num overflow-x-auto whitespace-pre-wrap break-words rounded-panel border border-line-hairline bg-surface-inset p-3 text-xs text-fg">
      {children || "(empty)"}
    </pre>
  );
}

function Missing({ children }: { children: string }) {
  return <p className="text-sm text-fg-secondary">{children}</p>;
}

interface ExperimentDrawerProps {
  experiment: ExperimentResult;
  /** Known only when this experiment is (or was) a ranked LeaderboardEntry — an invalidated or
   * failed experiment has no "primary" metric of its own, only whatever it happened to print. */
  primaryMetricName?: string;
  onClose: () => void;
}

/** design-plan.md §6's experiment detail drawer: a 560px right sheet with four tabs. Unlike
 * GateDialog, this IS dismissible — Escape and an outside click close it (§7). Give this
 * component a fresh `key={experiment.experiment_id}` at the call site so its own tab selection
 * resets when a different experiment opens, rather than tracking that here. */
export function ExperimentDrawer({ experiment, primaryMetricName, onClose }: ExperimentDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>("spec");
  const primaryMetricValue =
    primaryMetricName === undefined ? undefined : experiment.metrics[primaryMetricName];
  // Same stale-replay guard as GateDialog.tsx: the type promises these are always present, but a
  // committed replay recorded before M9d added them is a static JSONL that predates the promise.
  const spec = experiment.spec ?? null;
  const attemptHistory = experiment.attempt_history ?? [];

  return (
    <Dialog
      open
      variant="sheet"
      dismissible
      onOpenChange={(next) => { if (!next) onClose(); }}
      // §7: "Drawer: 280ms translateX, --ease-out; scrim 200ms" — Dialog's own default transition
      // is the gate's scale+fade (§7's entry moment), which the drawer does not share.
      panelTransition={{
        initial: { opacity: 0, x: 32 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: 32 },
        transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] },
      }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line-hairline p-4">
        <div>
          <DialogTitle asChild>
            <h2 className="num text-md font-medium text-fg">{experiment.experiment_id}</h2>
          </DialogTitle>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary">
            {primaryMetricValue !== undefined && (
              <span className="num">
                {primaryMetricName} {primaryMetricValue.toFixed(4)}
              </span>
            )}
            <span className="num">{experiment.duration_s.toFixed(1)}s</span>
            <span className="num">{formatUsdPrecise(experiment.cost_usd)}</span>
            <span className="num">{experiment.attempts} attempt{experiment.attempts === 1 ? "" : "s"}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-control border border-line-control px-2 text-xs text-fg-secondary transition-colors duration-(--dur-quick) ease-out hover:bg-surface-raised hover:text-fg frame:min-h-8"
        >
          Close
        </button>
      </div>

      {experiment.mlflow_run_id !== null && (
        <a
          href={mlflowRunUrl(experiment.mlflow_run_id)}
          target="_blank"
          rel="noreferrer"
          className="border-b border-line-hairline px-4 py-2 text-xs text-status-info transition-colors duration-(--dur-quick) ease-out hover:text-fg"
        >
          Open in MLflow
        </a>
      )}

      <Tabs
        tabs={TABS}
        active={tab}
        onChange={setTab}
        label="Experiment detail"
        className="flex border-b border-line-hairline"
        tabClassName={(selected) =>
          cn(
            "min-h-11 flex-1 px-3 text-sm transition-colors duration-(--dur-quick) ease-out frame:min-h-8",
            selected ? "font-medium text-fg" : "text-fg-secondary hover:text-fg",
          )
        }
        indicator
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "spec" && (
          <div role="tabpanel" id={panelId("spec")} aria-labelledby={tabId("spec")} className="flex flex-col gap-4">
            {spec === null ? (
              <Missing>No spec recorded for this experiment (a checkpoint from before M9d).</Missing>
            ) : (
              <>
                <div>
                  <p className="text-xs text-fg-muted">model family</p>
                  <p className="text-sm text-fg">{spec.model_family}</p>
                </div>
                <div>
                  <p className="text-xs text-fg-muted">hyperparameters</p>
                  <ul className="flex flex-col gap-0.5">
                    {Object.entries(spec.hyperparams).map(([key, value]) => (
                      <li key={key} className="flex justify-between gap-3 text-sm">
                        <span className="text-fg-secondary">{key}</span>
                        <span className="num text-fg">{String(value)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs text-fg-muted">rationale</p>
                  <p className="text-sm text-fg-secondary">{spec.rationale}</p>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-fg-muted">estimated vs actual cost</span>
                  <span className="num text-fg">
                    {formatUsdPrecise(spec.est_cost_usd)} → {formatUsdPrecise(experiment.cost_usd)}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {tab === "code" && (
          <div role="tabpanel" id={panelId("code")} aria-labelledby={tabId("code")}>
            <CodeBlock>{experiment.code}</CodeBlock>
          </div>
        )}

        {tab === "output" && (
          <div role="tabpanel" id={panelId("output")} aria-labelledby={tabId("output")} className="flex flex-col gap-4">
            <div>
              <p className="mb-1 text-xs text-fg-muted">stdout</p>
              <CodeBlock>{experiment.stdout}</CodeBlock>
            </div>
            <div>
              <p className="mb-1 text-xs text-fg-muted">stderr</p>
              <CodeBlock>{experiment.stderr}</CodeBlock>
            </div>
          </div>
        )}

        {tab === "attempts" && (
          <div role="tabpanel" id={panelId("attempts")} aria-labelledby={tabId("attempts")} className="flex flex-col gap-4">
            {attemptHistory.length === 0 ? (
              <Missing>No per-attempt history recorded for this experiment (a checkpoint from before M9d).</Missing>
            ) : (
              attemptHistory.map((attempt) => (
                <div key={attempt.attempt} className="flex flex-col gap-2 border-b border-line-hairline pb-4 last:border-b-0">
                  <p className="text-sm text-fg">
                    <span className="num">attempt {attempt.attempt + 1}</span> — {OUTCOME_LABEL[attempt.outcome]}
                  </p>
                  {attempt.error !== null && <p className="text-xs text-status-danger">{attempt.error}</p>}
                  <CodeBlock>{attempt.code}</CodeBlock>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
