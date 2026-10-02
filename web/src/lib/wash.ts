/** The row washes of docs/design-plan.md §3.1 and §12.5: the `wash` utility (styles/base.css) tints a
 * row in the hue its host names through `--wash-hue`, at the per-theme strength `--wash-row`. Each
 * entry spells its class out in full — Tailwind's scanner reads source text, so a class assembled
 * from a template string would never be generated.
 *
 * Six team hues plus the three status hues the activity feed falls back to (an interrupt, a `done`,
 * an `error`). Never used in the leaderboard or any table, and the leaderboard's own flagged row
 * takes `danger` only because it is the red team's finding made visible (§8). */
export const WASH = {
  principal: "wash [--wash-hue:var(--team-principal)]",
  data: "wash [--wash-hue:var(--team-data)]",
  modeling: "wash [--wash-hue:var(--team-modeling)]",
  runner: "wash [--wash-hue:var(--team-runner)]",
  redteam: "wash [--wash-hue:var(--team-redteam)]",
  reporter: "wash [--wash-hue:var(--team-reporter)]",
  ok: "wash [--wash-hue:var(--status-ok)]",
  warn: "wash [--wash-hue:var(--status-warn)]",
  danger: "wash [--wash-hue:var(--status-danger)]",
} as const;

export type WashTone = keyof typeof WASH;
