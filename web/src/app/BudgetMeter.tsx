import { useEffect, useState } from "react";
import { motion } from "motion/react";

import type { RunStatus } from "../api/types";
import { Panel } from "../components/ui/Panel";
import { Skeleton } from "../components/states/Skeleton";
import { cn } from "../lib/cn";
import { formatUsd } from "../lib/format";
import { METER_CRITICAL_AT, METER_FILL, METER_PRESSURE_AT, meterTone, spendFraction } from "../lib/meter";
import { useAnimatedNumber } from "../lib/useAnimatedNumber";

/** docs/design-plan.md §7: "Crossing 70% or 90% ... leaves a permanent 2px threshold tick." Once
 * spend crosses a threshold the tick stays even if spend is later re-estimated downward — it marks
 * history, not the current fraction. Lazy initial state so a meter that MOUNTS already past a
 * threshold (a page reload mid-run) shows its tick immediately, not only after the next update. */
export function useThresholdTicks(fraction: number): { pressure: boolean; critical: boolean } {
  const [pressure, setPressure] = useState(() => fraction >= METER_PRESSURE_AT);
  const [critical, setCritical] = useState(() => fraction > METER_CRITICAL_AT);
  useEffect(() => {
    if (fraction >= METER_PRESSURE_AT) setPressure(true);
    if (fraction > METER_CRITICAL_AT) setCritical(true);
  }, [fraction]);
  return { pressure, critical };
}

function Tick({ at }: { at: number }) {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-y-0 w-0.5 bg-line-strong"
      style={{ left: `${at * 100}%` }}
    />
  );
}

/** The dock's budget panel (§5 / §7). The bar is never the only carrier of its value — a numeric
 * readout always sits beside it (§3.1) — and the readout counts up rather than jumping (§7's
 * "Metric values" moment, via useAnimatedNumber).
 *
 * `heroLayoutId`, when given, lets this readout CLAIM GateDialog.tsx's shared layoutId
 * (GATE_HERO_LAYOUT_ID) once the budget gate dialog is no longer holding it — the two never carry
 * the same id while both are mounted (RunView only passes it once `gate` is not a budget gate),
 * so Motion's shared-layout system sees a clean unmount-then-remount handoff and flies the value
 * from the dialog's position into this one (§7's gate-confirm "fly"), rather than two elements
 * disputing one id. */
export function BudgetMeter({ status, heroLayoutId }: { status: RunStatus | null; heroLayoutId?: string }) {
  // Hooks run unconditionally, before the null check below: this component's `status` prop starts
  // null and later receives a value on the SAME mounted instance (the query resolving, or the first
  // SSE frame arriving), and the Rules of Hooks forbid a hook that only starts being called once
  // that happens.
  const spent = status?.spent_usd ?? 0;
  const cap = status?.budget_usd ?? 0;
  const rawProjected = status?.pending_approval?.projected_usd;
  const fraction = spendFraction(spent, cap);
  const rawProjectedFraction = rawProjected === undefined ? null : spendFraction(rawProjected, cap);
  // A PendingApproval always carries `projected_usd` (the final gate's own is a sign-off, not a
  // spend estimate, and comes through as 0 or unset — verified against the demo recording). Only
  // treat it as a real projection, hatch and all, when it is actually ahead of current spend.
  const hasProjection = rawProjectedFraction !== null && rawProjectedFraction > fraction;
  const projected = hasProjection ? rawProjected : undefined;
  const projectedFraction = hasProjection ? rawProjectedFraction : null;
  const tone = meterTone(fraction);
  const ticks = useThresholdTicks(fraction);
  const animatedSpent = useAnimatedNumber(spent);

  if (status === null) {
    return (
      <Panel title="budget">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-3 w-full" />
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="budget" meta={<span className="num">{formatUsd(cap)}</span>}>
      <div className="flex flex-col gap-3">
        <motion.p {...(heroLayoutId ? { layoutId: heroLayoutId } : {})} className="num text-xl text-fg">
          {formatUsd(animatedSpent)}
        </motion.p>

        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={spent}
          aria-valuetext={`${formatUsd(spent)} of ${formatUsd(cap)}`}
          className="relative h-3 overflow-hidden rounded-control bg-meter-track"
        >
          <motion.div
            className={cn("absolute inset-y-0 left-0 transition-colors duration-(--dur-settle) ease-out", METER_FILL[tone])}
            initial={false}
            animate={{ width: `${fraction * 100}%` }}
            transition={{ duration: 0.5, ease: [0.34, 0.8, 0.28, 1] }}
          />
          {projectedFraction !== null && (
            <div
              aria-hidden="true"
              className="meter-hatch absolute inset-y-0"
              style={{ left: `${fraction * 100}%`, width: `${(projectedFraction - fraction) * 100}%` }}
            />
          )}
          {ticks.pressure && <Tick at={METER_PRESSURE_AT} />}
          {ticks.critical && <Tick at={METER_CRITICAL_AT} />}
        </div>

        {projected === undefined ? null : (
          <p className="flex items-baseline justify-between text-xs text-fg-muted">
            <span>projected</span>
            <span className="num text-fg-secondary">{formatUsd(projected)}</span>
          </p>
        )}
      </div>
    </Panel>
  );
}
