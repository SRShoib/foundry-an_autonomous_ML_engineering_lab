import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "motion/react";

import type { PendingApproval } from "../api/types";
import { Button } from "../components/ui/Button";
import { Dialog, DialogTitle } from "../components/ui/Dialog";
import { cn } from "../lib/cn";
import { formatUsd, formatUsdPrecise, formatMetric } from "../lib/format";
import { METER_FILL, meterTone, spendFraction } from "../lib/meter";

/** Motion's shared-element id for §7's gate-confirm "fly": only ever claimed by ONE mounted
 * element at a time — this dialog's hero figure while a budget gate is open, BudgetMeter's own
 * spent readout the rest of the time (BudgetMeter.tsx's `heroLayoutId` prop). When the dialog
 * unmounts on confirm and BudgetMeter picks the id back up in the same commit, Motion performs
 * the shared-layout transition between them automatically — no manual rect measuring needed. */
export const GATE_HERO_LAYOUT_ID = "gate-hero-value";

const ARM_MS = 400; // --dur-arm

function MiniMeter({ label, fraction, tone }: { label: string; fraction: number; tone: keyof typeof METER_FILL }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs text-fg-muted">
        <span>{label}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-control bg-meter-track">
        <div className={cn("h-full", METER_FILL[tone])} style={{ width: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}

interface GateDialogProps {
  gate: PendingApproval;
  onDecide: (decision: { approved: boolean; note: string }) => void;
}

/** design-plan.md §6's approval gates and §7's gate entry/confirm motion. Not dismissible
 * (`Dialog`'s `dismissible={false}`): "a gate is answered, not dismissed". */
export function GateDialog({ gate, onDecide }: GateDialogProps) {
  const [note, setNote] = useState("");
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [armed, setArmed] = useState(false);
  const reducedMotion = useReducedMotion();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Re-arms on every mount — GateDialog is only ever rendered while a gate is pending (RunView
  // conditionally renders it), so a fresh gate always means a fresh mount.
  useEffect(() => {
    if (reducedMotion) {
      setArmed(true);
      return;
    }
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(timer);
  }, [reducedMotion]);

  const noteInvalid = rejectAttempted && note.trim() === "";

  function approve(): void {
    if (!armed) return;
    onDecide({ approved: true, note });
  }

  function reject(): void {
    if (note.trim() === "") {
      setRejectAttempted(true);
      return;
    }
    onDecide({ approved: false, note });
  }

  // §6: "Enter does not submit; you must Tab to it" — a focused native <button> activates on
  // Enter by default, so this swallows it. Space and a real click still work.
  function swallowEnter(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "Enter") event.preventDefault();
  }

  const spentFraction = spendFraction(gate.spent_usd, gate.budget_usd);
  const projectedFraction = spendFraction(gate.spent_usd + gate.projected_usd, gate.budget_usd);
  // The type says this is always present — WIRE_CONFIG marks it required in the OpenAPI schema
  // the LIVE API promises. A committed replay recorded before M9d added the field is a static
  // JSONL that cannot retroactively honour that promise, so this guards the one real skew: an old
  // recording still sitting in web/public/replays/ against a newer frontend build.
  const pendingSpecs = gate.pending_specs ?? [];

  return (
    <Dialog
      open
      dismissible={false}
      variant="centered"
      onOpenChange={() => undefined}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        headingRef.current?.focus();
      }}
    >
      <div className="flex flex-col gap-6 p-6">
        <DialogTitle asChild>
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-medium text-fg">
            {gate.gate} gate
          </h2>
        </DialogTitle>

        {gate.gate === "budget" ? (
          <div className="flex flex-col gap-5">
            <div>
              <p className="text-xs text-fg-muted">projected spend</p>
              <motion.p
                layoutId={GATE_HERO_LAYOUT_ID}
                transition={{ duration: 0.42, ease: [0.34, 0.8, 0.28, 1] }}
                className="num text-2xl text-fg"
              >
                {formatUsd(gate.spent_usd + gate.projected_usd)}
              </motion.p>
              <p className="text-sm text-fg-secondary">
                against a {formatUsd(gate.budget_usd)} cap, with {formatUsd(gate.spent_usd)} already spent
              </p>
            </div>

            <div className="flex flex-col gap-3 rounded-panel border border-line-strong bg-surface-inset p-4">
              <MiniMeter label="spent" fraction={spentFraction} tone={meterTone(spentFraction)} />
              <MiniMeter label="projected" fraction={projectedFraction} tone={meterTone(projectedFraction)} />
            </div>

            {pendingSpecs.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-fg-muted">pending</p>
                <ul className="flex flex-col gap-1">
                  {pendingSpecs.map((spec) => (
                    <li key={spec.experiment_id} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="num text-fg">{spec.experiment_id}</span>
                      <span className="flex-1 truncate text-fg-secondary">{spec.model_family}</span>
                      <span className="num text-fg">{formatUsdPrecise(spec.projected_cost_usd)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {gate.best_experiment_id === null ? (
              <p className="text-sm text-fg-secondary">No experiment cleared the audit.</p>
            ) : (
              <div>
                <p className="text-xs text-fg-muted">winning experiment</p>
                <p className="num text-2xl text-fg">{gate.best_experiment_id}</p>
                <p className="text-sm text-fg-secondary">
                  {gate.best_metric_name} {gate.best_metric_value === null ? "" : formatMetric(gate.best_metric_value)}
                </p>
              </div>
            )}
            <p className="flex items-baseline justify-between text-sm">
              <span className="text-fg-muted">invalidated</span>
              <span className="num text-fg">{gate.n_invalidated}</span>
            </p>
          </div>
        )}

        <p className="max-w-prose text-sm text-fg-secondary">{gate.reason}</p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="gate-note" className="text-xs text-fg-muted">
            note
          </label>
          <input
            id="gate-note"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="min-h-11 rounded-control border border-line-control bg-surface-panel px-3 text-sm text-fg frame:min-h-8"
          />
          {noteInvalid && <p className="text-xs text-status-danger">A rejection needs a note.</p>}
        </div>

        <div className="flex justify-end gap-3">
          <Button onClick={reject}>Reject</Button>
          {/* §7 M9g: the fill still arms in --dur-arm before the control is pressable, but now
              builds toward the accent-filled primary treatment (Button's `primary` variant) rather
              than a neutral surface tint — the button visibly becomes the one primary action on
              screen exactly as it becomes pressable, not before. */}
          <button
            type="button"
            disabled={!armed}
            onClick={approve}
            onKeyDown={swallowEnter}
            className={cn(
              "relative min-h-11 overflow-hidden rounded-control border px-3 text-sm font-medium frame:min-h-8 transition-colors duration-(--dur-quick) ease-out disabled:cursor-not-allowed",
              armed ? "border-transparent bg-accent text-accent-contrast shadow-raised hover:bg-accent-hover" : "border-line-control text-fg",
            )}
          >
            <motion.span
              aria-hidden="true"
              className="absolute inset-0 origin-left bg-accent-soft"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: reducedMotion ? 0 : ARM_MS / 1000, ease: "linear" }}
            />
            <span className="relative">Approve</span>
          </button>
        </div>
      </div>
    </Dialog>
  );
}
