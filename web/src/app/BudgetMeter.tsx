import { Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

import type { RunStatus } from "../api/types";
import { Panel } from "../components/ui/Panel";
import { Skeleton } from "../components/states/Skeleton";
import { cn } from "../lib/cn";
import { formatUsd } from "../lib/format";
import {
  METER_CRITICAL_AT,
  METER_FILL,
  METER_GLOW,
  METER_GRADIENT,
  METER_PRESSURE_AT,
  meterTone,
  spendFraction,
} from "../lib/meter";
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

/** True for `holdMs` after `value` last CHANGED — never on mount, so a meter that loads already
 * holding a number does not shimmer. It is what turns the budget fill's travelling highlight on
 * while spend is actually moving (§7, M9h) and off once it settles. */
function useRecentChange(value: number, holdMs = 2400): boolean {
  const [recent, setRecent] = useState(false);
  const previous = useRef(value);
  useEffect(() => {
    if (value === previous.current) return;
    previous.current = value;
    setRecent(true);
    const timer = setTimeout(() => setRecent(false), holdMs);
    return () => clearTimeout(timer);
  }, [value, holdMs]);
  return recent;
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

/** A decorative ruler under the bar: eleven ticks, taller at 0, 50 and 100. Pure instrument
 * dressing — the value is carried by the numeric readout and the progressbar, never by this. */
function Ruler() {
  return (
    <div aria-hidden="true" className="flex items-end justify-between px-px">
      {Array.from({ length: 11 }, (_, i) => (
        <span key={i} className={cn("w-px bg-line-strong", i % 5 === 0 ? "h-1.5" : "h-1")} />
      ))}
    </div>
  );
}

/** The dock's budget panel (§5 / §7). The bar is never the only carrier of its value — a numeric
 * readout always sits beside it (§3.1) — and the readout counts up rather than jumping (§7's
 * "Metric values" moment, via useAnimatedNumber).
 *
 * M9h: the readout is a gradient hero numeral, the fill is a per-tone gradient with a travelling
 * highlight while spend is changing and a tone-tinted glow once spend is under pressure, and a
 * ruler sits under the bar. The progressbar semantics, permanent threshold ticks and projected-spend
 * hatch are unchanged.
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
  const changing = useRecentChange(spent);

  if (status === null) {
    return (
      <Panel title="budget" icon={Wallet}>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-3 w-full" />
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="budget" icon={Wallet} meta={<span className="num">{formatUsd(cap)}</span>}>
      <div className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          {/* `w-fit`: a gradient maps across the element's BOX, so a block-level <p> would stretch it
              across the whole panel and the glyphs would only ever see the first stop. */}
          <motion.p
            {...(heroLayoutId ? { layoutId: heroLayoutId } : {})}
            className="num gradient-text w-fit text-2xl font-medium tracking-tight"
          >
            {formatUsd(animatedSpent)}
          </motion.p>
          <span aria-hidden="true" className="num pb-1 text-xs text-fg-muted">
            {Math.round(fraction * 100)}%
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={cap}
            aria-valuenow={spent}
            aria-valuetext={`${formatUsd(spent)} of ${formatUsd(cap)}`}
            // §7 (revised M9h): the track glows in its tone once spend is under pressure — a state
            // worth noticing, so it is allowed to glow (§3.3); calm spend stays flat.
            className={cn(
              "relative h-3 overflow-hidden rounded-pill bg-meter-track transition-shadow duration-(--dur-settle) ease-out",
              METER_GLOW[tone],
            )}
          >
            <motion.div
              className={cn(
                "absolute inset-y-0 left-0 overflow-hidden rounded-pill transition-colors duration-(--dur-settle) ease-out",
                METER_FILL[tone],
                METER_GRADIENT[tone],
                changing && "meter-sheen",
              )}
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
          <Ruler />
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
