/** Formatting for the measured values the console shows. Numbers are always rendered in
 * Plex Mono with tabular figures (the `num` utility); these only decide their text. */

export function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

/** Costs in a feed row are small enough that two decimals would hide them. */
export function formatUsdPrecise(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatMetric(value: number): string {
  return value.toFixed(4);
}

/** `5c255737-39db-...` becomes `5c25…37`: enough to tell runs apart, short enough for a top bar. */
export function shortId(threadId: string): string {
  return threadId.length <= 8 ? threadId : `${threadId.slice(0, 4)}…${threadId.slice(-2)}`;
}

/** 83.4 becomes `1:23`. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** M9e: the runs-home table's `updated` column (docs/design-plan.md §6) — RunStatus.updated_at as
 * relative age, `4m` / `2h` / `3d`. `now` is a parameter, not `Date.now()` read internally, so the
 * table's periodic refetch (api/queries.ts's RUNS_LIST_REFETCH_MS) is what advances the displayed
 * age, not a second independent clock — and so this stays a pure function to test. A clock-skewed
 * or missing timestamp reads as `just now` / `—` rather than a negative age. */
export function formatAge(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return "—";
  const diffMs = now - new Date(iso).getTime();
  const minutes = Math.floor(Math.max(0, diffMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** An ActivityEvent's `ts` (ISO 8601, always UTC) as a feed row's local wall-clock time, `14:02:11`
 * in whatever timezone the browser is in. `hourCycle: "h23"` keeps midnight `00`, not `24`; the
 * test builds its expected string from the same Date's local getters, so it passes in any timezone
 * rather than assuming the machine running it is UTC. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}
