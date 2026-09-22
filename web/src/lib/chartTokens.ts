import type { CSSProperties } from "react";

/** Recharts consumes plain style objects and strings, not Tailwind classes — every colour handed
 * to it is a `var(--token)` reference, checked by the same no-raw-colour rule
 * (styles/designRules.ts) as everywhere else in web/src. Centralised here because
 * eval/AblationChart.tsx and report/LeaderboardChart.tsx were each declaring the same literal
 * strings independently before M9g. */

export const CHART_GRID = "var(--line-hairline)";

export const CHART_TICK = { fill: "var(--text-muted)" } as const;

/** §7 M9g: neither chart had a hover layer before — Recharts ships a default tooltip only when
 * `<Tooltip>` is rendered at all, which neither file did. Styled from tokens, matching a docked
 * panel's own surface/border/type rather than Recharts' unstyled default. */
export const CHART_TOOLTIP_STYLE: CSSProperties = {
  background: "var(--surface-raised)",
  border: "1px solid var(--line-strong)",
  borderRadius: 4, // matches --radius-control
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  padding: "6px 10px",
};

export const CHART_TOOLTIP_LABEL_STYLE: CSSProperties = {
  color: "var(--text-muted)",
  marginBottom: 4,
};

export const CHART_TOOLTIP_ITEM_STYLE: CSSProperties = {
  color: "var(--text-primary)",
};

/** The bar-hover highlight band, themed instead of Recharts' default translucent grey. */
export const CHART_CURSOR = { fill: "var(--surface-inset)" } as const;

/** Reuses the status ramp rather than minting a dedicated categorical pair — both ablation series
 * are literally "the real pipeline" vs "one piece ablated away", which the existing info/idle
 * reading (enhanced vs. baseline) already carries reasonably, and the design system otherwise
 * holds its hue count deliberately small (§3.1's self-critique: "six hues could read as a
 * rainbow"). A genuinely independent multi-series chart would earn its own validated categorical
 * pair instead. */
export const CHART_SERIES = ["var(--status-info)", "var(--status-idle)"] as const;

/** Entry animation, explicitly set rather than left at Recharts' own default: --dur-settle (300ms)
 * is already named for "content settling into place" (tokens.css) rather than a new duration. */
export const CHART_ANIMATION_DURATION_MS = 300;
export const CHART_ANIMATION_EASING = "ease-out";
