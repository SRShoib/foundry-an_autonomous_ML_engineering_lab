/** How docs/design-plan.md §3 classifies each foreground token, which decides the contrast floor
 * tokens.contrast.test.ts holds it to. A new token must be placed in exactly one group (the test
 * fails on an unclassified colour), so accessibility cannot be skipped by forgetting to register it.
 */

/** The five grounds every foreground token must clear (§3.1's "worst case across all five"). */
export const SURFACES = [
  "surface-abyss",
  "surface-deck",
  "surface-panel",
  "surface-raised",
  "surface-inset",
] as const;

/** Read as text — WCAG 1.4.3, 4.5:1. */
export const TEXT_TOKENS = [
  "text-primary",
  "text-secondary",
  "text-muted",
  "team-principal",
  "team-data",
  "team-modeling",
  "team-runner",
  "team-redteam",
  "team-reporter",
  "status-ok",
  "status-warn",
  "status-danger",
  "status-info",
] as const;

/** Boundaries and marks, not text — WCAG 1.4.11, 3:1. `--status-idle` is graphic-only by design:
 * it is always paired with a --text-muted label (§3.1). `--accent`/`--accent-hover` (§3.1, M9g)
 * are a boundary/fill for primary buttons and focus emphasis, never body text. */
export const GRAPHIC_TOKENS = [
  "status-idle",
  "line-control",
  "line-focus",
  "meter-safe",
  "meter-pressure",
  "meter-critical",
  "accent",
  "accent-hover",
] as const;

/** Exempt because §3.1 itself labels them decorative: dividers and panel edges carry no
 * information a control boundary or label does not repeat, and the meter track is only the empty
 * part of a bar whose value is also always printed. `--meter-projected` is a translucent hatch.
 * `--accent-soft`, `--surface-glass` and `--surface-glass-border` (M9g) are translucent washes a
 * real text/graphic token always sits on top of — never load-bearing for contrast themselves. */
export const DECORATIVE_TOKENS = [
  "line-hairline",
  "line-strong",
  "meter-track",
  "meter-projected",
  "accent-soft",
  "surface-glass",
  "surface-glass-border",
] as const;

/** Checked by a bespoke assertion instead of the standard 5-surface loop: `--accent-contrast`
 * (§3.1, M9g) is only ever read as a label sitting on a filled `--accent` surface, never on one of
 * the five grounds directly — see tokens.contrast.test.ts's "M9g's accent" block. */
export const BESPOKE_CONTRAST_TOKENS = ["accent-contrast"] as const;

export const TEXT_FLOOR = 4.5;
export const GRAPHIC_FLOOR = 3;
