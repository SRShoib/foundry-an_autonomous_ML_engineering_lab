import { cn } from "../lib/cn";
import { METER_FILL, meterTone, spendFraction } from "../lib/meter";

/** The runs-home table's 40px spend-vs-cap meter (docs/design-plan.md §6). Unanimated, unlike
 * BudgetMeter.tsx's docked instrument — a list of many rows redrawing every 4s (api/queries.ts's
 * RUNS_LIST_REFETCH_MS) is not the one meter a moment is spent animating (§7), and this shares
 * spendFraction / meterTone / METER_FILL with it so the two can never disagree about a threshold. */
export function InlineMeter({ spent, cap }: { spent: number; cap: number }) {
  const fraction = spendFraction(spent, cap);
  const tone = meterTone(fraction);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={spent}
      className="h-1.5 w-10 overflow-hidden rounded-control bg-meter-track"
    >
      <div className={cn("h-full", METER_FILL[tone])} style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}
