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

export type Surface = (typeof SURFACES)[number];

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
 * are a boundary/fill for primary buttons and focus emphasis, never body text. M9h: the three brand
 * stops, the deep gradient's end and the meter gradients' hot ends are fills, borders and glows —
 * and large display numerals, whose floor is the same 3:1 — never body text (§3.1). */
export const GRAPHIC_TOKENS = [
  "status-idle",
  "line-control",
  "line-focus",
  "meter-safe",
  "meter-pressure",
  "meter-critical",
  "meter-pressure-end",
  "meter-critical-end",
  "accent",
  "accent-to",
  "accent-hover",
  "brand-1",
  "brand-2",
  "brand-3",
] as const;

/** Exempt because §3.1 itself labels them decorative: dividers and panel edges carry no
 * information a control boundary or label does not repeat, and the meter track is only the empty
 * part of a bar whose value is also always printed. `--meter-projected` is a translucent hatch.
 * `--accent-soft`, `--surface-glass` and `--surface-glass-border` (M9g) are translucent washes a
 * real text/graphic token always sits on top of — never load-bearing for contrast themselves.
 * `--spotlight-color` (M9h) is one too, but it DOES sit under text, so it is held to a different
 * test: see WASH_LAYERS. */
export const DECORATIVE_TOKENS = [
  "line-hairline",
  "line-strong",
  "meter-track",
  "meter-projected",
  "accent-soft",
  "surface-glass",
  "surface-glass-border",
  "spotlight-color",
] as const;

/** Checked by a bespoke assertion instead of the standard 5-surface loop: `--accent-contrast`
 * (§3.1, M9g) is only ever read as a label sitting on a filled `--accent` surface, never on one of
 * the five grounds directly — see tokens.contrast.test.ts's "primary button" block. */
export const BESPOKE_CONTRAST_TOKENS = ["accent-contrast"] as const;

export const TEXT_FLOOR = 4.5;
export const GRAPHIC_FLOOR = 3;

/** §12.3: the translucent layers that can sit UNDER text, and the grounds each can actually reach.
 * Every `rgb(… / a)` stop in these tokens is composited at its PEAK over every listed ground, and
 * text-primary/secondary/muted must still clear TEXT_FLOOR on the result. The aurora and blooms only
 * ever sit on the page ground and (through the 70% centre column) the deck; the spotlight sits on
 * panels and rows, i.e. any ground, which is why it carries the tightest alpha. */
export const WASH_LAYERS: Readonly<Record<string, readonly Surface[]>> = {
  aurora: ["surface-abyss", "surface-deck"],
  "bloom-brand": ["surface-abyss", "surface-deck"],
  "bloom-danger": ["surface-abyss", "surface-deck"],
  "spotlight-color": SURFACES,
};

/** The text tokens a wash must not erode. */
export const WASH_TEXT_TOKENS = ["text-primary", "text-secondary", "text-muted"] as const;

/** §8's screen-edge vignette is a full-viewport INSET SHADOW, so it is checked at its real peak (the
 * edge pixel, see insetShadowPeak in contrast.ts) rather than at its nominal alpha. It paints at z-20,
 * UNDER the top bar (z-30) and the dialogs and drawer (z-40/50), so the raised ground — where a
 * drawer's text sits — can never be under it; the grounds below are everything that can. */
export const INSET_SHADOW_WASHES: Readonly<Record<string, readonly Surface[]>> = {
  "shadow-vignette-danger": ["surface-abyss", "surface-deck", "surface-panel"],
};

/** A feed or roster row's wash is the `wash` utility (styles/base.css) at `--wash-row` — a per-theme
 * token, which the test reads rather than this file duplicating it, so the strength it checks can
 * never drift from the strength that ships. The tone is a team hue, or the status ramp for
 * interrupt / done / error rows. Rows sit on the page ground, the deck or a panel — never on the
 * inset wells (code, meter track), which is why that ground is out. */
export const TEAM_WASH_SURFACES: readonly Surface[] = [
  "surface-abyss",
  "surface-deck",
  "surface-panel",
  "surface-raised",
];
export const TEAM_TOKENS = [
  "team-principal",
  "team-data",
  "team-modeling",
  "team-runner",
  "team-redteam",
  "team-reporter",
] as const;
/** Every tone a row wash can take: the six teams plus the three status hues the feed falls back to. */
export const ROW_WASH_TOKENS = [...TEAM_TOKENS, "status-ok", "status-warn", "status-danger"] as const;

/** A chip (`Chip.tsx`) is `bg-<tone>/15`: its icon or dot is the tone colour (a graphic, 3:1) and its
 * LABEL is --text-primary, never the tone colour, because tone text on its own tint falls under 4.5:1
 * on the light theme. `brand-1` is a chip tone but not a text token, so it is listed here. */
export const CHIP_ALPHA = 0.15;
export const CHIP_TONE_TOKENS = [
  "status-ok",
  "status-warn",
  "status-danger",
  "status-info",
  "brand-1",
  ...TEAM_TOKENS,
] as const;
