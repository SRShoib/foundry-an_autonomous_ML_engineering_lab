/** docs/design-plan.md §3.1's budget meter ramp: safe under 70% of the cap, pressure from 70 to
 * 90%, critical over 90%. One definition, so the mobile instrument bar's 2px line and the docked
 * meter of M9c cannot disagree about when spend turned amber. */
export type MeterTone = "safe" | "pressure" | "critical";

export const METER_PRESSURE_AT = 0.7;
export const METER_CRITICAL_AT = 0.9;

export function spendFraction(spent: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(1, Math.max(0, spent / cap));
}

export function meterTone(fraction: number): MeterTone {
  if (fraction > METER_CRITICAL_AT) return "critical";
  if (fraction >= METER_PRESSURE_AT) return "pressure";
  return "safe";
}

/** The Tailwind fill class for a tone. Spelled out, not built from a template string, so
 * Tailwind's class scanner can see every one of them. */
export const METER_FILL: Record<MeterTone, string> = {
  safe: "bg-meter-safe",
  pressure: "bg-meter-pressure",
  critical: "bg-meter-critical",
};
